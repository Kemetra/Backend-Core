/**
 * RT-369 — the device token rotation's in-transaction SQL. Every function
 * runs on the caller's client, inside its transaction, under the device's
 * tenant GUC (RLS) and with an explicit `tenant_id` predicate.
 *
 * Lock order: the device lifecycle advisory lock, then the device row
 * `FOR UPDATE` — the order of the revoke and the retire (RT-365 / RT-368),
 * so rotate never deadlocks with them.
 */
import type { PoolClient } from "pg";

import { lockDeviceLifecycle } from "../devices/device-lifecycle-lock";
import { insertDeviceAudit } from "../devices/device-lifecycle.store";
import type { RotationCredential, RotationDeviceState, RotationRejectReason } from "./rotation-decision";

/** The device identity a rotation acts on (from the authenticated row). */
export interface RotationTarget {
  readonly tenantId: string;
  readonly storeId: string;
  readonly deviceId: string;
}

interface LockedRow {
  token_hash: Buffer;
  previous_token_hash: Buffer | null;
  previous_valid_until: Date | null;
  revoked_at: Date | null;
  retired_at: Date | null;
  expires_at: Date;
  db_now: Date;
}

/** Take the lifecycle lock, then the row lock; null when the device is gone. */
export async function lockDeviceForRotation(
  client: PoolClient,
  target: RotationTarget,
): Promise<RotationDeviceState | null> {
  await lockDeviceLifecycle(client, { tenantId: target.tenantId, deviceId: target.deviceId });
  const res = await client.query<LockedRow>(
    `SELECT token_hash, previous_token_hash, previous_valid_until, revoked_at, retired_at, expires_at,
            now() AS db_now
       FROM devices
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      FOR UPDATE`,
    [target.deviceId, target.tenantId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    tokenHash: row.token_hash,
    previousTokenHash: row.previous_token_hash,
    previousValidUntil: row.previous_valid_until,
    revokedAt: row.revoked_at,
    retiredAt: row.retired_at,
    expiresAt: row.expires_at,
    now: row.db_now,
  };
}

/** The new expiry and the overlap window a rotation wrote. */
export interface RotationWrite {
  readonly expiresAt: Date;
  readonly rotateAfter: Date;
  readonly previousValidUntil: Date;
}

/**
 * Replace the token (`newHash`) and push the expiry to `now() + 90 days`.
 * Presented the current token: the current hash becomes the previous one
 * for 10 minutes. Presented the previous token: the current hash (never
 * delivered) is dropped and the previous hash and its window are kept.
 */
export async function applyRotation(
  client: PoolClient,
  target: RotationTarget,
  credential: RotationCredential,
  newHash: Buffer,
): Promise<RotationWrite> {
  const previousSet =
    credential === "current"
      ? `, previous_token_hash = token_hash, previous_valid_until = now() + interval '10 minutes'`
      : "";
  const res = await client.query<{ expires_at: Date; rotate_after: Date; previous_valid_until: Date }>(
    `UPDATE devices
        SET token_hash = $3, expires_at = now() + interval '90 days'${previousSet}
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      RETURNING expires_at, expires_at - interval '15 days' AS rotate_after, previous_valid_until`,
    [target.deviceId, target.tenantId, newHash],
  );
  const row = res.rows[0]!;
  return { expiresAt: row.expires_at, rotateAfter: row.rotate_after, previousValidUntil: row.previous_valid_until };
}

/** `pos.device.rotated` (RT-135 allowlist: never a token, hash or key). */
export function auditRotated(
  client: PoolClient,
  target: RotationTarget,
  credential: RotationCredential,
  inGrace: boolean,
  write: RotationWrite,
): Promise<void> {
  return insertDeviceAudit(client, {
    tenantId: target.tenantId,
    storeId: target.storeId,
    actorUserId: null,
    action: "pos.device.rotated",
    targetType: "device",
    targetId: target.deviceId,
    metadata: {
      credential,
      in_grace: inGrace,
      expires_at: write.expiresAt.toISOString(),
      previous_valid_until: write.previousValidUntil.toISOString(),
    },
  });
}

/** `pos.device.rotation_rejected` (RT-135 allowlist: the reason only). */
export function auditRotationRejected(
  client: PoolClient,
  target: RotationTarget,
  reason: RotationRejectReason,
): Promise<void> {
  return insertDeviceAudit(client, {
    tenantId: target.tenantId,
    storeId: target.storeId,
    actorUserId: null,
    action: "pos.device.rotation_rejected",
    targetType: "device",
    targetId: target.deviceId,
    metadata: { reason },
  });
}
