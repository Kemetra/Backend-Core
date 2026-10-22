/**
 * SaleReturnsService — line-aware returns (Jira RT-73; RT-14 D1–D3).
 *
 * One transaction per return, under the tenant GUC (RLS) and the `sales` row
 * lock (`lockSaleForReversal`), in this order:
 *   1. lock the sale (non-disclosing 404 outside scope);
 *   2. provenance replay FIRST — a re-delivery must replay (200) even after
 *      later returns used the line up; the same provenance with a different
 *      payload or sale is a 409;
 *   3. D2: a voided sale cannot be returned;
 *   4. price every line from the frozen sale line in Postgres `numeric` by the
 *      cumulative-difference rule round4(A×(c+q)/Q) − round4(A×c/Q) (option
 *      (a), RT-73 comment 10406), rejecting unknown lines, a fractional q on a
 *      line sold in a whole quantity (RT-105) and over-returns;
 *      RT-787 (RT-490 rule 1): an `originalTenderRef` must be a tender of the
 *      sale, a 400 checked before the line checks' 409 `over_return`;
 *   5. D3: the refund tenders must sum (numerically) to the computed total;
 *      then RT-787 rules 2 and 3 (R-12 instrument, R-5 refundable balance);
 *   6. insert the return (per-sale `return_seq`, own business date — RT-63
 *      P2), its lines (with the frozen cumulative quantity) and its refund
 *      allocations (RT-271 R-2);
 *   7. RT-427: write the return's Inventory Effects (a no-op while the
 *      tenant's sale effects are OFF), landing in the tenant's return landing
 *      status;
 *   8. emit `erpnext.posting.requested` (kind reversal, source_ref_id = the
 *      return) in the same transaction, unless the return is deferred to its
 *      settlement (RT-787, R-7): the settle-before-post flag is on, its
 *      allocations carry `allocationRef` and its total is not 0. A deferred
 *      return is emitted by the execution that settles it
 *      (`RefundExecutionsService`).
 * The response is always re-read from the stored rows, so a replay is
 * byte-identical to the original response.
 */
import { Inject, Injectable } from "@nestjs/common";
import { emit, OUTBOX_EVENT_TYPES, runWithTenantContext, writeReturnEffects } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import { resolveReturnLandingStatus } from "../../inventory/position-events/position-events.service";
import { SaleEffectsReport } from "../../inventory/sale-effects/sale-effects-report";
import type { RecordReturnRequestDto } from "./dto/record-return-request.dto";
import { sha256CanonicalHex } from "./payload-hash";
import { assertAllocationRules, assertOriginalTendersOfSale } from "./refund-allocation";
import { isRefundSettleBeforePostEnabled } from "./refund-gates";
import { TerminalEventProvenanceConflictError } from "./sale-errors";
import {
  assertNotCreditSale,
  lockSaleForReversal,
  readReversalState,
  ReturnLineInvalidError,
  ReturnOverReturnError,
  ReturnQuantityNotWholeError,
  ReturnTenderMismatchError,
  SaleAlreadyReversedError,
  type LockedSale,
} from "./sale-reversal";

export interface RecordReturnInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  readonly saleRef: string;
  readonly body: RecordReturnRequestDto;
}

export interface ReturnLineProjection {
  readonly lineRef: string;
  readonly quantity: string;
  readonly lineAmount: string;
  readonly taxAmount: string | null;
  readonly returnedQuantity: string;
  readonly returnableQuantity: string;
}

/** Wire projection of a recorded return (contract `SaleReturn`). */
export interface SaleReturnProjection {
  readonly returnRef: string;
  readonly saleRef: string;
  readonly recordedAt: string;
  readonly businessDate: string;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly currencyCode: string;
  readonly returnTotal: string;
  readonly lines: ReadonlyArray<ReturnLineProjection>;
  readonly refundTenders: ReadonlyArray<RefundAllocationProjection>;
  readonly reason: string | null;
}

/** One refund allocation (contract `RefundTender`); the RT-490 fields only when recorded. */
export interface RefundAllocationProjection {
  readonly method: string;
  readonly amount: string;
  readonly allocationRef?: string;
  readonly originalTenderRef?: string;
  readonly instrument?: string;
}

export interface SaleReturnResult {
  readonly projection: SaleReturnProjection;
  /** false when a re-delivery resolved to an existing return. */
  readonly created: boolean;
}

export interface PricedLine {
  readonly lineRef: string;
  readonly quantity: string;
  readonly lineAmount: string;
  readonly taxAmount: string | null;
  readonly returnedAfter: string;
}

@Injectable()
export class SaleReturnsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async recordReturn(input: RecordReturnInput): Promise<SaleReturnResult> {
    const { tenantId, saleRef, body } = input;
    const payloadHash = sha256CanonicalHex(body);
    // RT-427: skipped return effects are reported after COMMIT only.
    const effects = new SaleEffectsReport();
    const result = await runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<SaleReturnResult> => {
        const sale = await lockSaleForReversal(client, saleRef, input.storeId);
        // RT-577: a return a credit reversal created is never replayed here; on
        // its own sale the call falls through to the credit refusal below.
        const existing = await findReturnByProvenance(client, tenantId, body);
        if (existing && !(existing.credit_linked && existing.sale_id === saleRef)) {
          return replay(client, existing, saleRef, payloadHash);
        }

        const { lines, total } = await admitReturn(client, { sale, saleRef, body });
        const postingDeferred = isPostingDeferred(body, total);
        const returnId = await insertReturn(client, { input, sale, total, payloadHash, postingDeferred });
        if (!returnId) {
          // The same provenance was recorded concurrently against another sale.
          const winner = await findReturnByProvenance(client, tenantId, body);
          if (!winner) throw new Error("return conflict but no existing return found");
          // RT-577: a credit reversal's return is never an ordinary replay.
          if (winner.credit_linked) throw new TerminalEventProvenanceConflictError();
          return replay(client, winner, saleRef, payloadHash);
        }
        await insertLinesAndTenders(client, input, returnId, lines);
        const scope = { tenantId, storeId: input.storeId, saleId: saleRef };
        const resolveLandingStatus = (c: PoolClient) => resolveReturnLandingStatus(c, tenantId);
        effects.add(await writeReturnEffects(client, { ...scope, returnId, resolveLandingStatus }), {
          ...scope,
          eventRefId: returnId,
        });
        if (!postingDeferred) {
          await emitReturnPosting(client, { tenantId, storeId: input.storeId, saleRef, returnId });
        }
        return { projection: await loadSaleReturn(client, returnId), created: true };
      },
    );
    effects.flush();
    return result;
  }
}

/**
 * Every refusal of a new return, in the contract's order (nothing is written
 * yet): RT-577 credit sale (403), D2 voided (409), RT-490 rule 1 tender refs
 * and the line checks (400, then 409 over_return), D3 (422), then RT-490
 * rules 2 and 3 (422). Returns the priced lines and the return total.
 */
async function admitReturn(
  client: PoolClient,
  args: { sale: LockedSale; saleRef: string; body: RecordReturnRequestDto },
): Promise<{ lines: PricedLine[]; total: string }> {
  const { sale, saleRef, body } = args;
  // RT-577: a credit sale is refused for every operator, before exclusivity
  // and the line and tender checks.
  assertNotCreditSale(sale);
  if ((await readReversalState(client, saleRef)).voided) {
    throw new SaleAlreadyReversedError();
  }
  await assertOriginalTendersOfSale(client, saleRef, body.refundTenders);
  const lines = await priceReturnLines(client, saleRef, body.lines);
  const total = await totalMatchingTenders(client, lines, body.refundTenders);
  await assertAllocationRules(client, saleRef, body.refundTenders);
  return { lines, total };
}

/**
 * R-7 (RT-787): the return waits for its settlement when the flag is on at
 * acceptance, its allocations carry `allocationRef` (rule 1: all or none) and
 * it owes something. Decided once and stored, so a later flag flip never
 * strands it or emits it twice.
 */
function isPostingDeferred(body: RecordReturnRequestDto, total: string): boolean {
  if (!isRefundSettleBeforePostEnabled()) return false;
  if (body.refundTenders[0]?.allocationRef === undefined) return false;
  return /[1-9]/.test(total);
}

/** The return's `reversal` posting intent, the event every reversal path emits. */
export async function emitReturnPosting(
  client: PoolClient,
  ref: { tenantId: string; storeId: string; saleRef: string; returnId: string },
): Promise<void> {
  await emit(client, {
    eventType: OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED,
    tenantId: ref.tenantId,
    storeId: ref.storeId,
    payload: {
      sale_id: ref.saleRef,
      store_id: ref.storeId,
      kind: "reversal",
      source_ref_id: ref.returnId,
    },
    correlationId: null,
  });
}

interface ReturnProvenanceRow {
  readonly id: string;
  readonly sale_id: string;
  readonly payload_hash: string;
  /** RT-577: the return a credit reversal created (never replayed by recordReturn). */
  readonly credit_linked: boolean;
}

async function findReturnByProvenance(
  client: PoolClient,
  tenantId: string,
  body: RecordReturnRequestDto,
): Promise<ReturnProvenanceRow | null> {
  const r = await client.query<ReturnProvenanceRow>(
    `SELECT r.id, r.sale_id, r.payload_hash,
            EXISTS (SELECT 1 FROM sale_credit_reversals c WHERE c.return_id = r.id) AS credit_linked
       FROM sale_returns r
      WHERE r.tenant_id = $1 AND r.source_system = $2 AND r.external_id = $3`,
    [tenantId, body.sourceSystem, body.externalId],
  );
  return r.rows[0] ?? null;
}

async function replay(
  client: PoolClient,
  existing: { id: string; sale_id: string; payload_hash: string },
  saleRef: string,
  payloadHash: string,
): Promise<SaleReturnResult> {
  // A replay only if it is the SAME return: same sale and same payload.
  if (existing.sale_id !== saleRef || existing.payload_hash !== payloadHash) {
    throw new TerminalEventProvenanceConflictError();
  }
  return { projection: await loadSaleReturn(client, existing.id), created: false };
}

/**
 * Price each requested line from its frozen sale line, in request order.
 * c = quantity already returned on the line (under the sale lock, so stable).
 */
export async function priceReturnLines(
  client: PoolClient,
  saleRef: string,
  lines: RecordReturnRequestDto["lines"],
): Promise<PricedLine[]> {
  const r = await client.query<{
    line_ref: string;
    found: boolean;
    fractional: boolean | null;
    over: boolean | null;
    quantity: string;
    line_amount: string | null;
    tax_amount: string | null;
    returned_after: string | null;
  }>(
    `WITH req AS (
       SELECT line_ref, qty, ord
         FROM unnest($2::uuid[], $3::numeric[]) WITH ORDINALITY AS t(line_ref, qty, ord)
     ), priced AS (
       SELECT req.ord, req.line_ref, req.qty, sl.id IS NOT NULL AS found,
              sl.quantity AS sold, sl.line_amount AS a, sl.tax_amount AS t,
              COALESCE((SELECT SUM(rl.quantity) FROM sale_return_lines rl
                         WHERE rl.sale_line_id = sl.id), 0) AS c
         FROM req
         LEFT JOIN sale_lines sl ON sl.id = req.line_ref AND sl.sale_id = $1
     )
     SELECT line_ref::text AS line_ref, found,
            -- RT-105: a line sold in a whole quantity returns in whole
            -- quantities only, so a conforming line prices to exactly u × q.
            (sold = trunc(sold) AND qty <> trunc(qty)) AS fractional,
            (c + qty > sold) AS over,
            qty::numeric(19,6)::text AS quantity,
            CASE WHEN found AND c + qty <= sold THEN
              (round(a * (c + qty) / sold, 4) - round(a * c / sold, 4))::numeric(19,4)::text
            END AS line_amount,
            CASE WHEN found AND c + qty <= sold AND t IS NOT NULL THEN
              (round(t * (c + qty) / sold, 4) - round(t * c / sold, 4))::numeric(19,4)::text
            END AS tax_amount,
            -- Cast only rows within the sold quantity: an over-return near the
            -- numeric(19,6) bound would otherwise raise 22003 before the
            -- service can answer 409 over_return.
            CASE WHEN found AND c + qty <= sold THEN
              (c + qty)::numeric(19,6)::text
            END AS returned_after
       FROM priced ORDER BY ord`,
    [saleRef, lines.map((l) => l.lineRef), lines.map((l) => l.quantity)],
  );
  if (r.rows.some((row) => !row.found)) throw new ReturnLineInvalidError();
  if (r.rows.some((row) => row.fractional)) throw new ReturnQuantityNotWholeError();
  if (r.rows.some((row) => row.over)) throw new ReturnOverReturnError();
  return r.rows.map((row) => ({
    lineRef: row.line_ref,
    quantity: row.quantity,
    lineAmount: row.line_amount!,
    taxAmount: row.tax_amount,
    returnedAfter: row.returned_after!,
  }));
}

/** Σ line amounts, and D3: the tenders must equal it numerically ("5" = "5.0000"). */
async function totalMatchingTenders(
  client: PoolClient,
  lines: ReadonlyArray<PricedLine>,
  tenders: RecordReturnRequestDto["refundTenders"],
): Promise<string> {
  const r = await client.query<{ total: string; matches: boolean }>(
    `SELECT (SELECT SUM(a) FROM unnest($1::numeric[]) a)::numeric(19,4)::text AS total,
            (SELECT SUM(a) FROM unnest($1::numeric[]) a)
              = (SELECT SUM(t) FROM unnest($2::numeric[]) t) AS matches`,
    [lines.map((l) => l.lineAmount), tenders.map((t) => t.amount)],
  );
  const row = r.rows[0];
  if (!row?.matches) throw new ReturnTenderMismatchError();
  return row.total;
}

interface NewReturnHeader {
  readonly input: RecordReturnInput;
  readonly sale: LockedSale;
  readonly total: string;
  readonly payloadHash: string;
  readonly postingDeferred: boolean;
}

/** Insert the header; null when the provenance already exists (a race). */
async function insertReturn(
  client: PoolClient,
  { input, sale, total, payloadHash, postingDeferred }: NewReturnHeader,
): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO sale_returns
       (id, sale_id, tenant_id, store_id, return_seq, business_date,
        currency_code, return_total, reason, source_system, external_id,
        payload_hash, created_by, posting_deferred)
     VALUES ($1, $2, $3, $4,
             (SELECT COALESCE(MAX(return_seq), 0) + 1 FROM sale_returns WHERE sale_id = $2),
             (now() AT TIME ZONE $5)::date,
             $6, $7::numeric, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING
     RETURNING id`,
    [
      newId(),
      input.saleRef,
      input.tenantId,
      input.storeId,
      sale.timezone,
      sale.currencyCode,
      total,
      input.body.reason ?? null,
      input.body.sourceSystem,
      input.body.externalId,
      payloadHash,
      input.actorUserId,
      postingDeferred,
    ],
  );
  return r.rows[0]?.id ?? null;
}

async function insertLinesAndTenders(
  client: PoolClient,
  input: RecordReturnInput,
  returnId: string,
  lines: ReadonlyArray<PricedLine>,
): Promise<void> {
  for (const l of lines) {
    await client.query(
      `INSERT INTO sale_return_lines
         (id, return_id, sale_line_id, tenant_id, store_id, quantity,
          line_amount, tax_amount, returned_quantity_after)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::numeric)`,
      [newId(), returnId, l.lineRef, input.tenantId, input.storeId, l.quantity,
        l.lineAmount, l.taxAmount, l.returnedAfter],
    );
  }
  for (const [ordinal, t] of input.body.refundTenders.entries()) {
    await client.query(
      `INSERT INTO sale_return_tenders
         (id, return_id, tenant_id, store_id, ordinal, method, amount,
          allocation_ref, original_tender_ref, instrument)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10)`,
      [newId(), returnId, input.tenantId, input.storeId, ordinal, t.method, t.amount,
        t.allocationRef ?? null, t.originalTenderRef ?? null, t.instrument ?? null],
    );
  }
}

/** Build the `SaleReturn` projection from the stored rows (replay-stable). */
export async function loadSaleReturn(client: PoolClient, returnId: string): Promise<SaleReturnProjection> {
  const header = await client.query<{
    sale_id: string;
    returned_at: Date;
    business_date: string;
    source_system: string;
    external_id: string;
    currency_code: string;
    return_total: string;
    reason: string | null;
  }>(
    `SELECT sale_id, returned_at, business_date::text AS business_date,
            source_system, external_id, currency_code,
            return_total::text AS return_total, reason
       FROM sale_returns WHERE id = $1`,
    [returnId],
  );
  const h = header.rows[0];
  if (!h) throw new Error("return row not found");
  const lines = await client.query<{
    line_ref: string;
    quantity: string;
    line_amount: string;
    tax_amount: string | null;
    returned: string;
    returnable: string;
  }>(
    `SELECT rl.sale_line_id::text AS line_ref, rl.quantity::text AS quantity,
            rl.line_amount::text AS line_amount, rl.tax_amount::text AS tax_amount,
            rl.returned_quantity_after::text AS returned,
            (sl.quantity - rl.returned_quantity_after)::numeric(19,6)::text AS returnable
       FROM sale_return_lines rl JOIN sale_lines sl ON sl.id = rl.sale_line_id
      WHERE rl.return_id = $1 ORDER BY rl.sale_line_id`,
    [returnId],
  );
  return {
    returnRef: returnId,
    saleRef: h.sale_id,
    recordedAt: h.returned_at.toISOString(),
    businessDate: h.business_date,
    sourceSystem: h.source_system,
    externalId: h.external_id,
    currencyCode: h.currency_code,
    returnTotal: h.return_total,
    lines: lines.rows.map((l) => ({
      lineRef: l.line_ref,
      quantity: l.quantity,
      lineAmount: l.line_amount,
      taxAmount: l.tax_amount,
      returnedQuantity: l.returned,
      returnableQuantity: l.returnable,
    })),
    refundTenders: await loadRefundAllocations(client, returnId),
    reason: h.reason,
  };
}

/** The return's refund allocations in request order; the RT-490 fields only when recorded (never null). */
async function loadRefundAllocations(
  client: PoolClient,
  returnId: string,
): Promise<RefundAllocationProjection[]> {
  const r = await client.query<{
    method: string;
    amount: string;
    allocation_ref: string | null;
    original_tender_ref: string | null;
    instrument: string | null;
  }>(
    `SELECT method, amount::text AS amount, allocation_ref::text AS allocation_ref,
            original_tender_ref::text AS original_tender_ref, instrument
       FROM sale_return_tenders
      WHERE return_id = $1 ORDER BY ordinal`,
    [returnId],
  );
  return r.rows.map((t) => ({
    method: t.method,
    amount: t.amount,
    ...(t.allocation_ref === null ? {} : { allocationRef: t.allocation_ref }),
    ...(t.original_tender_ref === null ? {} : { originalTenderRef: t.original_tender_ref }),
    ...(t.instrument === null ? {} : { instrument: t.instrument }),
  }));
}
