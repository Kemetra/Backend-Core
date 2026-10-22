/**
 * DeviceHeartbeatService: `posReportDeviceHeartbeat` (RT-327, AD-DEVICE-001
 * D-1 to D-3; `pos-device-health.openapi.yaml`).
 *
 * Identity (device, tenant, store) is the `DeviceScope` the guard resolved,
 * never a body field (§XII). `last_seen_at` is the database server clock;
 * `source_clock_at` is the terminal's own clock, kept as provenance only.
 *
 * One transaction under the device's tenant context (RLS on `device_health`):
 *   1. read the policy of the channel the beat reported (a read that fails is
 *      a 500: no reply can be computed);
 *   2. store the beat, inside a SAVEPOINT. The store is DB-throttled: the
 *      upsert's `WHERE` lets a write through only when the stored beat is at
 *      least `HEARTBEAT_STORE_INTERVAL_SECONDS` old, so concurrent beats of
 *      one device serialize on the row and the later one re-checks and writes
 *      nothing. A beat inside the window is `throttled`. A store that fails
 *      (a lock held too long, a database error) is `refused`: counted, logged
 *      with the device id and error code only, and swallowed. In every case
 *      the terminal gets the reply of step 1 computed from THIS request.
 *
 * A stored beat replaces every self-reported field: an omitted field is
 * stored as NULL (unknown), never kept from an earlier beat. There is no
 * history, no audit row per beat and no per-device rate limit; the one signal
 * is `pos_device_heartbeat_total{outcome}`.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Logger } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { recordPosDeviceHeartbeat, type PosDeviceHeartbeatOutcome } from "../observability/metrics/api.metrics";
import type { DeviceScope } from "../pos-cashier-admissions/device-scope";
import type { HeartbeatReport } from "./dto";
import { buildHeartbeatAck, type ChannelPolicy, type HeartbeatAckBody } from "./heartbeat-ack";

export const DEVICE_HEALTH_LOGGER = "DEVICE_HEALTH_LOGGER";

/** At most one stored beat per device per this many seconds (server clock). */
export const HEARTBEAT_STORE_INTERVAL_SECONDS = 60;

/** The store's lock wait ceiling: a beat never waits long behind a lock. */
const STORE_LOCK_TIMEOUT = "1s";

interface PolicyDbRow {
  channel: string;
  latest_version: string;
  recommended_version: string;
  min_supported_version: string;
  min_supported_grace_until: Date;
  revision: number;
}

const POLICY_SQL = `
  SELECT channel, latest_version, recommended_version, min_supported_version,
         min_supported_grace_until, revision
    FROM pos_version_policy
   WHERE channel = $1::text`;

/** $1 device, $2 tenant, $3..$8 the beat's fields, $9 the throttle window in seconds. */
const STORE_SQL = `
  INSERT INTO device_health
    (device_id, tenant_id, last_seen_at, app_version, update_channel, update_state,
     pending_version, schema_head, source_clock_at)
  SELECT d.id, d.tenant_id, now(), $3::text, $4::text, $5::text, $6::text, $7::text, $8::timestamptz
    FROM devices d
   WHERE d.id = $1::uuid AND d.tenant_id = $2::uuid AND d.revoked_at IS NULL
  ON CONFLICT (device_id) DO UPDATE SET
    last_seen_at    = now(),
    app_version     = EXCLUDED.app_version,
    update_channel  = EXCLUDED.update_channel,
    update_state    = EXCLUDED.update_state,
    pending_version = EXCLUDED.pending_version,
    schema_head     = EXCLUDED.schema_head,
    source_clock_at = EXCLUDED.source_clock_at,
    updated_at      = now()
  WHERE device_health.last_seen_at <= now() - make_interval(secs => $9::int)
  RETURNING device_id`;

function toPolicy(row: PolicyDbRow): ChannelPolicy {
  return {
    channel: row.channel,
    latestVersion: row.latest_version,
    recommendedVersion: row.recommended_version,
    minSupportedVersion: row.min_supported_version,
    minSupportedGraceUntil: row.min_supported_grace_until,
    revision: row.revision,
  };
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
}

@Injectable()
export class DeviceHeartbeatService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(DEVICE_HEALTH_LOGGER) private readonly logger: Logger,
  ) {}

  async report(scope: DeviceScope, report: HeartbeatReport): Promise<HeartbeatAckBody> {
    return runWithTenantContext(this.pool, { tenantId: scope.tenantId, isPlatformAdmin: false }, async (client) => {
      const channel = report.update_channel ?? null;
      const policy = channel === null ? null : await this.readPolicy(client, channel);
      const outcome = await this.store(client, scope, report);
      recordPosDeviceHeartbeat(outcome);
      return buildHeartbeatAck({
        now: new Date(),
        appVersion: report.app_version ?? null,
        updateChannel: channel,
        policy,
      });
    });
  }

  private async readPolicy(client: PoolClient, channel: string): Promise<ChannelPolicy | null> {
    const res = await client.query<PolicyDbRow>(POLICY_SQL, [channel]);
    const row = res.rows[0];
    return row === undefined ? null : toPolicy(row);
  }

  private async store(client: PoolClient, scope: DeviceScope, report: HeartbeatReport): Promise<PosDeviceHeartbeatOutcome> {
    await client.query("SAVEPOINT heartbeat_store");
    try {
      await client.query(`SET LOCAL lock_timeout = '${STORE_LOCK_TIMEOUT}'`);
      const res = await client.query(STORE_SQL, [
        scope.deviceId,
        scope.tenantId,
        report.app_version ?? null,
        report.update_channel ?? null,
        report.update_state ?? null,
        report.pending_version ?? null,
        report.schema_head ?? null,
        report.source_clock_at ?? null,
        HEARTBEAT_STORE_INTERVAL_SECONDS,
      ]);
      await client.query("RELEASE SAVEPOINT heartbeat_store");
      return res.rowCount === 1 ? "stored" : "throttled";
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT heartbeat_store");
      this.logger.warn({ deviceId: scope.deviceId, code: errorCode(err) }, "device.heartbeat.store_failed");
      return "refused";
    }
  }
}
