/**
 * RT-410 — toBacklogItem's `reason` (contract `reconciliation.yaml`
 * 1.3.0-draft `PostingBacklogItem.reason`): the stored Connector message, or
 * null when the row has none; it never repeats `rejectionCategory`.
 */
import {
  toBacklogItem,
  type PostingDeadletterRow,
} from "../../../../src/catalog/erpnext-reconciliation/reconciliation-report.projection";

const ROW: PostingDeadletterRow = {
  id: "0a000000-0000-7000-8000-000004100001",
  kind: "sale_post",
  rejection_category: "validation",
  sale_id: "0a000000-0000-7000-8000-000004100002",
  source_system: "pos",
  external_id: "sale-1",
  updated_at: new Date("2026-10-22T10:00:00Z"),
  reconciliation_document_ref: null,
  rejection_message: "NameError: name 'flt' is not defined",
};

describe("toBacklogItem — reason (RT-410)", () => {
  it("is the stored rejection message", () => {
    expect(toBacklogItem(ROW)).toMatchObject({ rejectionCategory: "validation", reason: ROW.rejection_message });
  });

  it("is null when the row has no message, never the category", () => {
    expect(toBacklogItem({ ...ROW, rejection_message: null }).reason).toBeNull();
  });
});
