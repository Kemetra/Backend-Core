/**
 * reconciliation-report.projection.ts — the 017 operator wire shapes (§IV).
 *
 * US1 backlog: a `PostingBacklogItem` is a READ-PROJECTION of a 015
 * `erpnext_posting_status` row with `status='permanently_rejected'` — 017 reads
 * the 015 dead-letters IN PLACE, it never mirrors them (READ-NOT-MIRROR / R2). NO
 * money field (the sale's amounts live on the 008 fact, not surfaced here).
 */

/** A 015 posting dead-letter, projected for the operator backlog (US1). */
export interface PostingBacklogItem {
  /** The 015 erpnext_posting_status.id — pass to repairPosting (US2). */
  readonly workItemRef: string;
  readonly kind: "sale_post" | "reversal";
  /** The 015 rejection category (015's vocabulary, read in place). */
  readonly rejectionCategory: string | null;
  /** The parent 008 sale id (lineage). */
  readonly saleRef: string | null;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly reason: string | null;
  /** When the posting became permanently_rejected (the 015 row's updated_at). */
  readonly deadLetteredAt: string;
  /**
   * RT-332: for a `reconciliation_required` dead-letter, the EXISTING ERP document
   * the connector reported; null otherwise.
   */
  readonly reconciliationDocumentRef: { readonly doctype: string; readonly name: string } | null;
}

/** The DB row shape read from erpnext_posting_status for a dead-letter. */
export interface PostingDeadletterRow {
  readonly id: string;
  readonly kind: "sale_post" | "reversal";
  readonly rejection_category: string | null;
  readonly sale_id: string | null;
  readonly source_system: string;
  readonly external_id: string;
  readonly updated_at: Date;
  readonly reconciliation_document_ref: string | null;
}

/**
 * Project a 015 permanently_rejected row into the operator backlog wire shape.
 * `reason` is derived from the rejection_category (the 015 row carries no free-text
 * reason column; the structured reason was supplied at ack time and the category
 * is the durable, non-PII summary). NO money/amount is surfaced.
 */
export function toBacklogItem(row: PostingDeadletterRow): PostingBacklogItem {
  return {
    workItemRef: row.id,
    kind: row.kind,
    rejectionCategory: row.rejection_category,
    saleRef: row.sale_id,
    sourceSystem: row.source_system,
    externalId: row.external_id,
    reason: row.rejection_category,
    deadLetteredAt: row.updated_at.toISOString(),
    reconciliationDocumentRef: parseEvidence(row.reconciliation_document_ref),
  };
}

/** RT-332: the stored ErpnextDocumentRef JSON, or null when absent or unreadable. */
function parseEvidence(
  raw: string | null,
): { doctype: string; name: string } | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { doctype?: unknown; name?: unknown };
    return typeof parsed.doctype === "string" && typeof parsed.name === "string"
      ? { doctype: parsed.doctype, name: parsed.name }
      : null;
  } catch {
    return null;
  }
}
