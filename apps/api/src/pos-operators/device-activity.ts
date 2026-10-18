/**
 * RT-370 (RT-138 L7) — the device activity signal: `devices.last_seen_at`,
 * the last authenticated request of a device, written at most once per
 * {@link DEVICE_ACTIVITY_INTERVAL_MS} per device.
 *
 * Best effort, never in the request's way: the request is already
 * authenticated when this runs. The write is chained on a resolved promise,
 * so it starts after `record()` returns and its outcome is never awaited by
 * the caller; any error is logged (device id and error code only) and
 * dropped. A failed write only leaves `lastSeenAt` older; it never grants or
 * refuses anything. There is no idle auto-revoke.
 *
 * It can never drain the domain pool (pg default max 10):
 *   - at most {@link DEVICE_ACTIVITY_MAX_IN_FLIGHT} writes are in flight per
 *     process; a device seen while the cap is full is skipped (not marked,
 *     so its next request tries again) and counted, with one warn log per
 *     saturation episode and one info log with the total when it clears;
 *   - each write's transaction sets `lock_timeout = 1s` and
 *     `statement_timeout = 2s` (SET LOCAL), so a table lock (a migration's
 *     SHARE ROW EXCLUSIVE) or a slow database makes it give up, not wait.
 *
 * Two throttle layers:
 *   1. in process: a mark per device, set BEFORE the write starts, so a burst
 *      of requests in one process issues one write (bounded map, oldest
 *      dropped first);
 *   2. in the database, authoritative across replicas: the UPDATE matches
 *      only while `last_seen_at IS NULL OR last_seen_at < now() - interval`.
 *      Concurrent writers serialize on the row, and the later one re-checks
 *      the predicate and matches nothing. The row lock is `FOR NO KEY
 *      UPDATE` (only a non-key column changes), so it never conflicts with
 *      the `FOR KEY SHARE` that an FK check of a sale, shift or cash fact
 *      takes on the device; a row another transaction holds `FOR UPDATE`
 *      (revoke, retire, rotate, shift open) is skipped, not waited for, so a
 *      touch never holds a domain-pool connection behind a lifecycle
 *      transaction. A revoked device is never written.
 *
 * The write runs on the DOMAIN pool under the device's own tenant context
 * (constitution §II; `devices` is FORCE RLS). The lookup role has SELECT
 * only on `devices`; the domain role has UPDATE (RT-365 grant,
 * docs/operations/sql/device-lifecycle-domain-grants.sql). The
 * `devices_set_updated_at` trigger also moves `updated_at`; no device API
 * orders or pages by it.
 *
 * This is the activity signal only (RT-287 D-Q6): the AD-DEVICE-001
 * heartbeat (`device_health.last_seen_at`, RT-327) is a separate source.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import { createLogger, type Logger } from "@data-pulse-2/shared";
import type { Pool } from "pg";

/** At most one `last_seen_at` write per device per 5 minutes (RT-138 L7). */
export const DEVICE_ACTIVITY_INTERVAL_MS = 5 * 60_000;
/** Devices whose last attempt a process remembers; the oldest is dropped first. */
export const DEVICE_ACTIVITY_MAX_TRACKED = 10_000;
/** Activity writes (so domain-pool connections) one process may hold at once. */
export const DEVICE_ACTIVITY_MAX_IN_FLIGHT = 4;

/** The authenticated device: its id and the tenant whose context the write runs in. */
export interface ActiveDevice {
  readonly id: string;
  readonly tenantId: string;
}

const TOUCH_SQL = `UPDATE devices SET last_seen_at = now()
  WHERE id IN (
    SELECT id FROM devices
     WHERE id = $1::uuid AND tenant_id = $2::uuid AND revoked_at IS NULL
       AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => $3))
     FOR NO KEY UPDATE SKIP LOCKED)`;

let logger: Logger | null = null;
function log(): Logger {
  logger ??= createLogger({
    service: "backend-api",
    bindings: { component: "device-activity" },
    level: process.env["LOG_LEVEL"] ?? "info",
  });
  return logger;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.name : "unknown";
}

async function touchLastSeen(pool: Pool, device: ActiveDevice): Promise<void> {
  await runWithTenantContext(pool, { tenantId: device.tenantId, isPlatformAdmin: false }, async (client) => {
    // Give up rather than wait: a timeout is an error, logged and dropped.
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '2s'");
    await client.query(TOUCH_SQL, [device.id, device.tenantId, DEVICE_ACTIVITY_INTERVAL_MS / 1000]);
  });
}

export class DeviceActivityRecorder {
  private readonly lastAttemptMs = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();
  private skipped = 0;
  private skippedThisEpisode = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  /** Record that `device` authenticated now. Never throws, never blocks the caller. */
  record(pool: Pool, device: ActiveDevice): void {
    const now = this.clock();
    const last = this.lastAttemptMs.get(device.id);
    if (last !== undefined && now - last < DEVICE_ACTIVITY_INTERVAL_MS) return;
    if (this.pending.size >= DEVICE_ACTIVITY_MAX_IN_FLIGHT) {
      this.skip(device);
      return;
    }
    this.mark(device.id, now);

    const write: Promise<void> = Promise.resolve()
      .then(() => touchLastSeen(pool, device))
      .catch((err: unknown) => {
        log().warn({ device_id: device.id, err_code: errorCode(err) }, "device activity: last_seen_at write failed");
      })
      .finally(() => {
        this.pending.delete(write);
        this.endEpisodeIfClear();
      });
    this.pending.add(write);
  }

  /** Wait for every write in flight, including any recorded meanwhile (tests). Never rejects. */
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    await Promise.all(this.pending);
    // A write recorded while this one waited: wait for it too.
    return this.flush();
  }

  /** Forget every mark (tests). */
  reset(): void {
    this.lastAttemptMs.clear();
  }

  /** Devices skipped because the in-flight cap was full, since start (tests). */
  skippedCount(): number {
    return this.skipped;
  }

  /** How many devices this process remembers (tests). */
  trackedCount(): number {
    return this.lastAttemptMs.size;
  }

  private skip(device: ActiveDevice): void {
    this.skipped += 1;
    this.skippedThisEpisode += 1;
    if (this.skippedThisEpisode === 1) {
      log().warn(
        { device_id: device.id, in_flight: this.pending.size, max_in_flight: DEVICE_ACTIVITY_MAX_IN_FLIGHT },
        "device activity: in-flight cap reached; last_seen_at writes skipped until a slot frees",
      );
    }
  }

  private endEpisodeIfClear(): void {
    if (this.skippedThisEpisode === 0 || this.pending.size >= DEVICE_ACTIVITY_MAX_IN_FLIGHT) return;
    log().info({ skipped: this.skippedThisEpisode }, "device activity: in-flight cap cleared");
    this.skippedThisEpisode = 0;
  }

  private mark(deviceId: string, now: number): void {
    // Re-insert so the Map's insertion order stays oldest-first.
    this.lastAttemptMs.delete(deviceId);
    if (this.lastAttemptMs.size >= DEVICE_ACTIVITY_MAX_TRACKED) {
      const oldest = this.lastAttemptMs.keys().next().value;
      if (oldest !== undefined) this.lastAttemptMs.delete(oldest);
    }
    this.lastAttemptMs.set(deviceId, now);
  }
}

/** The process-wide recorder every `DeviceRepository` instance shares. */
export const deviceActivity = new DeviceActivityRecorder();
