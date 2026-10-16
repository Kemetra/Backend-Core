/**
 * RT-539 (RT-534 S3) — pure wire projections of the POS sale history
 * (`pos-sales/sale-history.yaml` 1.0.0-draft). No DB, no clock.
 *
 * Explicit wire shapes, never DB rows (§IV): no tenant id, payload hash or
 * email. Every key is present; a fact that was never recorded is `null` or
 * `unavailable`, never guessed or filled from today's values (OD-534-3/6):
 *   - a name or label comes from the receipt snapshot when the sale recorded
 *     one (`snapshot`); for a sale captured without a snapshot, today's value
 *     is shown and marked `current`; a snapshot whose operator name was
 *     tombstoned (0047 classification) is `unavailable`, never today's name;
 *   - receipt facts are `complete` only when every field the original receipt
 *     printed is recorded (RT-537 D-6), which is what a duplicate needs;
 *   - ERP state is read-only (OD-534-5, Q-4), never a fiscal claim.
 * Amounts are the stored `numeric` text, verbatim.
 */
import type { SaleSyncStatus } from "../sale-sync-status";

export type ErpPostingState = "posted" | "pending" | "failed" | "unknown";
export type NameSource = "snapshot" | "current" | "unavailable";
export type ReturnState = "none" | "partial" | "full";
export type ReprintMark = "voided" | "returned";
export type DuplicateEligibility = "allowed" | "unavailable_incomplete" | "unavailable_voided";

/** Q-4: `erpnext_posting_status.status` -> the read-only ERP posting state. */
export function erpPostingStateOf(status: string | null): ErpPostingState {
  switch (status) {
    case "posted":
      return "posted";
    case "pending":
    case "failed_transient":
      return "pending";
    case "permanently_rejected":
      return "failed";
    default:
      // No posting row: a tenant without ERP, or a sale stranded before its intent.
      return "unknown";
  }
}

/** The void approver roles (RT-530); any other current role is not shown. */
const APPROVER_ROLES = new Set(["owner", "tenant_admin", "store_manager"]);

// ---------------------------------------------------------------------------
// Rows read by the service (amounts and dates as text)
// ---------------------------------------------------------------------------

/** The receipt snapshot columns (0047), all null when the sale has none. */
export interface ReceiptSnapshotColumns {
  readonly receipt_sale_number: string | null;
  readonly receipt_number: string | null;
  readonly receipt_terminal_label: string | null;
  readonly receipt_operator_display_name: string | null;
  readonly receipt_settled_at: Date | null;
  readonly receipt_branch_name: string | null;
  readonly receipt_branch_address: string | null;
  readonly receipt_tax_registration_id: string | null;
  readonly receipt_change_given: string | null;
}

/** One sale as the list and the detail read it. */
export interface SaleHistoryRow extends ReceiptSnapshotColumns {
  readonly sale_id: string;
  readonly business_date: string;
  readonly occurred_at: Date;
  readonly occurred_at_key: string;
  readonly received_at: Date;
  readonly device_id: string | null;
  /** Today's `devices.label`. */
  readonly device_label: string | null;
  readonly created_by: string;
  /** Today's `users.display_name` (never the email). */
  readonly user_display_name: string | null;
  readonly currency_code: string;
  readonly pos_total: string;
  readonly sync_status: SaleSyncStatus;
  readonly voided: boolean;
  readonly return_state: ReturnState;
  /** The sale_post posting status, null when there is no posting row. */
  readonly erp_status: string | null;
}

export interface SaleHistoryDetailRow extends SaleHistoryRow {
  readonly erp_document_ref: string | null;
}

export interface DetailLineRow {
  readonly line_ref: string;
  readonly line_seq: number | null;
  readonly line_name: string;
  readonly unit_price: string;
  readonly currency_code: string;
  readonly quantity: string;
  readonly line_amount: string;
  readonly tax_amount: string | null;
  readonly unit: string;
  readonly returned_quantity: string;
}

export interface DetailTenderRow {
  readonly method: "cash" | "card_external";
  readonly amount: string;
  readonly reference: string | null;
  readonly sequence: number | null;
}

export interface DetailVoidRow {
  readonly voided_at: Date;
  readonly void_business_date: string | null;
  readonly approved: boolean;
  /** The approver's CURRENT role in the tenant (the role is not stored on the void). */
  readonly approver_role: string | null;
  readonly reversal_status: string | null;
  readonly reversal_document_ref: string | null;
}

export interface DetailReturnRow {
  readonly return_ref: string;
  readonly recorded_at: Date;
  readonly business_date: string;
  readonly return_total: string;
  readonly lines: ReadonlyArray<{ readonly line_ref: string; readonly quantity: string; readonly line_amount: string }>;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface DeviceView {
  readonly deviceRef: string | null;
  readonly label: string | null;
  readonly labelSource: NameSource;
}

export interface OperatorView {
  readonly userRef: string | null;
  readonly displayName: string | null;
  readonly nameSource: NameSource;
}

export interface SaleHistoryItem {
  readonly saleRef: string;
  readonly saleNumber: string | null;
  readonly businessDate: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly device: DeviceView;
  readonly operator: OperatorView;
  readonly currencyCode: string;
  readonly posTotal: string;
  readonly syncStatus: SaleSyncStatus;
  readonly voided: boolean;
  readonly returnState: ReturnState;
  readonly erpPostingState: ErpPostingState;
}

export interface ReprintEligibility {
  readonly duplicate: DuplicateEligibility;
  readonly saleRecord: "allowed";
  readonly marks: ReadonlyArray<ReprintMark>;
}

export interface SaleHistoryDetail {
  readonly summary: SaleHistoryItem;
  readonly lines: ReadonlyArray<{
    readonly lineRef: string;
    readonly sequence: number | null;
    readonly lineName: string;
    readonly unitPrice: string;
    readonly currencyCode: string;
    readonly quantity: string;
    readonly lineAmount: string;
    readonly taxAmount: string | null;
    readonly unit: string;
    readonly returnedQuantity: string;
  }>;
  readonly lineOrder: "recorded" | "not_recorded";
  readonly tenderState: "recorded" | "unknown";
  readonly tenders: ReadonlyArray<{
    readonly method: "cash" | "card_external";
    readonly amount: string;
    readonly reference: string | null;
    readonly sequence: number | null;
  }>;
  readonly changeGiven: string | null;
  readonly settledAt: string | null;
  readonly receiptNumber: string | null;
  readonly receiptHeader: {
    readonly branchName: string;
    readonly branchAddress: string;
    readonly taxRegistrationId: string;
  } | null;
  readonly void: {
    readonly voidedAt: string;
    readonly voidBusinessDate: string | null;
    readonly approved: boolean;
    readonly approverRole: "owner" | "tenant_admin" | "store_manager" | null;
  } | null;
  readonly returns: ReadonlyArray<{
    readonly returnRef: string;
    readonly recordedAt: string;
    readonly businessDate: string;
    readonly returnTotal: string;
    readonly lines: ReadonlyArray<{ readonly lineRef: string; readonly quantity: string; readonly lineAmount: string }>;
  }>;
  readonly erpPosting: {
    readonly sale: ErpPostingState;
    readonly saleDocumentRef: string | null;
    readonly reversal: ErpPostingState | null;
    readonly reversalDocumentRef: string | null;
  };
  readonly receiptFacts: "complete" | "partial";
  readonly reprint: ReprintEligibility;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function hasSnapshot(row: ReceiptSnapshotColumns): boolean {
  return row.receipt_sale_number !== null;
}

/** A recorded value (`snapshot`), today's value for a sale without a snapshot (`current`), or none. */
function sourced(
  snapshotTaken: boolean,
  snapshotValue: string | null,
  currentValue: string | null,
): { readonly value: string | null; readonly source: NameSource } {
  if (snapshotTaken) {
    return snapshotValue === null
      ? { value: null, source: "unavailable" }
      : { value: snapshotValue, source: "snapshot" };
  }
  return currentValue === null ? { value: null, source: "unavailable" } : { value: currentValue, source: "current" };
}

function deviceViewOf(row: SaleHistoryRow): DeviceView {
  const currentLabel = row.device_id === null ? null : row.device_label;
  const label = sourced(hasSnapshot(row), row.receipt_terminal_label, currentLabel);
  return { deviceRef: row.device_id, label: label.value, labelSource: label.source };
}

function operatorViewOf(row: SaleHistoryRow): OperatorView {
  const name = sourced(hasSnapshot(row), row.receipt_operator_display_name, row.user_display_name);
  return { userRef: row.created_by, displayName: name.value, nameSource: name.source };
}

export function toSaleHistoryItem(row: SaleHistoryRow): SaleHistoryItem {
  return {
    saleRef: row.sale_id,
    saleNumber: row.receipt_sale_number,
    businessDate: row.business_date,
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    device: deviceViewOf(row),
    operator: operatorViewOf(row),
    currencyCode: row.currency_code,
    posTotal: row.pos_total,
    syncStatus: row.sync_status,
    voided: row.voided,
    returnState: row.return_state,
    erpPostingState: erpPostingStateOf(row.erp_status),
  };
}

export interface SaleHistoryDetailInput {
  readonly sale: SaleHistoryDetailRow;
  readonly lines: ReadonlyArray<DetailLineRow>;
  readonly tenders: ReadonlyArray<DetailTenderRow>;
  readonly voidRow: DetailVoidRow | null;
  readonly returns: ReadonlyArray<DetailReturnRow>;
}

/** Lines in receipt order when recorded; otherwise the stable order they were read in. */
function orderedLines(lines: ReadonlyArray<DetailLineRow>): DetailLineRow[] {
  return [...lines].sort((a, b) => (a.line_seq ?? Number.MAX_SAFE_INTEGER) - (b.line_seq ?? Number.MAX_SAFE_INTEGER));
}

/** RT-537 D-6: every fact the original receipt printed is recorded. */
function receiptFactsComplete(input: SaleHistoryDetailInput): boolean {
  const { sale, lines, tenders } = input;
  const tenderOrderKnown = tenders.length === 1 || tenders.every((t) => t.sequence !== null);
  return (
    hasSnapshot(sale) &&
    receiptHeaderOf(sale) !== null &&
    sale.receipt_operator_display_name !== null &&
    lines.every((l) => l.line_seq !== null) &&
    tenders.length > 0 &&
    tenderOrderKnown
  );
}

/** OD-534-3/8: what `recordSaleReprint` allows in `authorize` mode. */
export function reprintEligibilityOf(sale: { readonly voided: boolean; readonly return_state: ReturnState }, complete: boolean): ReprintEligibility {
  const marks: ReprintMark[] = [];
  if (sale.voided) marks.push("voided");
  if (sale.return_state !== "none") marks.push("returned");
  let duplicate: DuplicateEligibility = "allowed";
  if (sale.voided) duplicate = "unavailable_voided";
  else if (!complete) duplicate = "unavailable_incomplete";
  return { duplicate, saleRecord: "allowed", marks };
}

function voidViewOf(row: DetailVoidRow | null): SaleHistoryDetail["void"] {
  if (row === null) return null;
  const role = row.approver_role !== null && APPROVER_ROLES.has(row.approver_role) ? row.approver_role : null;
  return {
    voidedAt: row.voided_at.toISOString(),
    voidBusinessDate: row.void_business_date,
    approved: row.approved,
    approverRole: row.approved ? (role as "owner" | "tenant_admin" | "store_manager" | null) : null,
  };
}

/** The ERPNext document id, shown only when the posting is authoritative (posted). */
function saleDocumentRefOf(sale: SaleHistoryDetailRow, state: ErpPostingState): string | null {
  return state === "posted" ? sale.erp_document_ref : null;
}

function erpPostingViewOf(sale: SaleHistoryDetailRow, voidRow: DetailVoidRow | null): SaleHistoryDetail["erpPosting"] {
  const saleState = erpPostingStateOf(sale.erp_status);
  if (voidRow === null) {
    return { sale: saleState, saleDocumentRef: saleDocumentRefOf(sale, saleState), reversal: null, reversalDocumentRef: null };
  }
  const reversal = erpPostingStateOf(voidRow.reversal_status);
  return {
    sale: saleState,
    saleDocumentRef: saleDocumentRefOf(sale, saleState),
    reversal,
    reversalDocumentRef: reversal === "posted" ? voidRow.reversal_document_ref : null,
  };
}

/** The header captured with the sale; null unless every header field was recorded (Q-3). */
function receiptHeaderOf(sale: ReceiptSnapshotColumns): SaleHistoryDetail["receiptHeader"] {
  const { receipt_branch_name: branchName, receipt_branch_address: branchAddress } = sale;
  const taxRegistrationId = sale.receipt_tax_registration_id;
  if (branchName === null || branchAddress === null || taxRegistrationId === null) return null;
  return { branchName, branchAddress, taxRegistrationId };
}

export function toSaleHistoryDetail(input: SaleHistoryDetailInput): SaleHistoryDetail {
  const { sale, tenders, voidRow, returns } = input;
  const snapshot = hasSnapshot(sale);
  const lines = orderedLines(input.lines);
  const complete = receiptFactsComplete(input);
  return {
    summary: toSaleHistoryItem(sale),
    lines: lines.map((l) => ({
      lineRef: l.line_ref,
      sequence: l.line_seq,
      lineName: l.line_name,
      unitPrice: l.unit_price,
      currencyCode: l.currency_code,
      quantity: l.quantity,
      lineAmount: l.line_amount,
      taxAmount: l.tax_amount,
      unit: l.unit,
      returnedQuantity: l.returned_quantity,
    })),
    lineOrder: lines.every((l) => l.line_seq !== null) ? "recorded" : "not_recorded",
    tenderState: tenders.length > 0 ? "recorded" : "unknown",
    tenders: tenders.map((t) => ({ method: t.method, amount: t.amount, reference: t.reference, sequence: t.sequence })),
    // A snapshot captured without changeGiven recorded no change (absent means none).
    changeGiven: snapshot ? (sale.receipt_change_given ?? "0") : null,
    settledAt: sale.receipt_settled_at === null ? null : sale.receipt_settled_at.toISOString(),
    // Omitted on capture means equal to the sale number.
    receiptNumber: snapshot ? (sale.receipt_number ?? sale.receipt_sale_number) : null,
    receiptHeader: receiptHeaderOf(sale),
    void: voidViewOf(voidRow),
    returns: returns.map((r) => ({
      returnRef: r.return_ref,
      recordedAt: r.recorded_at.toISOString(),
      businessDate: r.business_date,
      returnTotal: r.return_total,
      lines: r.lines.map((l) => ({ lineRef: l.line_ref, quantity: l.quantity, lineAmount: l.line_amount })),
    })),
    erpPosting: erpPostingViewOf(sale, voidRow),
    receiptFacts: complete ? "complete" : "partial",
    reprint: reprintEligibilityOf(sale, complete),
  };
}
