/**
 * refund-allocation.ts — the RT-490 refund allocation rules on `recordReturn`
 * (Jira RT-787; RT-271 R-5, R-6, R-12; `pos-sales/sales.yaml` 1.13.0-draft,
 * Allocation rules). Every check runs inside the return's transaction, under
 * the `sales` row lock `lockSaleForReversal` took, so the balances it reads
 * cannot move until COMMIT. Money stays in Postgres `numeric`, never a float.
 */
import type { PoolClient } from "pg";

import type { RecordReturnRequestDto } from "./dto/record-return-request.dto";

type Allocations = RecordReturnRequestDto["refundTenders"];

/** Rule 1: an `originalTenderRef` is not a tender of this sale → 400 validation_error. */
export class RefundAllocationTenderInvalidError extends Error {
  constructor() {
    super("originalTenderRef is not a tender of this sale");
    this.name = "RefundAllocationTenderInvalidError";
  }
}

/** Rule 2 (R-12): the sale carries a non-cash tender → 422 refund_instrument_not_allowed. */
export class RefundInstrumentNotAllowedError extends Error {
  constructor() {
    super("pilot returns are cash-only, for all-cash sales only");
    this.name = "RefundInstrumentNotAllowedError";
  }
}

/** Rule 3 (R-5): an allocation exceeds a tender's refundable balance → 422. */
export class RefundAllocationExceedsTenderError extends Error {
  constructor() {
    super("the allocations exceed a tender's refundable balance");
    this.name = "RefundAllocationExceedsTenderError";
  }
}

/**
 * Rule 1: every `originalTenderRef` names a tender line of THIS sale. Checked
 * with the line checks (400), before the 409 `over_return`. A tender-unknown
 * sale has no tender a ref can name (rule 4).
 */
export async function assertOriginalTendersOfSale(
  client: PoolClient,
  saleRef: string,
  allocations: Allocations,
): Promise<void> {
  const refs = [...new Set(allocations.flatMap((a) => (a.originalTenderRef ? [a.originalTenderRef] : [])))];
  if (refs.length === 0) return;
  const r = await client.query<{ found: string }>(
    `SELECT count(*)::text AS found FROM sale_tenders
      WHERE sale_id = $1 AND tender_ref = ANY($2::uuid[])`,
    [saleRef, refs],
  );
  if (Number(r.rows[0]?.found ?? 0) !== refs.length) throw new RefundAllocationTenderInvalidError();
}

/**
 * Rules 2 and 3, in that order, after `return_tender_mismatch`. On a
 * tender-unknown sale (`tender_count = 0`) neither applies (rule 4, R-6): the
 * per-line quantity cap is the only cap.
 */
export async function assertAllocationRules(
  client: PoolClient,
  saleRef: string,
  allocations: Allocations,
): Promise<void> {
  const sale = await client.query<{ tender_count: number; non_cash: boolean }>(
    `SELECT s.tender_count,
            EXISTS (SELECT 1 FROM sale_tenders t WHERE t.sale_id = s.id AND t.method <> 'cash') AS non_cash
       FROM sales s WHERE s.id = $1`,
    [saleRef],
  );
  const row = sale.rows[0];
  if (!row || Number(row.tender_count) === 0) return;
  if (row.non_cash) throw new RefundInstrumentNotAllowedError();
  if (!(await withinRefundableBalances(client, saleRef, allocations))) {
    throw new RefundAllocationExceedsTenderError();
  }
}

/**
 * Rule 3 over every accepted return of the sale, this one included:
 *   - per referenced tender T: T.amount − Σ allocations referencing T ≥ 0;
 *   - the cash pool: Σ every cash allocation (referenced or not) + Σ legacy
 *     `recordRefund` amounts ≤ Σ the sale's cash tenders (RT-264 D2).
 * Allocated amounts count, never settled ones (R-5).
 */
async function withinRefundableBalances(
  client: PoolClient,
  saleRef: string,
  allocations: Allocations,
): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>(
    `WITH req AS (
       SELECT amount, tender_ref
         FROM unnest($2::numeric[], $3::uuid[]) AS t(amount, tender_ref)
     ), recorded AS (
       SELECT rt.amount, rt.original_tender_ref AS tender_ref
         FROM sale_return_tenders rt JOIN sale_returns r ON r.id = rt.return_id
        WHERE r.sale_id = $1
     ), allocated AS (
       SELECT amount, tender_ref FROM req UNION ALL SELECT amount, tender_ref FROM recorded
     ), per_tender AS (
       SELECT t.amount - COALESCE((SELECT SUM(a.amount) FROM allocated a WHERE a.tender_ref = t.tender_ref), 0)
                AS remaining
         FROM sale_tenders t
        WHERE t.sale_id = $1 AND t.tender_ref IN (SELECT tender_ref FROM req WHERE tender_ref IS NOT NULL)
     )
     SELECT NOT EXISTS (SELECT 1 FROM per_tender WHERE remaining < 0)
            AND (SELECT COALESCE(SUM(amount), 0) FROM allocated)
              + (SELECT COALESCE(SUM(pos_refund_amount), 0) FROM sale_refunds WHERE sale_id = $1)
              <= (SELECT COALESCE(SUM(amount), 0) FROM sale_tenders WHERE sale_id = $1 AND method = 'cash')
            AS ok`,
    [saleRef, allocations.map((a) => a.amount), allocations.map((a) => a.originalTenderRef ?? null)],
  );
  return r.rows[0]?.ok === true;
}
