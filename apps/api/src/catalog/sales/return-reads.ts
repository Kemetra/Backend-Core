/**
 * return-reads.ts — the RT-490 return read model (Jira RT-787; RT-271 R-1,
 * R-8): a recorded return with its refund settlement, and the refund
 * execution projection.
 *
 * The settlement is DERIVED from the append-only acceptance, allocation and
 * execution rows, never stored (RT-277): a return whose total is 0 is
 * `settled`; one whose allocations carry no `allocationRef` is untracked
 * (null); otherwise `open`, `partially_settled` or `settled` from the sum of
 * its settled executions. Every read runs under the caller's tenant GUC; the
 * caller resolves the sale in its (tenant, store) scope first.
 */
import type { PoolClient } from "pg";

import { loadSaleReturn, type SaleReturnProjection } from "./sale-returns.service";

/** Wire projection of a recorded refund execution (contract `RefundExecution`). */
export interface RefundExecutionProjection {
  readonly executionRef: string;
  readonly returnRef: string;
  readonly saleRef: string;
  readonly allocationRef: string;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly instrument: string;
  readonly amount: string;
  readonly currencyCode: string;
  readonly outcome: string;
  readonly evidence: { readonly method: string; readonly paidAt: string; readonly shiftRef: string };
  readonly recordedAt: string;
}

export interface RefundSettlementProjection {
  readonly state: "open" | "partially_settled" | "settled";
  readonly settledAmount: string;
  readonly executions: ReadonlyArray<RefundExecutionProjection>;
}

/** Contract `ReturnRead`. */
export interface ReturnReadProjection {
  readonly saleReturn: SaleReturnProjection;
  readonly settlement: RefundSettlementProjection | null;
}

interface ExecutionRow {
  readonly execution_ref: string;
  readonly return_id: string;
  readonly sale_id: string;
  readonly allocation_ref: string;
  readonly source_system: string;
  readonly external_id: string;
  readonly instrument: string;
  readonly amount: string;
  readonly currency_code: string;
  readonly outcome: string;
  readonly evidence_method: string;
  readonly paid_at: Date;
  readonly shift_ref: string;
  readonly recorded_at: Date;
}

const EXECUTION_COLUMNS = `
  e.execution_ref::text AS execution_ref, e.return_id::text AS return_id, e.sale_id::text AS sale_id,
  e.allocation_ref::text AS allocation_ref, e.source_system, e.external_id,
  COALESCE(a.instrument, 'cash') AS instrument, e.amount::text AS amount, r.currency_code,
  e.outcome, e.evidence_method, e.paid_at, e.shift_ref::text AS shift_ref, e.recorded_at`;

const EXECUTION_FROM = `
  FROM refund_executions e
  JOIN sale_return_tenders a ON a.id = e.allocation_id
  JOIN sale_returns r ON r.id = e.return_id`;

function toExecution(row: ExecutionRow): RefundExecutionProjection {
  return {
    executionRef: row.execution_ref,
    returnRef: row.return_id,
    saleRef: row.sale_id,
    allocationRef: row.allocation_ref,
    sourceSystem: row.source_system,
    externalId: row.external_id,
    instrument: row.instrument,
    amount: row.amount,
    currencyCode: row.currency_code,
    outcome: row.outcome,
    evidence: { method: row.evidence_method, paidAt: row.paid_at.toISOString(), shiftRef: row.shift_ref },
    recordedAt: row.recorded_at.toISOString(),
  };
}

/** One execution by its server id (replay-stable: re-read from the stored row). */
export async function loadRefundExecution(client: PoolClient, executionId: string): Promise<RefundExecutionProjection> {
  const r = await client.query<ExecutionRow>(`SELECT ${EXECUTION_COLUMNS} ${EXECUTION_FROM} WHERE e.id = $1`, [
    executionId,
  ]);
  const row = r.rows[0];
  if (!row) throw new Error("refund execution row not found");
  return toExecution(row);
}

/** The refund obligation of one return, derived (never stored). */
export async function loadSettlement(client: PoolClient, returnId: string): Promise<RefundSettlementProjection | null> {
  const head = await client.query<{ zero: boolean; tracked: boolean; settled: string; complete: boolean }>(
    `SELECT r.return_total = 0 AS zero,
            EXISTS (SELECT 1 FROM sale_return_tenders a
                     WHERE a.return_id = r.id AND a.allocation_ref IS NOT NULL) AS tracked,
            COALESCE((SELECT SUM(e.amount) FROM refund_executions e WHERE e.return_id = r.id), 0)
              ::numeric(19,4)::text AS settled,
            COALESCE((SELECT SUM(e.amount) FROM refund_executions e WHERE e.return_id = r.id), 0)
              >= r.return_total AS complete
       FROM sale_returns r WHERE r.id = $1`,
    [returnId],
  );
  const h = head.rows[0];
  if (!h) throw new Error("return row not found");
  if (!h.zero && !h.tracked) return null;
  const executions = await client.query<ExecutionRow>(
    `SELECT ${EXECUTION_COLUMNS} ${EXECUTION_FROM}
      WHERE e.return_id = $1 ORDER BY e.recorded_at, e.execution_ref`,
    [returnId],
  );
  return {
    state: settlementState(h.complete, executions.rows.length),
    settledAmount: h.settled,
    executions: executions.rows.map(toExecution),
  };
}

/** `settled` once the executions reach the return total; else `open` until the first one. */
function settlementState(complete: boolean, executionCount: number): RefundSettlementProjection["state"] {
  if (complete) return "settled";
  return executionCount === 0 ? "open" : "partially_settled";
}

/** A return with its settlement (contract `ReturnRead`). */
export async function loadReturnRead(client: PoolClient, returnId: string): Promise<ReturnReadProjection> {
  return { saleReturn: await loadSaleReturn(client, returnId), settlement: await loadSettlement(client, returnId) };
}

/**
 * The sale's `recordReturn` returns, oldest first (`recordedAt`, then
 * `returnRef`). A credit reversal's return (RT-577) is outside RT-490 and is
 * not listed.
 */
export async function listOrdinaryReturnIds(client: PoolClient, saleRef: string): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `SELECT r.id::text AS id FROM sale_returns r
      WHERE r.sale_id = $1
        AND NOT EXISTS (SELECT 1 FROM sale_credit_reversals c WHERE c.return_id = r.id)
      ORDER BY r.returned_at, r.id`,
    [saleRef],
  );
  return r.rows.map((row) => row.id);
}

/** The `recordReturn` return of THIS sale with that provenance, or null. */
export async function findOrdinaryReturnByProvenance(
  client: PoolClient,
  saleRef: string,
  provenance: { readonly sourceSystem: string; readonly externalId: string },
): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `SELECT r.id::text AS id FROM sale_returns r
      WHERE r.sale_id = $1 AND r.source_system = $2 AND r.external_id = $3
        AND NOT EXISTS (SELECT 1 FROM sale_credit_reversals c WHERE c.return_id = r.id)`,
    [saleRef, provenance.sourceSystem, provenance.externalId],
  );
  return r.rows[0]?.id ?? null;
}
