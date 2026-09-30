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
