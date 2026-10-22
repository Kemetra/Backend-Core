/**
 * The Inventory Safety Revision — Jira RT-449 (RT-50 G7-7, 864 / 865).
 *
 * Every safety command runs this sequence in its own tenant-context
 * transaction:
 *
 *   1. `lockTenantSafety`: a per-tenant advisory transaction lock. It writes
 *      nothing, so a replay or a refusal found after it leaves no trace.
 *   2. Its replay / no-op checks and validation (still no writes).
 *   3. `bumpSafetyRevision`: the row-locked upsert of the tenant's revision.
 *      The row lock is held until commit, so commit order equals revision
 *      order and the feed delta (RT-449 PR 2) never sees revision n + 1
 *      without n.
 *   4. Its records, then `recordSafetyChange`: exactly one change per
 *      revision step (UNIQUE (tenant_id, revision)), naming what changed.
 */
import type { InventorySafetyChangeKind } from '@data-pulse-2/db';
import type { PoolClient } from 'pg';

/**
 * The advisory-lock namespace of a tenant's safety commands. The key is
 * derived as the inventory-effects helpers derive theirs
 * (`INVENTORY_SETTINGS_LOCK_NAMESPACE`, packages/db sale-effects.ts):
 * `hashtextextended(<namespace> || ':' || <tenant id>, 0)`.
 */
export const INVENTORY_SAFETY_LOCK_NAMESPACE = 'inventory_safety';

/** Serialize the tenant's safety commands (released at commit / rollback). */
export async function lockTenantSafety(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`, [
    INVENTORY_SAFETY_LOCK_NAMESPACE,
    tenantId,
  ]);
}

/** Step the tenant's Safety Revision by one; returns the new revision. */
export async function bumpSafetyRevision(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query<{ revision: string }>(
    `INSERT INTO tenant_inventory_safety_revisions (tenant_id, revision) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET revision = tenant_inventory_safety_revisions.revision + 1
     RETURNING revision::text AS revision`,
    [tenantId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('bumpSafetyRevision: the upsert returned no row');
  return Number(row.revision);
}

/** What one revision step changed (inventory_safety_changes). */
export interface SafetyChange {
  readonly tenantId: string;
  readonly revision: number;
  readonly kind: InventorySafetyChangeKind;
  readonly tenantProductRef: string;
  readonly trackingHoldId?: string;
  readonly inventoryRecallId?: string;
  readonly trackingIdentityId?: string;
  readonly createdBy: string;
}

export async function recordSafetyChange(client: PoolClient, change: SafetyChange): Promise<void> {
  await client.query(
    `INSERT INTO inventory_safety_changes
       (tenant_id, revision, kind, tracking_hold_id, inventory_recall_id, tracking_identity_id,
        tenant_product_ref, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      change.tenantId,
      change.revision,
      change.kind,
      change.trackingHoldId ?? null,
      change.inventoryRecallId ?? null,
      change.trackingIdentityId ?? null,
      change.tenantProductRef,
      change.createdBy,
    ],
  );
}

/** Which recorded change a replay reports the revision of. */
export type RecordedChange =
  | { readonly kind: 'hold_placed' | 'hold_released'; readonly trackingHoldId: string }
  | { readonly kind: 'recall_created'; readonly inventoryRecallId: string }
  | { readonly kind: 'expiry_corrected'; readonly correctionId: string };

/** The revision a recorded command produced (for its replay). */
export async function recordedRevision(client: PoolClient, change: RecordedChange): Promise<number> {
  const r =
    change.kind === 'recall_created'
      ? await client.query<{ revision: string }>(
          `SELECT revision::text AS revision FROM inventory_safety_changes
            WHERE kind = $1 AND inventory_recall_id = $2`,
          [change.kind, change.inventoryRecallId],
        )
      : change.kind === 'expiry_corrected'
        ? // The change and its correction share the transaction's now().
          await client.query<{ revision: string }>(
            `SELECT c.revision::text AS revision
               FROM inventory_safety_changes c
               JOIN tracking_identity_expiry_corrections x
                 ON x.tracking_identity_id = c.tracking_identity_id AND x.created_at = c.created_at
              WHERE c.kind = $1 AND x.id = $2`,
            [change.kind, change.correctionId],
          )
        : await client.query<{ revision: string }>(
            `SELECT revision::text AS revision FROM inventory_safety_changes
              WHERE kind = $1 AND tracking_hold_id = $2`,
            [change.kind, change.trackingHoldId],
          );
  const row = r.rows[0];
  if (!row) throw new Error(`recordedRevision: no ${change.kind} change recorded`);
  return Number(row.revision);
}
