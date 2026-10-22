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
 *
 * Build identity (RT-719)
 * -----------------------
 * A reporting operation (`@ReportsBuildIdentity()`) passes what its request
 * said about the POS build (`record`'s third argument: an identity, or `null`
 * for unknown). That report rides the SAME throttled write as `last_seen_at`,
 * so it is stored at most once per window per device and may show up to one
 * window late; an unknown report CLEARS the stored identity (unknown is never
 * kept from an older build). A request that is not a reporting one passes
 * `undefined` and the write is the plain touch: it can neither record nor
 * clear the identity. A failure to store is counted (`failed`) and swallowed
 * with the rest of this write. The metric carries only the outcome, never a
 * commit or a version.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Logger } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import { createApiLogger } from "../common/api-logger";
import { recordPosBuildIdentityReport } from "../observability/metrics/api.metrics";
import type { BuildIdentityReport } from "./build-identity";

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

/** The throttled, skip-locked row pick both writes share: $1 device, $2 tenant, $3 window in seconds. */
const DUE_DEVICE = `id IN (
    SELECT id FROM devices
     WHERE id = $1::uuid AND tenant_id = $2::uuid AND revoked_at IS NULL
       AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => $3))
     FOR NO KEY UPDATE SKIP LOCKED)`;

const TOUCH_SQL = `UPDATE devices SET last_seen_at = now() WHERE ${DUE_DEVICE}`;

/**
 * The same write for a reporting request (RT-719): $4 commit, $5 version, $6 pin,
 * each NULL when unknown. `build_reported_at` is the server clock when a commit
 * is stored and NULL otherwise (the 0073 CHECK ties the four together).
 */
const REPORT_SQL = `UPDATE devices SET last_seen_at = now(),
       reported_build_commit = $4::text, reported_app_version = $5::text, reported_contract_pin = $6::text,
       build_reported_at = CASE WHEN $4::text IS NULL THEN NULL ELSE now() END
  WHERE ${DUE_DEVICE}`;

let logger: Logger | null = null;
function log(): Logger {
  logger ??= createApiLogger("device-activity");
  return logger;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.name : "unknown";
}

/** Count a build identity store that took effect (a write inside the window changed no row and is no outcome). */
function countBuildReport(build: BuildIdentityReport | undefined, changed: number): void {
  if (build !== undefined && changed > 0) recordPosBuildIdentityReport(build === null ? "unknown" : "recorded");
}

/** Count a build identity store that failed; a write that was not a report is not counted. */
function countBuildReportFailure(build: BuildIdentityReport | undefined): void {
  if (build !== undefined) recordPosBuildIdentityReport("failed");
}

/** Write the touch (and the build report, when there is one); the number of rows it changed (0: not due). */
function touchLastSeen(pool: Pool, device: ActiveDevice, build: BuildIdentityReport | undefined): Promise<number> {
  return runWithTenantContext(pool, { tenantId: device.tenantId, isPlatformAdmin: false }, async (client) => {
    // Give up rather than wait: a timeout is an error, logged and dropped.
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '2s'");
    const window = DEVICE_ACTIVITY_INTERVAL_MS / 1000;
    const res =
      build === undefined
        ? await client.query(TOUCH_SQL, [device.id, device.tenantId, window])
        : await client.query(REPORT_SQL, [device.id, device.tenantId, window, build?.commit ?? null, build?.appVersion ?? null, build?.contractPin ?? null]);
    return res.rowCount ?? 0;
  });
}

export class DeviceActivityRecorder {
  private readonly lastAttemptMs = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();
  private skipped = 0;
  private skippedThisEpisode = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  /**
   * Record that `device` authenticated now. `build` is what a reporting
   * request said about the POS build (an identity, or `null` for unknown) and
   * `undefined` for any other request. Never throws, never blocks the caller.
   */
  record(pool: Pool, device: ActiveDevice, build?: BuildIdentityReport): void {
    const now = this.clock();
    const last = this.lastAttemptMs.get(device.id);
    if (last !== undefined && now - last < DEVICE_ACTIVITY_INTERVAL_MS) return;
    if (this.pending.size >= DEVICE_ACTIVITY_MAX_IN_FLIGHT) {
      this.skip(device);
      return;
    }
    this.mark(device.id, now);

    const write: Promise<void> = Promise.resolve()
      .then(() => touchLastSeen(pool, device, build))
      .then((changed) => countBuildReport(build, changed))
      .catch((err: unknown) => {
        countBuildReportFailure(build);
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
