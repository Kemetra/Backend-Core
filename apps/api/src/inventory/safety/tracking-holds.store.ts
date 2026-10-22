/**
 * Tracking-hold persistence shared by the hold and recall commands — Jira
 * RT-449. Every function runs on the caller's tenant-context transaction
 * (FORCE RLS: another tenant's rows are invisible).
 */
import type { TrackingHoldKind } from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { PoolClient } from 'pg';

import { HOLD_COLUMNS, type HoldRow } from './safety.common';

export interface LockedIdentity {
  id: string;
  tenant_product_ref: string;
}

/**
 * Lock the identities (in id order) and return the ones visible in the
 * tenant, optionally only those of `productId`. `FOR UPDATE` also blocks new
 * identity-grain effects (their FK takes KEY SHARE) until commit.
 */
export async function lockIdentities(
  client: PoolClient,
  identityIds: readonly string[],
  productId: string | null,
): Promise<LockedIdentity[]> {
  const r = await client.query<LockedIdentity>(
    `SELECT id, tenant_product_ref FROM tracking_identities
      WHERE id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR tenant_product_ref = $2)
      ORDER BY id
      FOR UPDATE`,
    [identityIds, productId],
  );
  return r.rows;
}

/** The identities among `identityIds` with an active hold of `kind`. */
export async function identitiesWithActiveHold(
  client: PoolClient,
  identityIds: readonly string[],
  kind: TrackingHoldKind,
): Promise<string[]> {
  const r = await client.query<{ tracking_identity_id: string }>(
    `SELECT tracking_identity_id FROM tracking_holds
      WHERE tracking_identity_id = ANY($1::uuid[]) AND kind = $2 AND released_at IS NULL`,
    [identityIds, kind],
  );
  return r.rows.map((row) => row.tracking_identity_id);
}

export interface NewHold {
  readonly tenantId: string;
  readonly trackingIdentityId: string;
  readonly tenantProductRef: string;
  readonly kind: TrackingHoldKind;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly recallId: string | null;
  readonly commandFingerprint: string | null;
  readonly placedBy: string;
}

export async function insertHold(client: PoolClient, hold: NewHold): Promise<HoldRow> {
  const r = await client.query<HoldRow>(
    `INSERT INTO tracking_holds
       (id, tenant_id, tracking_identity_id, tenant_product_ref, kind, reason_code, note, recall_id,
        command_fingerprint, placed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${HOLD_COLUMNS}`,
    [
      newId(),
      hold.tenantId,
      hold.trackingIdentityId,
      hold.tenantProductRef,
      hold.kind,
      hold.reasonCode,
      hold.note,
      hold.recallId,
      hold.commandFingerprint,
      hold.placedBy,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error('insertHold: INSERT returned no row');
  return row;
}

/** A hold of the tenant, or undefined (`forUpdate` locks it). */
export async function findHold(client: PoolClient, holdId: string, forUpdate: boolean): Promise<HoldRow | undefined> {
  const r = await client.query<HoldRow>(
    `SELECT ${HOLD_COLUMNS} FROM tracking_holds WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [holdId],
  );
  return r.rows[0];
}

/** A recall's holds, in identity order. */
export async function holdsOfRecall(client: PoolClient, recallId: string): Promise<HoldRow[]> {
  const r = await client.query<HoldRow>(
    `SELECT ${HOLD_COLUMNS} FROM tracking_holds WHERE recall_id = $1 ORDER BY tracking_identity_id`,
    [recallId],
  );
  return r.rows;
}
