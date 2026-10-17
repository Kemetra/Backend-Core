/**
 * RT-365 / RT-366 / RT-367 — the device lifecycle's in-transaction SQL, shared
 * by every path that reads or changes a device's trust: the Console revoke
 * and impact preview (`DevicesService`), the pairing-code issue
 * (`PairingCodesService`) and the redemption's replace / move auto-revoke
 * (`PairingRepository`). One implementation, so the preview, the revoke and
 * the replacement read the same facts and cascade the same rows.
 *
 * Every function runs on the caller's client, inside its transaction, under
 * its tenant GUC (RLS) and with an explicit `tenant_id` predicate.
 *
 * Lock order (no 40P01 between the paths): the device lifecycle advisory lock
 * (`device-lifecycle-lock.ts`), then the device row `FOR UPDATE`, then any
 * `pairing_codes` / `auth_tokens` write.
 */
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { lockDeviceLifecycle } from "./device-lifecycle-lock";
import {
  evaluateLifecycle,
  revokeReasonOf,
  type LifecycleEvaluation,
  type RevokeReason,
} from "./device-lifecycle.evaluator";
import { lifecycleStateOf, type DeviceImpactRow } from "./device-impact.projections";
import { EXPIRES_AT_KEY_SQL } from "./devices.projections";

/**
 * The revoke cascade's targets over the tenant ($1) and the device ($2): its
 * live operator sessions, and its pending pairing codes plus the pending
 * replacement codes for it. The revoke updates exactly these rows and the
 * impact preview counts them, so the two cannot drift.
 */
export const LIVE_OPERATOR_SESSIONS = `
  tenant_id = $1::uuid AND device_id = $2::uuid AND scope = 'pos_operator'
  AND revoked_at IS NULL AND expires_at > now()`;
export const PENDING_PAIRING_CODES = `
  tenant_id = $1::uuid AND status = 'pending'
  AND (terminal_id = $2::uuid OR replaces_device_id = $2::uuid)`;

/**
 * The used pairing codes that link a replacement to the device it replaced
 * (RT-367), over the tenant ($1), kept only when BOTH devices are in the
 * caller's store scope (`scopeParam`, null = tenant-wide): the other side of
 * a cross-store move reads as absent, like every out-of-scope device.
 */
export const linksCte = (scopeParam: string): string => `
  links AS (
    SELECT pc.device_id, pc.replaces_device_id, pc.used_at, pc.id
      FROM pairing_codes pc
      JOIN devices nd ON nd.id = pc.device_id AND nd.tenant_id = pc.tenant_id
      JOIN devices od ON od.id = pc.replaces_device_id AND od.tenant_id = pc.tenant_id
     WHERE pc.tenant_id = $1::uuid AND pc.status = 'used'
       AND (${scopeParam}::uuid[] IS NULL
            OR (nd.store_id = ANY(${scopeParam}::uuid[]) AND od.store_id = ANY(${scopeParam}::uuid[])))
  )`;

export const DEVICE_COLUMNS = `
  d.id, d.store_id, d.label, d.created_at, d.expires_at,
  ${EXPIRES_AT_KEY_SQL} AS expires_at_key,
  d.last_seen_at, d.revoked_at, d.revoked_by, d.revoke_reason, d.revoke_note,
  d.retired_at, d.retired_by, d.retire_reason,
  os.shift_id AS open_shift_id,
  (SELECT l.replaces_device_id FROM links l WHERE l.device_id = d.id
    ORDER BY l.used_at DESC NULLS LAST, l.id DESC LIMIT 1) AS replaces_device_id,
  (SELECT l.device_id FROM links l WHERE l.replaces_device_id = d.id
    ORDER BY l.used_at DESC NULLS LAST, l.id DESC LIMIT 1) AS replaced_by_device_id,
  CASE WHEN d.revoked_at IS NOT NULL AND os.shift_id IS NOT NULL THEN 0
       WHEN d.revoked_at IS NULL THEN 1
       WHEN d.retired_at IS NULL THEN 2
       ELSE 3 END AS rank`;

/**
 * One device's most recently opened open shift (the Cash Session rule's
 * input), looked up for that device only (no tenant-wide CTE).
 */
const OPEN_SHIFT_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT s.shift_id, s.source, s.opened_at, s.opening_cashier_user_id, s.received_at FROM shifts s
     WHERE s.tenant_id = d.tenant_id AND s.opening_device_id = d.id AND s.lifecycle_state = 'open'
     ORDER BY s.opened_at DESC, s.shift_id DESC
     LIMIT 1
  ) os ON true`;

/** $1 tenant, $2 device, $3 scoped store ids (null = tenant-wide). */
const ONE_DEVICE_WHERE = `
   WHERE d.tenant_id = $1::uuid
     AND d.id = $2::uuid
     AND ($3::uuid[] IS NULL OR d.store_id = ANY($3::uuid[]))`;

export const DETAIL_SQL = `
  WITH ${linksCte("$3")}
  SELECT ${DEVICE_COLUMNS}
    FROM devices d
    ${OPEN_SHIFT_LATERAL}
  ${ONE_DEVICE_WHERE}`;

/**
 * The impact read: the detail columns plus the open shift's facts, its
 * server-received cash-up facts (the open and its movements; none for a legacy
 * shift) and the cascade counts. One statement, so one snapshot. Parameters as
 * `DETAIL_SQL`.
 */
const IMPACT_SQL = `
  WITH ${linksCte("$3")}
  SELECT ${DEVICE_COLUMNS},
    os.source AS open_shift_source,
    os.opened_at AS open_shift_opened_at,
    os.opening_cashier_user_id AS open_shift_cashier_user_id,
    CASE WHEN os.source = 'cash_up' THEN 1 + mv.n END AS cash_fact_count,
    CASE WHEN os.source = 'cash_up' THEN GREATEST(os.received_at, mv.last_received_at) END AS cash_last_received_at,
    (SELECT count(*)::int FROM auth_tokens WHERE ${LIVE_OPERATOR_SESSIONS}) AS operator_session_count,
    (SELECT count(*)::int FROM pairing_codes WHERE ${PENDING_PAIRING_CODES}) AS pending_pairing_code_count,
    now() AS evaluated_at
    FROM devices d
    ${OPEN_SHIFT_LATERAL}
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, max(m.received_at) AS last_received_at FROM shift_cash_movements m
       WHERE m.tenant_id = d.tenant_id AND m.shift_id = os.shift_id
    ) mv ON true
  ${ONE_DEVICE_WHERE}`;

/** The impact read (`IMPACT_SQL`); null when the device is absent, foreign or out of scope. */
export async function readDeviceImpact(
  client: PoolClient,
  tenantId: string,
  deviceId: string,
  scopedStoreIds: readonly string[] | null,
): Promise<DeviceImpactRow | null> {
  const r = await client.query<DeviceImpactRow>(IMPACT_SQL, [tenantId, deviceId, scopedStoreIds]);
  return r.rows[0] ?? null;
}

/** The device row as the lifecycle lock sees it. */
export interface LockedDevice {
  readonly storeId: string;
  readonly revokedAt: Date | null;
}

/**
 * Take the device lifecycle lock, then the device row `FOR UPDATE` (see the
 * file header). Null when the device is absent or of another tenant.
 */
export async function lockDeviceForLifecycle(
  client: PoolClient,
  device: { readonly tenantId: string; readonly deviceId: string },
): Promise<LockedDevice | null> {
  await lockDeviceLifecycle(client, device);
  const locked = await client.query<{ store_id: string; revoked_at: Date | null }>(
    `SELECT store_id, revoked_at FROM devices
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      FOR UPDATE`,
    [device.deviceId, device.tenantId],
  );
  const row = locked.rows[0];
  return row === undefined ? null : { storeId: row.store_id, revokedAt: row.revoked_at };
}

export interface ApplyRevokeInput {
  readonly tenantId: string;
  readonly deviceId: string;
  /** The device's store (the audit row's store). */
  readonly storeId: string;
  /** The session user; null for the redemption's auto-revoke (no session user). */
  readonly actorUserId: string | null;
  readonly reason: RevokeReason;
  readonly note: string | null;
  readonly custodyExceptionShiftId: string | null;
  /** Extra allow-listed audit metadata (ids only), e.g. `replaced_by_device_id`. */
  readonly extraMetadata?: Readonly<Record<string, string>>;
}

/** What a revoke cascaded (the counts its audit row records). */
export interface RevokeCascade {
  readonly revokedSessionCount: number;
  readonly cancelledPairingCodeCount: number;
}

/**
 * The revoke fields, the cascade (live operator sessions, pending codes) and
 * the `pos.device.revoked` audit row, inside the caller's transaction. Audit
 * metadata is the RT-135 allowlist: never the note, a token, a hash or a code.
 */
export async function applyDeviceRevoke(client: PoolClient, input: ApplyRevokeInput): Promise<RevokeCascade> {
  await client.query(
    `UPDATE devices
        SET revoked_at = now(), revoked_by = $3::uuid, revoke_reason = $4, revoke_note = $5
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND revoked_at IS NULL`,
    [input.deviceId, input.tenantId, input.actorUserId, input.reason, input.note],
  );
  const sessions = await client.query(
    `UPDATE auth_tokens SET revoked_at = now() WHERE ${LIVE_OPERATOR_SESSIONS} RETURNING id`,
    [input.tenantId, input.deviceId],
  );
  // The device's own pending codes and the pending replacement codes for it.
  // A code issued after this revoke is untouched (RT-367 replace / move).
  const cancelledPairingCodeCount = await cancelPendingCodes(client, input.tenantId, input.deviceId);
  const revokedSessionCount = sessions.rowCount ?? 0;
  const metadata: Record<string, unknown> = {
    reason: input.reason,
    revoked_session_count: revokedSessionCount,
    cancelled_pairing_code_count: cancelledPairingCodeCount,
    custody_exception: input.custodyExceptionShiftId !== null,
    ...(input.custodyExceptionShiftId !== null ? { shift_id: input.custodyExceptionShiftId } : {}),
    ...input.extraMetadata,
  };
  await insertDeviceAudit(client, {
    tenantId: input.tenantId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    action: "pos.device.revoked",
    targetType: "device",
    targetId: input.deviceId,
    metadata,
  });
  return { revokedSessionCount, cancelledPairingCodeCount };
}

/**
 * Cancel the device's pending codes: its own (`terminal_id`) and the
 * replacement codes naming it (the revoke cascade's predicate). Returns how
 * many were cancelled.
 */
export async function cancelPendingCodes(client: PoolClient, tenantId: string, deviceId: string): Promise<number> {
  const codes = await client.query(
    `UPDATE pairing_codes SET status = 'cancelled' WHERE ${PENDING_PAIRING_CODES} RETURNING id`,
    [tenantId, deviceId],
  );
  return codes.rowCount ?? 0;
}

/** One `pos.device.*` audit row, in the caller's transaction. */
export async function insertDeviceAudit(
  client: PoolClient,
  row: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly actorUserId: string | null;
    readonly action: string;
    readonly targetType: "device" | "pairing_code";
    readonly targetId: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, tenant_id, store_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [newId(), row.actorUserId, row.tenantId, row.storeId, row.action, row.targetType, row.targetId, JSON.stringify(row.metadata)],
  );
}

/** A replacement code's kind: the replaced device's own store is a replace, another store a move (RT-287 D-Q1). */
export type ReplacementKind = "replace" | "move";

export interface ReplacementDecision {
  readonly kind: ReplacementKind;
  readonly reason: RevokeReason;
  readonly evaluation: LifecycleEvaluation;
}

/**
 * The lifecycle evaluator's verdict on replacing `row` by a device paired into
 * `targetStoreId`: the same decision the impact preview reports for that
 * action. Replace / move take no role input (`requires` is always empty).
 */
export function decideReplacement(row: DeviceImpactRow, targetStoreId: string): ReplacementDecision {
  const kind: ReplacementKind = row.store_id === targetStoreId ? "replace" : "move";
  const reason = revokeReasonOf(kind);
  const evaluation = evaluateLifecycle({ action: kind, reason, state: lifecycleStateOf(row), callerRole: null });
  return { kind, reason, evaluation };
}
