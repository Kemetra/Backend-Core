/**
 * Errors shared by the sale-fact services (008 + RT-73). Re-exported from
 * `sales.service.ts` so existing importers are unchanged.
 */

/** Thrown when a sale ref does not resolve within the caller's scope. */
export class SaleNotFoundError extends Error {
  constructor() {
    super("sale not found");
    this.name = "SaleNotFoundError";
  }
}

/**
 * Thrown when a terminal-event provenance `(tenant, source_system, external_id)`
 * is reused for a DIFFERENT sale (or, for a return, a different payload) than
 * the one it was first recorded with — a client conflict (→ 409), not a valid
 * idempotent replay (FR-013).
 */
export class TerminalEventProvenanceConflictError extends Error {
  constructor() {
    super("terminal event provenance already used for a different sale");
    this.name = "TerminalEventProvenanceConflictError";
  }
}

/**
 * RT-77 (RT-10 D1): the capture's `tenders` amounts do not sum to `posTotal`
 * exactly (→ 422 `sale_tender_mismatch`). Nothing is recorded.
 */
export class SaleTenderMismatchError extends Error {
  constructor() {
    super("sale tenders do not sum to posTotal");
    this.name = "SaleTenderMismatchError";
  }
}

/**
 * RT-105 (RT-87 decision D): a first capture whose line breaks the price
 * invariant — money beyond the currency's minor unit, `lineAmount ≠ unitPrice ×
 * quantity`, or a fractional quantity (→ 422 `sale_line_pricing_invalid`).
 * Such a line could not be returned exactly. Nothing is recorded.
 */
export class SaleLinePricingInvalidError extends Error {
  constructor() {
    super("a sale line breaks the price invariant");
    this.name = "SaleLinePricingInvalidError";
  }
}

/**
 * RT-77: a capture re-delivered under an existing `(tenant, source_system,
 * external_id)` provenance whose tender set differs from the one recorded — a
 * different payload (→ 409), never a replay (RT-77 comment 10509: the compare
 * covers tenders only; every other replay is unchanged).
 */
export class SaleTenderReplayConflictError extends Error {
  constructor() {
    super("sale provenance already captured with different tenders");
    this.name = "SaleTenderReplayConflictError";
  }
}

/**
 * RT-77: a sale whose VISIBLE `sale_tenders` rows differ from the `sales.tender_count` capture
 * wrote in the same transaction — a visibility fault (an RLS or grant gap), not data. Thrown
 * rather than answering with a partial or empty tender list, which would misstate how the sale
 * was paid (empty means tender-unknown). On the posting feed the pull fails and its cursor does
 * not advance: a tender-bearing sale offered without its tenders is posted unpaid, terminally
 * (RT-76 INVARIANT), and omitting it would let the cursor skip past it (the RT-86 lesson).
 */
export class SaleTendersNotVisibleError extends Error {
  constructor(saleId: string, expected: number, visible: number) {
    super(
      `sale ${saleId} recorded ${expected} tender(s) but ${visible} are visible; refusing to answer without them (RT-77)`,
    );
    this.name = "SaleTendersNotVisibleError";
  }
}
