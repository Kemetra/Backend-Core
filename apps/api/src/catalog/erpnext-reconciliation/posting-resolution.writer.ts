/**
 * posting-resolution.writer.ts — shared write helpers for the posting
 * reconciliation surfaces (RT-333): the operator resolution freeze, the
 * caller's store-write scope check and the in-transaction audit insert.
 *
 * Used by the 017 repair (`ErpnextReconciliationService.repairPosting`) and the
 * RT-333 re-resolution (`ErpnextPostingReResolutionService`). Every function
 * runs on the caller's tenant-scoped client inside its transaction.
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

import type { MembershipRepository } from "../../context/membership.repository";
import type { ResolvedContext } from "../../context/types";
import { callerStoreScope, inStoreScope } from "../../context/operator-store-scope";

export interface FreezeResolutionInput {
  readonly tenantId: string;
  readonly intentId: string;
  readonly kind: "sale_post" | "reversal";
  readonly saleId: string;
  readonly storeId: string;
}

export interface AuditEventInput {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Write resolution version n+1 (`resolved_by = 'operator'`) for a posting
 * intent — an explicit, audited re-resolution before any ERP side effect (ERP
 * Integration baseline). A reversal copies its sale's `sale_post` current
 * resolution (original lineage); otherwise the current maps are read. Each
 * INSERT is all-or-nothing over the sale lines (the worker's
 * `freezeResolution` copy — SQL is duplicated per package). Returns the new
 * version, or null when nothing could be frozen. The caller points the row at it.
 */
export async function freezeOperatorResolution(
  client: PoolClient,
  input: FreezeResolutionInput,
): Promise<number | null> {
    const next = await client.query<{ v: number }>(
      `SELECT COALESCE(MAX(resolution_version), 0) + 1 AS v
         FROM erpnext_posting_resolution WHERE intent_id = $1`,
      [input.intentId],
    );
    const version = next.rows[0]!.v;
    let written = 0;
    if (input.kind === "reversal") {
      const copied = await client.query(
        `INSERT INTO erpnext_posting_resolution
           (tenant_id, intent_id, resolution_version, sale_line_id,
            erpnext_item_ref, item_map_id, warehouse_ref, warehouse_map_id, resolved_by)
         SELECT $1, $2, $3, r.sale_line_id,
                r.erpnext_item_ref, r.item_map_id, r.warehouse_ref, r.warehouse_map_id, 'operator'
           FROM erpnext_posting_status sp
           JOIN erpnext_posting_resolution r
             ON r.intent_id = sp.id AND r.resolution_version = sp.current_resolution_version
          WHERE sp.tenant_id = $1 AND sp.kind = 'sale_post'
            AND sp.sale_id = $4 AND sp.source_ref_id = $4`,
        [input.tenantId, input.intentId, version, input.saleId],
      );
      written = copied.rowCount ?? 0;
    }
    if (written === 0) {
      const resolved = await client.query(
        `INSERT INTO erpnext_posting_resolution
           (tenant_id, intent_id, resolution_version, sale_line_id,
            erpnext_item_ref, item_map_id, warehouse_ref, warehouse_map_id, resolved_by)
         SELECT $1, $2, $3, sl.id, m.erpnext_item_ref, m.id,
                w.erpnext_warehouse_ref, w.id, 'operator'
           FROM sale_lines sl
           JOIN erpnext_warehouse_map w
             ON w.store_id = $5 AND w.purpose = 'stock' AND w.retired_at IS NULL
           JOIN erpnext_item_map m
             ON m.tenant_product_id = sl.tenant_product_ref
            AND m.state = 'confirmed' AND m.retired_at IS NULL
          WHERE sl.sale_id = $4
            AND NOT EXISTS (
              SELECT 1 FROM sale_lines ul
                LEFT JOIN erpnext_item_map um
                  ON um.tenant_product_id = ul.tenant_product_ref
                 AND um.state = 'confirmed' AND um.retired_at IS NULL
               WHERE ul.sale_id = $4
                 AND (ul.tenant_product_ref IS NULL OR um.id IS NULL))`,
        [input.tenantId, input.intentId, version, input.saleId, input.storeId],
      );
      written = resolved.rowCount ?? 0;
    }
    return written > 0 ? version : null;
}

/** The caller may write to this (non-deleted) store (RT-191 store scope). */
export async function isStoreWritable(
  client: PoolClient,
  memberships: MembershipRepository,
  input: { readonly tenantId: string; readonly context: ResolvedContext },
  storeId: string,
): Promise<boolean> {
  const scope = await callerStoreScope(client, memberships, input);
  if (!inStoreScope(scope, storeId)) return false;
  const store = await client.query<{ id: string }>(
    `SELECT id FROM stores WHERE id = $1 AND deleted_at IS NULL`,
    [storeId],
  );
  return store.rows.length > 0;
}

/** Shared in-transaction platform audit insert (FR-014; same tx client, no PII). */
export async function insertAuditEvent(
  client: PoolClient,
  tenantId: string,
  actorUserId: string,
  opts: AuditEventInput,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [newId(), actorUserId, tenantId, opts.action, opts.targetType, opts.targetId, JSON.stringify(opts.metadata)],
  );
}
