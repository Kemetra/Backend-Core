/**
 * posting-work-item.projection.ts — the 012 work-item WIRE SHAPE (PULL side).
 *
 * The DP2 posting pipeline resolves item/warehouse identity at TWO moments,
 * deliberately split (the 012 contract's idempotent-replay obligation forbids a
 * write side-effect on the GET feed):
 *
 *   1. ELIGIBILITY — at row CREATION. Owned by the worker
 *      `PostingRequestedConsumer.resolveEligibility` (apps/worker): it joins each
 *      line → a CONFIRMED `erpnext_item_map` + the store → `erpnext_warehouse_map`
 *      and inserts a `pending` (resolvable) or `permanently_rejected` row BEFORE
 *      the work-item is offered (rider R2). That logic lives THERE, not here — the
 *      worker cannot import api code, and only one live copy must exist.
 *
 *   2. WIRE ASSEMBLY — at PULL (this file, `buildWorkItem()`). A pure read: it
 *      re-joins an already-`pending` row's sale + frozen lines + confirmed
 *      item-map to populate the 012 `PostingWorkItem` (each line's
 *      `erpnextItemRef`). NO status mutation → re-pulling the same cursor yields
 *      the same logical set (012 idempotent replay).
 *
 * All queries run under the caller's tenant GUC (the caller wraps in
 * `runWithTenantContext`); RLS does the tenant scoping.
 */
import type { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Wire shape — the 012 PostingWorkItem (subset 015 populates in the interim mode)
// ---------------------------------------------------------------------------

/** A 012 SaleLine projection line. */
export interface WorkItemLine {
  /** RT-73: stable line identity (= sale_lines.id); return lines point at it (RT-14 D6). */
  readonly lineRef: string;
  readonly lineName: string;
  readonly unitPrice: string;
  readonly currencyCode: string;
  readonly quantity: string;
  readonly lineAmount: string;
  readonly taxAmount: string | null;
  readonly unit: string;
  /**
   * The DP2-resolved ERPNext Item identity (required on every OFFERED line). The 012
   * `ErpnextItemRef` is an OBJECT `{ doctype: "Item", name }` (generic doctype+name addressing,
   * O-6), NOT a bare string — `name` is the Item code. (Issue #506: this previously emitted the
   * raw `erpnext_item_ref` string, which a conforming consumer cannot parse.)
   */
  readonly erpnextItemRef: { readonly doctype: "Item"; readonly name: string };
  readonly tenantProductRef: string | null;
}

/** RT-73: one returned line, a non-negative magnitude priced by Backend-Core. */
export interface ReturnWorkLine {
  readonly lineRef: string;
  readonly quantity: string;
  readonly lineAmount: string;
  readonly taxAmount: string | null;
}

/**
 * RT-86: a `return` whose recorded refund tenders are not visible to the feed. Capture always
 * stores >= 1 (RT-73), so this is a visibility fault (e.g. an RLS policy mismatch), not data.
 * Thrown rather than omitting the item: the pull fails and its cursor does not advance, so the
 * return is neither offered without its tenders nor skipped past (Codex P1/P2, PR #652).
 */
export class ReturnTendersNotVisibleError extends Error {
  constructor(returnId: string) {
    super(`return ${returnId} has no visible refund tenders; refusing to offer it without them (RT-86)`);
    this.name = "ReturnTendersNotVisibleError";
  }
}

/**
 * RT-77: a sale whose VISIBLE `sale_tenders` rows differ from the `sales.tender_count` capture
 * wrote in the same transaction — a visibility fault (an RLS or grant gap), not data. Thrown
 * rather than offering the item: a tender-bearing sale offered without its tenders is posted
 * unpaid, terminally (RT-76 INVARIANT), and omitting it would let the cursor skip past it (the
 * RT-86 lesson). The pull fails and its cursor does not advance.
 */
export class SaleTendersNotVisibleError extends Error {
  constructor(saleId: string, expected: number, visible: number) {
    super(
      `sale ${saleId} recorded ${expected} tender(s) but ${visible} are visible; refusing to offer it without them (RT-77)`,
    );
    this.name = "SaleTendersNotVisibleError";
  }
}

/** RT-77: one way the sale was paid (RT-10 D1/D2), net of change, a non-negative magnitude. */
export interface SaleWorkTender {
  readonly method: "cash" | "card_external";
  readonly amount: string;
  /** card_external only — the card terminal's short reference. */
  readonly reference?: string;
}

/** RT-86: one recorded payout of a return (RT-14 D3, cash only), a non-negative magnitude. */
export interface RefundWorkTender {
  readonly method: "cash";
  readonly amount: string;
}

/**
 * The 012 ReversalRef — present only on a `reversal` work-item. Carries the
 * ORIGINAL sale's provenance so the connector locates the document to reverse
 * (O-4), the reversal kind, and (RT-63) the reversal's OWN server time and
 * business date. A legacy refund has no persisted business date (RT-63 P2),
 * so `businessDate` is omitted for it; `returnLines` and (RT-86)
 * `refundTenders` are present only for a return (RT-14 D1 / D3).
 */
export interface ReversalRef {
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly reversalKind: "void" | "refund" | "return";
  readonly recordedAt: string;
  readonly businessDate?: string;
  readonly returnLines?: readonly ReturnWorkLine[];
  readonly refundTenders?: readonly RefundWorkTender[];
}

/** A 012 PostingWorkItem (sale_post; a reversal additionally carries reversalOf). */
export interface PostingWorkItem {
  readonly workItemRef: string;
  readonly kind: "sale_post" | "reversal";
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly payloadHash: string;
  readonly businessDate: string;
  /** Present only when kind=reversal (the original sale''s provenance, O-4). */
  readonly reversalOf: ReversalRef | null;
  readonly sale: {
    readonly saleRef: string;
    readonly storeId: string;
    readonly currencyCode: string;
    readonly posTotal: string;
    readonly occurredAt: string;
    readonly businessDate: string;
    readonly sourceSystem: string;
    readonly externalId: string;
    readonly lines: readonly WorkItemLine[];
    /**
     * RT-77: the ORIGINAL sale's recorded tenders on every item — a sale_post settles with them
     * and a void mirrors them (RT-10 D6); a return pays `reversalOf.refundTenders` instead.
     * OMITTED for a tender-unknown sale (posted unpaid, RT-10 D8): the contract treats absent
     * and empty alike, and omitting keeps every pre-RT-77 work item byte-identical for a
     * Connector that predates settlement (posting-feed.yaml ROLLOUT ORDER).
     */
    readonly tenders?: readonly SaleWorkTender[];
  };
  readonly itemCursor: string;
}

/**
 * Build the 012 wire work-item for one ALREADY-`pending` status row (pull-time,
 * read-only). Re-joins the sale + frozen lines + confirmed item-map to populate
 * each line's `erpnextItemRef`. Money is emitted as the exact-decimal strings the
 * DB holds (no float, §III). Returns null if the row's sale/lines are not found
 * under the current tenant (defensive; the feed filters those out).
 */
export async function buildWorkItem(
  client: PoolClient,
  row: {
    readonly id: string;
    readonly kind: "sale_post" | "reversal";
    readonly saleId: string;
    readonly sourceRefId: string;
    readonly sourceSystem: string;
    readonly externalId: string;
    readonly payloadHash: string;
    readonly sequence: string;
  },
): Promise<PostingWorkItem | null> {
  const sale = await client.query<{
    id: string;
    store_id: string;
    currency_code: string;
    pos_total: string;
    occurred_at: Date;
    business_date: string;
    source_system: string;
    external_id: string;
    tender_count: number;
  }>(
    `SELECT id, store_id, currency_code, pos_total::text AS pos_total,
            occurred_at, business_date::text AS business_date,
            source_system, external_id, tender_count
       FROM sales WHERE id = $1`,
    [row.saleId],
  );
  const s = sale.rows[0];
  if (!s) return null;

  const lines = await client.query<{
    line_ref: string;
    line_name: string;
    unit_price: string;
    currency_code: string;
    quantity: string;
    line_amount: string;
    tax_amount: string | null;
    unit: string;
    erpnext_item_ref: string | null;
    tenant_product_ref: string | null;
  }>(
    `SELECT sl.id::text AS line_ref, sl.line_name,
            sl.unit_price::text AS unit_price, sl.currency_code,
            sl.quantity::text AS quantity, sl.line_amount::text AS line_amount,
            sl.tax_amount::text AS tax_amount, sl.unit,
            m.erpnext_item_ref, sl.tenant_product_ref::text AS tenant_product_ref
       FROM sale_lines sl
       LEFT JOIN erpnext_item_map m
         ON m.tenant_product_id = sl.tenant_product_ref
        AND m.state = 'confirmed'
        AND m.retired_at IS NULL
      WHERE sl.sale_id = $1
      ORDER BY sl.id`,
    [row.saleId],
  );

  // A `pending` row was only created when eligibility resolved at CREATION, so
  // every line normally re-resolves here. EDGE CASE: a confirmed item-map can be
  // retired (013 REPOINT) BETWEEN creation and this pull, leaving a line's
  // `erpnext_item_ref` NULL. We MUST NOT ship an empty/contract-violating
  // `erpnextItemRef` (012 O-1 self-sufficiency). Returning null here makes the
  // feed OMIT the whole work-item (the service's `if (item)` filter), so the
  // connector never receives a malformed item.
  //
  // KNOWN LIMITATION (MVP): the omitted row stays `pending` in the DB but the
  // pull cursor advances past its `sequence`, so it is not re-offered until a
  // re-resolution pass flips stranded rows to `permanently_rejected`. That
  // re-resolution is US4-RESOLVE-FAIL / 017 work, NOT this read-only feed (a
  // status write inside the GET would break the 012 idempotent-replay invariant).
  // In the MVP no map-retirement path is exercised against a pending posting, so
  // this is a latent edge handled safely (omit, never corrupt), not a live gap.
  const wireLines: WorkItemLine[] = [];
  for (const l of lines.rows) {
    if (l.erpnext_item_ref === null || l.erpnext_item_ref.length === 0) {
      return null; // stale/retired map → omit the work-item rather than ship "".
    }
    wireLines.push({
      lineRef: l.line_ref,
      lineName: l.line_name,
      unitPrice: l.unit_price,
      currencyCode: l.currency_code,
      quantity: l.quantity,
      lineAmount: l.line_amount,
      taxAmount: l.tax_amount,
      unit: l.unit,
      // 012 ErpnextItemRef object shape (issue #506) — doctype fixed to "Item", name = Item code.
      erpnextItemRef: { doctype: "Item", name: l.erpnext_item_ref },
      tenantProductRef: l.tenant_product_ref,
    });
  }

  // For a reversal, carry the ORIGINAL sale's provenance (so the connector
  // locates the document to reverse, O-4), the kind — derived from which
  // terminal table holds `source_ref_id` — and the reversal's own immutable
  // time / business date (RT-63). The reversal posts a NEW reversing document;
  // the original sale_post row is never touched (§IX). A reversal whose
  // terminal row cannot be classified is omitted (defensive — should not
  // happen, the consumer only inserts for real events).
  let reversalOf: ReversalRef | null = null;
  if (row.kind === "reversal") {
    reversalOf = await buildReversalRef(client, row.sourceRefId, s);
    if (!reversalOf) return null;
  }

  const tenders = await loadSaleTenders(client, s.id, s.tender_count);

  return {
    workItemRef: row.id,
    kind: row.kind,
    sourceSystem: row.sourceSystem,
    externalId: row.externalId,
    payloadHash: row.payloadHash,
    businessDate: s.business_date,
    reversalOf,
    sale: {
      saleRef: s.id,
      storeId: s.store_id,
      currencyCode: s.currency_code,
      posTotal: s.pos_total,
      occurredAt: s.occurred_at.toISOString(),
      businessDate: s.business_date,
      sourceSystem: s.source_system,
      externalId: s.external_id,
      lines: wireLines,
      ...(tenders.length === 0 ? {} : { tenders }),
    },
    itemCursor: row.sequence,
  };
}

/** Classify the reversal row and project its RT-63 time + (return) lines. */
async function buildReversalRef(
  client: PoolClient,
  sourceRefId: string,
  sale: { source_system: string; external_id: string },
): Promise<ReversalRef | null> {
  const kindRow = await client.query<{
    reversal_kind: "void" | "refund" | "return";
    recorded_at: Date;
    business_date: string | null;
  }>(
    `SELECT 'void'::text AS reversal_kind, voided_at AS recorded_at,
            business_date::text AS business_date
       FROM sale_voids WHERE id = $1
     UNION ALL
     SELECT 'refund'::text, refunded_at, NULL::text
       FROM sale_refunds WHERE id = $1
     UNION ALL
     SELECT 'return'::text, returned_at, business_date::text
       FROM sale_returns WHERE id = $1
     LIMIT 1`,
    [sourceRefId],
  );
  const rk = kindRow.rows[0];
  if (!rk) return null;

  let returnLines: ReturnWorkLine[] | undefined;
  let refundTenders: RefundWorkTender[] | undefined;
  if (rk.reversal_kind === "return") {
    // Fixed order so every re-pull of the feed is byte-identical.
    const rl = await client.query<{
      line_ref: string;
      quantity: string;
      line_amount: string;
      tax_amount: string | null;
    }>(
      `SELECT sale_line_id::text AS line_ref, quantity::text AS quantity,
              line_amount::text AS line_amount, tax_amount::text AS tax_amount
         FROM sale_return_lines WHERE return_id = $1 ORDER BY sale_line_id`,
      [sourceRefId],
    );
    returnLines = rl.rows.map((l) => ({
      lineRef: l.line_ref,
      quantity: l.quantity,
      lineAmount: l.line_amount,
      taxAmount: l.tax_amount,
    }));
    refundTenders = await loadRefundTenders(client, sourceRefId);
  }

  return {
    sourceSystem: sale.source_system,
    externalId: sale.external_id,
    reversalKind: rk.reversal_kind,
    recordedAt: rk.recorded_at.toISOString(),
    ...(rk.business_date === null ? {} : { businessDate: rk.business_date }),
    ...(returnLines === undefined ? {} : { returnLines }),
    ...(refundTenders === undefined ? {} : { refundTenders }),
  };
}

/**
 * RT-77: the sale's recorded tenders in a fixed order (`method`, unique per sale) so every
 * re-pull is byte-identical. The visible row count must equal `sales.tender_count`, else
 * {@link SaleTendersNotVisibleError}: zero visible rows is otherwise indistinguishable from a
 * tender-unknown sale, and offering a tender-bearing sale without its tenders posts it unpaid.
 */
async function loadSaleTenders(
  client: PoolClient,
  saleId: string,
  expected: number,
): Promise<SaleWorkTender[]> {
  // A tender-unknown sale never touches sale_tenders (capture writes the rows and the count in
  // one transaction), so the pre-RT-77 feed does not depend on the new table's grant.
  if (expected === 0) return [];
  const st = await client.query<{
    method: "cash" | "card_external";
    amount: string;
    reference: string | null;
  }>(
    `SELECT method, amount::text AS amount, reference
       FROM sale_tenders WHERE sale_id = $1 ORDER BY method`,
    [saleId],
  );
  if (st.rows.length !== expected) {
    throw new SaleTendersNotVisibleError(saleId, expected, st.rows.length);
  }
  return st.rows.map((t) => ({
    method: t.method,
    amount: t.amount,
    ...(t.reference === null ? {} : { reference: t.reference }),
  }));
}

/**
 * RT-86: the return's recorded refund payouts (`sale_return_tenders`), in request order
 * (`ordinal`, unique per return) so every re-pull is byte-identical. Capture guarantees at
 * least one row summing to the return total (RT-73), so zero VISIBLE rows throws
 * {@link ReturnTendersNotVisibleError}: the contract INVARIANT forbids offering a return
 * without its tenders (the field is optional on the wire, and a credit note posted without its
 * cash is terminal), and omitting the item would let the page cursor skip a still-pending row.
 */
async function loadRefundTenders(
  client: PoolClient,
  returnId: string,
): Promise<RefundWorkTender[]> {
  const rt = await client.query<{ method: "cash"; amount: string }>(
    `SELECT method, amount::text AS amount
       FROM sale_return_tenders WHERE return_id = $1 ORDER BY ordinal`,
    [returnId],
  );
  if (rt.rows.length === 0) throw new ReturnTendersNotVisibleError(returnId);
  return rt.rows.map((t) => ({ method: t.method, amount: t.amount }));
}
