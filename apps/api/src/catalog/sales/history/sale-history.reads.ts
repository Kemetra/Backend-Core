/**
 * RT-539 — the sale-history reads (`pos-sales/sale-history.yaml`
 * 1.0.0-draft), run on the caller's tenant-scoped client.
 *
 * Isolation. Every query carries explicit `tenant_id` and `store_id`
 * predicates on top of tenant RLS: the sales RLS policies are tenant-only, so
 * the store boundary is enforced here. A cashier's visibility (OD-534-1 A) is
 * one more predicate, `created_by = the admitted cashier`, applied to the
 * list, the detail and the reprint alike, so a sale outside the caller's
 * visibility never matches: the same non-disclosing 404 as an absent ref, and
 * never a list row. Child reads (lines, tenders, void, returns) run only for a
 * sale that matched, and carry the tenant and store too.
 */
import type { PoolClient } from "pg";

import {
  toSaleHistoryDetail,
  type DetailLineRow,
  type DetailReturnRow,
  type DetailTenderRow,
  type DetailVoidRow,
  type SaleHistoryDetail,
  type SaleHistoryDetailRow,
} from "./sale-history.projections";
import { OCCURRED_AT_KEY_SQL, type SaleHistoryKeyset } from "./sale-history.query";
import type { ListSaleHistoryInput, SaleHistoryScope } from "./sale-history.types";

/** The sale columns of a list row; `s` is `sales`. Joins add the current names and the posting. */
export const SALE_SELECT_SQL = `
  SELECT s.id AS sale_id, s.tender_count, s.business_date::text AS business_date, s.occurred_at,
         ${OCCURRED_AT_KEY_SQL} AS occurred_at_key,
         s.received_at, s.device_id, d.label AS device_label, s.created_by,
         u.display_name AS user_display_name, s.currency_code, s.pos_total::text AS pos_total,
         s.sync_status,
         s.receipt_sale_number, s.receipt_number, s.receipt_terminal_label,
         s.receipt_operator_display_name, s.receipt_settled_at, s.receipt_branch_name,
         s.receipt_branch_address, s.receipt_tax_registration_id,
         s.receipt_change_given::text AS receipt_change_given,
         -- Scalar LIMIT 1 probes run per row on the per-sale indexes; an
         -- EXISTS here is planned as a hashed SubPlan over the tenant's
         -- whole void / return history on every page (RT-539 DB review).
         (SELECT 1 FROM sale_voids v
           WHERE v.sale_id = s.id AND v.tenant_id = s.tenant_id LIMIT 1) IS NOT NULL AS voided,
         CASE
           WHEN (SELECT 1 FROM sale_returns r
                  WHERE r.sale_id = s.id AND r.tenant_id = s.tenant_id LIMIT 1) IS NULL THEN 'none'
           WHEN (SELECT 1 FROM sale_lines sl
                  WHERE sl.sale_id = s.id AND sl.tenant_id = s.tenant_id
                    AND sl.quantity > (SELECT COALESCE(SUM(rl.quantity), 0)
                                         FROM sale_return_lines rl WHERE rl.sale_line_id = sl.id)
                  LIMIT 1) IS NOT NULL THEN 'partial'
           ELSE 'full'
         END AS return_state,
         p.status AS erp_status, p.document_ref AS erp_document_ref
    FROM sales s
    LEFT JOIN devices d ON d.id = s.device_id
    LEFT JOIN users u ON u.id = s.created_by
    LEFT JOIN erpnext_posting_status p
           ON p.tenant_id = s.tenant_id AND p.kind = 'sale_post' AND p.source_ref_id = s.id`;

const LINES_SQL = `
  SELECT sl.id::text AS line_ref, sl.line_seq, sl.line_name, sl.unit_price::text AS unit_price,
         sl.currency_code, sl.quantity::text AS quantity, sl.line_amount::text AS line_amount,
         sl.tax_amount::text AS tax_amount, sl.unit,
         (SELECT COALESCE(SUM(rl.quantity), 0)::numeric(19,6)
            FROM sale_return_lines rl WHERE rl.sale_line_id = sl.id)::text AS returned_quantity
    FROM sale_lines sl
   WHERE sl.sale_id = $1 AND sl.tenant_id = $2 AND sl.store_id = $3
   ORDER BY sl.line_seq NULLS LAST, sl.line_name, sl.id`;

const TENDERS_SQL = `
  SELECT method, amount::text AS amount, reference, sequence
    FROM sale_tenders WHERE sale_id = $1 AND tenant_id = $2 AND store_id = $3
   ORDER BY sequence NULLS LAST, method, tender_ref, id`;

/**
 * The void, its approver's role and the reversal posting of the void
 * (`source_ref_id` = the void row). The role is not stored on the void, so it
 * is the approver's CURRENT approver-role membership, and only when exactly
 * one exists; otherwise null, never a guess.
 */
const VOID_SQL = `
  SELECT v.voided_at, v.void_business_date::text AS void_business_date,
         v.approval_id IS NOT NULL AS approved,
         (SELECT CASE WHEN count(*) = 1 THEN min(r.code) END
            FROM memberships m JOIN roles r ON r.id = m.role_id
           WHERE m.tenant_id = v.tenant_id AND m.user_id = v.approved_by_user_id
             AND m.revoked_at IS NULL AND m.deleted_at IS NULL
             AND r.code IN ('owner', 'tenant_admin', 'store_manager')) AS approver_role,
         p.status AS reversal_status, p.document_ref AS reversal_document_ref
    FROM sale_voids v
    LEFT JOIN erpnext_posting_status p
           ON p.tenant_id = v.tenant_id AND p.kind = 'reversal' AND p.source_ref_id = v.id
   WHERE v.sale_id = $1 AND v.tenant_id = $2 AND v.store_id = $3`;

const RETURNS_SQL = `
  SELECT r.id::text AS return_ref, r.returned_at AS recorded_at, r.business_date::text AS business_date,
         r.return_total::text AS return_total,
         COALESCE(
           (SELECT json_agg(json_build_object('line_ref', rl.sale_line_id::text,
                                              'quantity', rl.quantity::text,
                                              'line_amount', rl.line_amount::text)
                            ORDER BY rl.id)
              FROM sale_return_lines rl WHERE rl.return_id = r.id),
           '[]'::json) AS lines
    FROM sale_returns r
   WHERE r.sale_id = $1 AND r.tenant_id = $2 AND r.store_id = $3
   ORDER BY r.return_seq`;

export interface SaleQuery {
  readonly where: string[];
  readonly params: unknown[];
}

/** tenant, store and visibility: the predicates every read carries. */
export function scopedQuery(scope: SaleHistoryScope): SaleQuery {
  const q: SaleQuery = { where: ["s.tenant_id = $1", "s.store_id = $2"], params: [scope.tenantId, scope.storeId] };
  if (scope.visibility.kind === "own_sales") addPredicate(q, "s.created_by = $?", scope.visibility.userId);
  return q;
}

function addPredicate(q: SaleQuery, sql: string, ...values: unknown[]): void {
  let next = q.params.length;
  q.where.push(sql.replace(/\$\?/g, () => `$${(next += 1)}`));
  q.params.push(...values);
}

export function listQuery(input: ListSaleHistoryInput, keyset: SaleHistoryKeyset | null): SaleQuery {
  const q = scopedQuery(input);
  const { filters } = input;
  addPredicate(q, "s.business_date BETWEEN $?::date AND $?::date", filters.from, filters.to);
  if (filters.deviceRef !== null) addPredicate(q, "s.device_id = $?", filters.deviceRef);
  if (filters.operatorUserId !== null) addPredicate(q, "s.created_by = $?", filters.operatorUserId);
  if (filters.saleNumber !== null) addPredicate(q, "s.receipt_sale_number = $?", filters.saleNumber);
  if (keyset !== null) {
    addPredicate(
      q,
      "(s.business_date, s.occurred_at, s.id) < ($?::date, $?::timestamptz, $?::uuid)",
      keyset.businessDate,
      keyset.occurredAtKey,
      keyset.saleId,
    );
  }
  return q;
}

export interface LoadedDetail {
  readonly row: SaleHistoryDetailRow;
  readonly projection: SaleHistoryDetail;
}

/** The detail of a visible sale, or null when it does not resolve within the caller's visibility. */
export async function loadDetail(client: PoolClient, scope: SaleHistoryScope, saleRef: string): Promise<LoadedDetail | null> {
  const q = scopedQuery(scope);
  addPredicate(q, "s.id = $?", saleRef);
  const sale = await client.query<SaleHistoryDetailRow & { tender_count: number }>(
    `${SALE_SELECT_SQL} WHERE ${q.where.join(" AND ")}`,
    q.params,
  );
  const row = sale.rows[0];
  if (row === undefined) return null;

  const child = [saleRef, scope.tenantId, scope.storeId];
  const lines = await client.query<DetailLineRow>(LINES_SQL, child);
  // A tender-unknown sale (tender_count 0, every legacy sale) never reads sale_tenders.
  const tenders = row.tender_count > 0 ? (await client.query<DetailTenderRow>(TENDERS_SQL, child)).rows : [];
  if (tenders.length !== row.tender_count) {
    // Never present a partial tender list as the sale's tenders.
    throw new Error("sale history: the sale's tenders are not all visible");
  }
  const voidRow = row.voided ? ((await client.query<DetailVoidRow>(VOID_SQL, child)).rows[0] ?? null) : null;
  const returns = row.return_state === "none" ? [] : (await client.query<DetailReturnRow>(RETURNS_SQL, child)).rows;
  return {
    row,
    projection: toSaleHistoryDetail({ sale: row, lines: lines.rows, tenders, voidRow, returns }),
  };
}
