/**
 * RT-539 (RT-534 S3) — the sale-history wire projections
 * (`pos-sales/sale-history.yaml` 1.0.0-draft). Docker-free, no clock.
 *
 * Pins the rules a reader of a historical sale relies on:
 *   - ERP posting state (OD-534-5 / Q-4): posted -> posted, pending and
 *     failed_transient -> pending, permanently_rejected -> failed, no row ->
 *     unknown; the document id only when posted;
 *   - names and labels (OD-534-6): the snapshot when one was recorded, today's
 *     value only for a sale captured without a snapshot, never an email, and
 *     a tombstoned snapshot name is `unavailable`, not today's name;
 *   - receipt facts (RT-537 D-6): `complete` only with a full snapshot, a
 *     sequence on every line, recorded tenders with a known order and the
 *     change known;
 *   - reprint eligibility (OD-534-3/8): a voided sale never gets a duplicate,
 *     an incomplete one gets only a sale record, marks follow void / returns.
 */
import {
  erpPostingStateOf,
  toSaleHistoryDetail,
  toSaleHistoryItem,
  type DetailLineRow,
  type DetailTenderRow,
  type DetailVoidRow,
  type SaleHistoryDetailRow,
} from "../../../../src/catalog/sales/history/sale-history.projections";

const SALE = "0a539000-0000-4000-8000-0000000000c1";
const DEVICE = "0a539000-0000-4000-8000-0000000000e1";
const CASHIER = "0a539000-0000-4000-8000-0000000000d1";
const LINE_1 = "0a539000-0000-4000-8000-0000000000f1";
const LINE_2 = "0a539000-0000-4000-8000-0000000000f2";
const RETURN = "0a539000-0000-4000-8000-0000000000b1";

const SNAPSHOT = {
  receipt_sale_number: "till-1-2026-10-15-000007",
  receipt_number: null,
  receipt_terminal_label: "till-1 (as printed)",
  receipt_operator_display_name: "Cashier (as printed)",
  receipt_settled_at: new Date("2026-10-15T09:30:05.000Z"),
  receipt_branch_name: "Branch",
  receipt_branch_address: "1 Nile St",
  receipt_tax_registration_id: "123-456-789",
  receipt_change_given: null,
};
const NO_SNAPSHOT = {
  receipt_sale_number: null,
  receipt_number: null,
  receipt_terminal_label: null,
  receipt_operator_display_name: null,
  receipt_settled_at: null,
  receipt_branch_name: null,
  receipt_branch_address: null,
  receipt_tax_registration_id: null,
  receipt_change_given: null,
};

function sale(extra: Partial<SaleHistoryDetailRow> = {}): SaleHistoryDetailRow {
  return {
    sale_id: SALE,
    business_date: "2026-10-15",
    occurred_at: new Date("2026-10-15T09:30:00.000Z"),
    occurred_at_key: "2026-10-15T09:30:00.000000Z",
    received_at: new Date("2026-10-15T09:31:00.000Z"),
    device_id: DEVICE,
    device_label: "till-1",
    created_by: CASHIER,
    user_display_name: "Cashier One",
    currency_code: "EGP",
    pos_total: "12.5000",
    sync_status: "synced",
    voided: false,
    return_state: "none",
    erp_status: "posted",
    erp_document_ref: "ACC-SINV-0001",
    ...SNAPSHOT,
    ...extra,
  };
}

function line(ref: string, seq: number | null): DetailLineRow {
  return {
    line_ref: ref,
    line_seq: seq,
    line_name: `line ${ref.slice(-1)}`,
    unit_price: "5.0000",
    currency_code: "EGP",
    quantity: "1.000000",
    line_amount: "5.0000",
    tax_amount: null,
    unit: "unit",
    returned_quantity: "0.000000",
  };
}

const CASH: DetailTenderRow = { method: "cash", amount: "12.5000", reference: null, sequence: null };

function detail(opts: {
  sale?: Partial<SaleHistoryDetailRow>;
  lines?: DetailLineRow[];
  tenders?: DetailTenderRow[];
  voidRow?: DetailVoidRow | null;
}) {
  return toSaleHistoryDetail({
    sale: sale(opts.sale),
    lines: opts.lines ?? [line(LINE_1, 1), line(LINE_2, 2)],
    tenders: opts.tenders ?? [CASH],
    voidRow: opts.voidRow ?? null,
    returns: [],
  });
}

describe("ERP posting state (OD-534-5, Q-4)", () => {
  it.each([
    ["posted", "posted"],
    ["pending", "pending"],
    ["failed_transient", "pending"],
    ["permanently_rejected", "failed"],
    [null, "unknown"],
    ["some_future_status", "unknown"],
  ])("%s -> %s", (status, state) => {
    expect(erpPostingStateOf(status)).toBe(state);
  });

  it("shows the document id only when the sale is posted", () => {
    expect(detail({}).erpPosting).toEqual({
      sale: "posted",
      saleDocumentRef: "ACC-SINV-0001",
      reversal: null,
      reversalDocumentRef: null,
    });
    expect(detail({ sale: { erp_status: "pending" } }).erpPosting.saleDocumentRef).toBeNull();
    expect(detail({ sale: { erp_status: null, erp_document_ref: null } }).erpPosting.sale).toBe("unknown");
  });
});

describe("history item: names and labels (OD-534-6)", () => {
  it("uses the snapshot when the sale recorded one", () => {
    const item = toSaleHistoryItem(sale());
    expect(item.device).toEqual({ deviceRef: DEVICE, label: "till-1 (as printed)", labelSource: "snapshot" });
    expect(item.operator).toEqual({ userRef: CASHIER, displayName: "Cashier (as printed)", nameSource: "snapshot" });
    expect(item.saleNumber).toBe("till-1-2026-10-15-000007");
  });

  it("uses today's values, marked current, for a sale captured without a snapshot", () => {
    const item = toSaleHistoryItem(sale(NO_SNAPSHOT));
    expect(item.device).toEqual({ deviceRef: DEVICE, label: "till-1", labelSource: "current" });
    expect(item.operator).toEqual({ userRef: CASHIER, displayName: "Cashier One", nameSource: "current" });
    expect(item.saleNumber).toBeNull();
  });

  it("is unavailable, never an email, when no name exists", () => {
    const item = toSaleHistoryItem(sale({ ...NO_SNAPSHOT, user_display_name: null, device_label: null }));
    expect(item.operator).toEqual({ userRef: CASHIER, displayName: null, nameSource: "unavailable" });
    expect(item.device).toEqual({ deviceRef: DEVICE, label: null, labelSource: "unavailable" });
  });

  it("a pre-RT-77 sale has no device", () => {
    const item = toSaleHistoryItem(sale({ ...NO_SNAPSHOT, device_id: null, device_label: null }));
    expect(item.device).toEqual({ deviceRef: null, label: null, labelSource: "unavailable" });
  });

  it("a tombstoned snapshot name is unavailable, never today's name", () => {
    const item = toSaleHistoryItem(sale({ receipt_operator_display_name: null }));
    expect(item.operator).toEqual({ userRef: CASHIER, displayName: null, nameSource: "unavailable" });
  });

  it("carries the summary facts verbatim", () => {
    const item = toSaleHistoryItem(sale({ voided: true, return_state: "partial", sync_status: "failed-needs-repair" }));
    expect(item).toMatchObject({
      saleRef: SALE,
      businessDate: "2026-10-15",
      occurredAt: "2026-10-15T09:30:00.000Z",
      receivedAt: "2026-10-15T09:31:00.000Z",
      currencyCode: "EGP",
      posTotal: "12.5000",
      syncStatus: "failed-needs-repair",
      voided: true,
      returnState: "partial",
      erpPostingState: "posted",
    });
  });
});

describe("detail: receipt facts (RT-537 D-6) and reprint eligibility (OD-534-3/8)", () => {
  it("a full snapshot, sequenced lines, one tender and the change known is complete", () => {
    const d = detail({});
    expect(d.receiptFacts).toBe("complete");
    expect(d.lineOrder).toBe("recorded");
    expect(d.tenderState).toBe("recorded");
    expect(d.changeGiven).toBe("0");
    expect(d.receiptNumber).toBe("till-1-2026-10-15-000007");
    expect(d.receiptHeader).toEqual({ branchName: "Branch", branchAddress: "1 Nile St", taxRegistrationId: "123-456-789" });
    expect(d.settledAt).toBe("2026-10-15T09:30:05.000Z");
    expect(d.reprint).toEqual({ duplicate: "allowed", saleRecord: "allowed", marks: [] });
  });

  it("keeps a recorded change and a differing receipt number", () => {
    const d = detail({ sale: { receipt_change_given: "7.5000", receipt_number: "R-7" } });
    expect(d.changeGiven).toBe("7.5000");
    expect(d.receiptNumber).toBe("R-7");
  });

  it("orders lines by their recorded sequence", () => {
    const d = detail({ lines: [line(LINE_2, 2), line(LINE_1, 1)] });
    expect(d.lines.map((l) => l.sequence)).toEqual([1, 2]);
    expect(d.lines[0]).toEqual({
      lineRef: LINE_1,
      sequence: 1,
      lineName: "line 1",
      unitPrice: "5.0000",
      currencyCode: "EGP",
      quantity: "1.000000",
      lineAmount: "5.0000",
      taxAmount: null,
      unit: "unit",
      returnedQuantity: "0.000000",
    });
  });

  it("no snapshot: partial, every snapshot fact null, only a sale record", () => {
    const d = detail({ sale: NO_SNAPSHOT });
    expect(d).toMatchObject({
      changeGiven: null,
      settledAt: null,
      receiptNumber: null,
      receiptHeader: null,
      receiptFacts: "partial",
      reprint: { duplicate: "unavailable_incomplete", saleRecord: "allowed", marks: [] },
    });
  });

  it("a line without a sequence: not_recorded and partial", () => {
    const d = detail({ lines: [line(LINE_1, 1), line(LINE_2, null)] });
    expect(d.lineOrder).toBe("not_recorded");
    expect(d.receiptFacts).toBe("partial");
  });

  it("a tender-unknown sale: unknown tenders and partial", () => {
    const d = detail({ tenders: [] });
    expect(d.tenderState).toBe("unknown");
    expect(d.tenders).toEqual([]);
    expect(d.receiptFacts).toBe("partial");
  });

  it("split tenders without a sequence: order unknown, partial", () => {
    const card: DetailTenderRow = { method: "card_external", amount: "2.5000", reference: "AB12", sequence: null };
    const split = [{ ...CASH, amount: "10.0000" }, card];
    expect(detail({ tenders: split }).receiptFacts).toBe("partial");
    const ordered = [
      { ...CASH, amount: "10.0000", sequence: 1 },
      { ...card, sequence: 2 },
    ];
    const d = detail({ tenders: ordered });
    expect(d.receiptFacts).toBe("complete");
    expect(d.tenders).toEqual([
      { method: "cash", amount: "10.0000", reference: null, sequence: 1 },
      { method: "card_external", amount: "2.5000", reference: "AB12", sequence: 2 },
    ]);
  });

  it("a tombstoned snapshot name is partial", () => {
    expect(detail({ sale: { receipt_operator_display_name: null } }).receiptFacts).toBe("partial");
  });

  it("a voided sale: no duplicate, a sale record marked voided, the void and reversal shown", () => {
    const voidRow: DetailVoidRow = {
      voided_at: new Date("2026-10-15T10:00:00.000Z"),
      void_business_date: "2026-10-15",
      approved: true,
      approver_role: "store_manager",
      reversal_status: "failed_transient",
      reversal_document_ref: null,
    };
    const d = detail({ sale: { voided: true }, voidRow });
    expect(d.void).toEqual({
      voidedAt: "2026-10-15T10:00:00.000Z",
      voidBusinessDate: "2026-10-15",
      approved: true,
      approverRole: "store_manager",
    });
    expect(d.erpPosting.reversal).toBe("pending");
    expect(d.erpPosting.reversalDocumentRef).toBeNull();
    expect(d.reprint).toEqual({ duplicate: "unavailable_voided", saleRecord: "allowed", marks: ["voided"] });
  });

  it("a legacy void: not approved, no approver role; a posted reversal shows its document", () => {
    const voidRow: DetailVoidRow = {
      voided_at: new Date("2026-10-15T10:00:00.000Z"),
      void_business_date: null,
      approved: false,
      approver_role: null,
      reversal_status: "posted",
      reversal_document_ref: "ACC-SINV-0001-RET",
    };
    const d = detail({ sale: { voided: true }, voidRow });
    expect(d.void).toMatchObject({ approved: false, approverRole: null, voidBusinessDate: null });
    expect(d.erpPosting).toMatchObject({ reversal: "posted", reversalDocumentRef: "ACC-SINV-0001-RET" });
  });

  it("an approver whose role is no longer an approver role is shown without one", () => {
    const voidRow: DetailVoidRow = {
      voided_at: new Date("2026-10-15T10:00:00.000Z"),
      void_business_date: "2026-10-15",
      approved: true,
      approver_role: "store_staff",
      reversal_status: null,
      reversal_document_ref: null,
    };
    const d = detail({ sale: { voided: true }, voidRow });
    expect(d.void?.approverRole).toBeNull();
    expect(d.erpPosting.reversal).toBe("unknown");
  });

  it("a returned sale keeps its duplicate and is marked returned, with its returns", () => {
    const d = toSaleHistoryDetail({
      sale: sale({ return_state: "partial" }),
      lines: [line(LINE_1, 1), { ...line(LINE_2, 2), returned_quantity: "1.000000" }],
      tenders: [CASH],
      voidRow: null,
      returns: [
        {
          return_ref: RETURN,
          recorded_at: new Date("2026-10-15T11:00:00.000Z"),
          business_date: "2026-10-15",
          return_total: "5.0000",
          lines: [{ line_ref: LINE_2, quantity: "1.000000", line_amount: "5.0000" }],
        },
      ],
    });
    expect(d.reprint).toEqual({ duplicate: "allowed", saleRecord: "allowed", marks: ["returned"] });
    expect(d.returns).toEqual([
      {
        returnRef: RETURN,
        recordedAt: "2026-10-15T11:00:00.000Z",
        businessDate: "2026-10-15",
        returnTotal: "5.0000",
        lines: [{ lineRef: LINE_2, quantity: "1.000000", lineAmount: "5.0000" }],
      },
    ]);
    expect(d.lines[1]?.returnedQuantity).toBe("1.000000");
  });
});
