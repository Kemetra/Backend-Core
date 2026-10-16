/**
 * RT-562 (RT-556 F2) — the console sales read's pure parts: the query schema
 * (31-day inclusive cap, literal booleans, repeated keys), the cursor binding
 * (operation, tenant, store and every filter), the page assembly (the bounded
 * page: short or empty with a non-null cursor, and always forward) and the
 * projections (the sale-history facts minus the POS-only parts, plus the
 * store). No DB.
 */
import { encodeSaleHistoryCursor } from "../../src/catalog/sales/history/sale-history.query";
import type { SaleHistoryDetail, SaleHistoryRow } from "../../src/catalog/sales/history/sale-history.projections";
import { SALE_SYNC_STATUS_VALUES } from "../../src/catalog/sales/sale-sync-status";
import { listAuditOf } from "../../src/console-sales/console-sales.controller";
import {
  assemblePage,
  toConsoleSaleDetail,
} from "../../src/console-sales/console-sales.projections";
import {
  consoleFiltersOf,
  ConsoleSaleListQuerySchema,
  decodeConsoleSaleCursor,
  encodeConsoleSaleCursor,
  hasAnyFilter,
  InvalidConsoleSaleCursorError,
  type ConsoleCursorBinding,
  type ConsoleSaleFilters,
} from "../../src/console-sales/console-sales.query";
import { allContracts, contractDocument } from "../_helpers/openapi-contract";

const TENANT = "0a000000-0000-7000-8000-000000056201";
const TENANT_2 = "0a000000-0000-7000-8000-000000056202";
const STORE = "0a000000-0000-7000-8000-0000000562a1";
const STORE_2 = "0a000000-0000-7000-8000-0000000562a2";
const BASE = { store_id: STORE, from: "2026-10-01", to: "2026-10-31" };

const parse = (query: Record<string, unknown>) => ConsoleSaleListQuerySchema.safeParse(query);

const NO_FILTERS: ConsoleSaleFilters = {
  from: "2026-10-01",
  to: "2026-10-31",
  saleNumber: null,
  syncStatus: null,
  voided: null,
  returnState: null,
  erpPostingState: null,
};

describe("RT-562 console sales — list query schema", () => {
  it("requires store_id, from and to", () => {
    expect(parse(BASE).success).toBe(true);
    for (const key of ["store_id", "from", "to"] as const) {
      const { [key]: _dropped, ...rest } = BASE;
      expect(parse(rest).success).toBe(false);
    }
  });

  it("lower-cases store_id (the one value scope-checked, cursor-bound and queried)", () => {
    const r = parse({ ...BASE, store_id: STORE.toUpperCase() });
    expect(r.success && r.data.store_id).toBe(STORE);
  });

  it("accepts 31 business days inclusive and refuses 32, a reversed range and a non-calendar date", () => {
    expect(parse({ ...BASE, from: "2026-10-01", to: "2026-10-31" }).success).toBe(true);
    expect(parse({ ...BASE, from: "2026-10-05", to: "2026-10-05" }).success).toBe(true);
    expect(parse({ ...BASE, from: "2026-10-01", to: "2026-11-01" }).success).toBe(false);
    expect(parse({ ...BASE, from: "2026-10-02", to: "2026-10-01" }).success).toBe(false);
    expect(parse({ ...BASE, from: "2026-02-30", to: "2026-03-01" }).success).toBe(false);
    expect(parse({ ...BASE, from: "2026-10-1", to: "2026-10-31" }).success).toBe(false);
  });

  it("reads voided only as the literals true / false", () => {
    const yes = parse({ ...BASE, voided: "true" });
    const no = parse({ ...BASE, voided: "false" });
    expect(yes.success && yes.data.voided).toBe(true);
    expect(no.success && no.data.voided).toBe(false);
    for (const value of ["1", "0", "yes", "TRUE", ""]) expect(parse({ ...BASE, voided: value }).success).toBe(false);
  });

  it("accepts every contract sync status and only those", () => {
    const contract = contractDocument(allContracts(), "console-sales.openapi") as unknown as {
      components: { schemas: { SyncStatus: { enum: string[] } } };
    };
    expect([...SALE_SYNC_STATUS_VALUES].sort()).toEqual([...contract.components.schemas.SyncStatus.enum].sort());
    for (const status of SALE_SYNC_STATUS_VALUES) expect(parse({ ...BASE, sync_status: status }).success).toBe(true);
    expect(parse({ ...BASE, sync_status: "posted" }).success).toBe(false);
  });

  it("refuses a repeated key (an array), an unknown key and a smuggled tenant", () => {
    expect(parse({ ...BASE, store_id: [STORE, STORE_2] }).success).toBe(false);
    expect(parse({ ...BASE, voided: ["true", "false"] }).success).toBe(false);
    expect(parse({ ...BASE, page_size: ["5"] }).success).toBe(false);
    expect(parse({ ...BASE, tenant_id: TENANT }).success).toBe(false);
    expect(parse({ ...BASE, device_ref: STORE }).success).toBe(false);
  });

  it("bounds page_size to 1..100 as an integer string", () => {
    const r = parse({ ...BASE, page_size: "100" });
    expect(r.success && r.data.page_size).toBe(100);
    for (const value of ["0", "101", "2.5", "-1", "1e2"]) expect(parse({ ...BASE, page_size: value }).success).toBe(false);
  });

  it("limits the derived filters and the opaque cursor to the contract values", () => {
    expect(parse({ ...BASE, return_state: "partial", erp_posting_state: "unknown" }).success).toBe(true);
    expect(parse({ ...BASE, return_state: "some" }).success).toBe(false);
    expect(parse({ ...BASE, erp_posting_state: "failed_transient" }).success).toBe(false);
    expect(parse({ ...BASE, cursor: "not a token!" }).success).toBe(false);
    expect(parse({ ...BASE, sale_number: "" }).success).toBe(false);
  });

  it("every filter beyond the store and the range makes the read scan-capped", () => {
    expect(hasAnyFilter(NO_FILTERS)).toBe(false);
    expect(hasAnyFilter({ ...NO_FILTERS, from: "2026-10-05", to: "2026-10-05" })).toBe(false);
    expect(hasAnyFilter({ ...NO_FILTERS, saleNumber: "S-1" })).toBe(true);
    expect(hasAnyFilter({ ...NO_FILTERS, syncStatus: "synced" })).toBe(true);
    expect(hasAnyFilter({ ...NO_FILTERS, voided: false })).toBe(true);
    expect(hasAnyFilter({ ...NO_FILTERS, returnState: "none" })).toBe(true);
    expect(hasAnyFilter({ ...NO_FILTERS, erpPostingState: "posted" })).toBe(true);
  });
});

describe("RT-562 console sales — cursor binding", () => {
  const binding: ConsoleCursorBinding = { tenantId: TENANT, storeId: STORE, filters: NO_FILTERS };
  const keyset = {
    businessDate: "2026-10-05",
    occurredAtKey: "2026-10-04T23:30:00.123456Z",
    saleId: "0a000000-0000-7000-8000-0000000562f1",
  };

  it("round-trips the keyset for the binding it was issued under", () => {
    expect(decodeConsoleSaleCursor(binding, encodeConsoleSaleCursor(binding, keyset))).toEqual(keyset);
  });

  it.each<[string, Partial<ConsoleCursorBinding>]>([
    ["another tenant", { tenantId: TENANT_2 }],
    ["another store", { storeId: STORE_2 }],
    ["another from", { filters: { ...NO_FILTERS, from: "2026-10-02" } }],
    ["another to", { filters: { ...NO_FILTERS, to: "2026-10-30" } }],
    ["a sale number", { filters: { ...NO_FILTERS, saleNumber: "S-1" } }],
    ["a sync status", { filters: { ...NO_FILTERS, syncStatus: "synced" } }],
    ["voided", { filters: { ...NO_FILTERS, voided: true } }],
    ["voided=false", { filters: { ...NO_FILTERS, voided: false } }],
    ["a return state", { filters: { ...NO_FILTERS, returnState: "none" } }],
    ["an ERP state", { filters: { ...NO_FILTERS, erpPostingState: "unknown" } }],
  ])("refuses a cursor reused with %s", (_label, change) => {
    const cursor = encodeConsoleSaleCursor(binding, keyset);
    expect(() => decodeConsoleSaleCursor({ ...binding, ...change }, cursor)).toThrow(InvalidConsoleSaleCursorError);
  });

  it("refuses the POS sale-history cursor for the same tenant, store and range (another operation)", () => {
    const pos = encodeSaleHistoryCursor({
      tenantId: TENANT,
      storeId: STORE,
      filters: { from: "2026-10-01", to: "2026-10-31", deviceRef: null, operatorUserId: null, saleNumber: null },
      keyset,
    });
    expect(() => decodeConsoleSaleCursor(binding, pos)).toThrow(InvalidConsoleSaleCursorError);
  });

  it.each([
    ["garbage", "bm90LWpzb24"],
    ["an empty object", Buffer.from("{}").toString("base64url")],
    ["a rolled-over instant", "at:2026-10-04T24:30:00.000000Z"],
    ["year 0000, which Postgres cannot represent", "at:0000-01-01T00:00:00.000000Z"],
    ["a non-calendar date", "date:2026-02-30"],
    ["an extra key", "extra"],
  ])("refuses %s", (_label, variant) => {
    const good = JSON.parse(Buffer.from(encodeConsoleSaleCursor(binding, keyset), "base64url").toString("utf8"));
    let payload: unknown = variant;
    if (variant.startsWith("at:")) payload = { ...good, at: variant.slice(3) };
    else if (variant.startsWith("date:")) payload = { ...good, date: variant.slice(5) };
    else if (variant === "extra") payload = { ...good, visibility: "store" };
    const token = typeof payload === "string" ? payload : Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(() => decodeConsoleSaleCursor(binding, token)).toThrow(InvalidConsoleSaleCursorError);
  });
});

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

let n = 0;
function row(extra: Partial<SaleHistoryRow> = {}): SaleHistoryRow {
  n += 1;
  const id = `0a000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  return {
    sale_id: id,
    business_date: "2026-10-05",
    occurred_at: new Date("2026-10-05T09:00:00Z"),
    occurred_at_key: `2026-10-05T09:00:00.${String(n).padStart(6, "0")}Z`,
    received_at: new Date("2026-10-05T09:00:01Z"),
    device_id: null,
    device_label: null,
    created_by: "0a000000-0000-7000-8000-0000000562c1",
    user_display_name: "Cashier",
    currency_code: "EGP",
    pos_total: "10.0000",
    sync_status: "synced",
    voided: false,
    return_state: "none",
    erp_status: null,
    receipt_sale_number: null,
    receipt_number: null,
    receipt_terminal_label: null,
    receipt_operator_display_name: null,
    receipt_settled_at: null,
    receipt_branch_name: null,
    receipt_branch_address: null,
    receipt_tax_registration_id: null,
    receipt_change_given: null,
    ...extra,
  };
}

const page = (rows: SaleHistoryRow[], readLimit: number, pageSize: number, filters = NO_FILTERS) =>
  assemblePage({ rows, readLimit, pageSize, storeRef: STORE, filters });

describe("RT-562 console sales — page assembly", () => {
  it("unfiltered: page_size + 1 rows read → a full page resuming after its last row", () => {
    const rows = [row(), row(), row()];
    const p = page(rows, 3, 2);
    expect(p.items.map((i) => i.saleRef)).toEqual([rows[0]!.sale_id, rows[1]!.sale_id]);
    expect(p.resumeAfter?.saleId).toBe(rows[1]!.sale_id);
  });

  it("unfiltered: fewer rows than the read limit → the last page", () => {
    const rows = [row(), row()];
    expect(page(rows, 3, 2)).toMatchObject({ resumeAfter: null });
    expect(page([], 3, 2)).toEqual({ items: [], resumeAfter: null });
  });

  it("derived filter, the read cut at the limit with no match → an EMPTY page with a cursor after the last row read", () => {
    const rows = [row(), row(), row()];
    const p = page(rows, 3, 50, { ...NO_FILTERS, voided: true });
    expect(p.items).toEqual([]);
    expect(p.resumeAfter?.saleId).toBe(rows[2]!.sale_id);
  });

  it("derived filter, the read cut at the limit with some matches → a SHORT page resuming after the last row read", () => {
    const rows = [row({ voided: true }), row(), row()];
    const p = page(rows, 3, 50, { ...NO_FILTERS, voided: true });
    expect(p.items.map((i) => i.saleRef)).toEqual([rows[0]!.sale_id]);
    expect(p.resumeAfter?.saleId).toBe(rows[2]!.sale_id);
  });

  it("derived filter, more matches than page_size → resume after the last RETURNED row", () => {
    const rows = [row({ return_state: "full" }), row(), row({ return_state: "full" }), row({ return_state: "full" })];
    const p = page(rows, 500, 2, { ...NO_FILTERS, returnState: "full" });
    expect(p.items.map((i) => i.saleRef)).toEqual([rows[0]!.sale_id, rows[2]!.sale_id]);
    expect(p.resumeAfter?.saleId).toBe(rows[2]!.sale_id);
  });

  it("derived filter, the range exhausted before the limit → the walk ends", () => {
    const rows = [row({ voided: true }), row()];
    expect(page(rows, 500, 50, { ...NO_FILTERS, voided: true }).resumeAfter).toBeNull();
  });

  it("matches the ERP filter on the PROJECTED state (pending covers failed_transient; unknown covers no row)", () => {
    const rows = [row({ erp_status: "failed_transient" }), row({ erp_status: "pending" }), row({ erp_status: null }), row({ erp_status: "posted" })];
    const ids = (state: "pending" | "unknown" | "posted" | "failed") =>
      page(rows, 500, 50, { ...NO_FILTERS, erpPostingState: state }).items.map((i) => i.saleRef);
    expect(ids("pending")).toEqual([rows[0]!.sale_id, rows[1]!.sale_id]);
    expect(ids("unknown")).toEqual([rows[2]!.sale_id]);
    expect(ids("posted")).toEqual([rows[3]!.sale_id]);
    expect(ids("failed")).toEqual([]);
  });

  it("matches sale_number and sync_status on the projected row", () => {
    const rows = [row({ receipt_sale_number: "S-7" }), row({ sync_status: "failed-retryable" }), row()];
    const ids = (filters: ConsoleSaleFilters) => page(rows, 500, 50, filters).items.map((i) => i.saleRef);
    expect(ids({ ...NO_FILTERS, saleNumber: "S-7" })).toEqual([rows[0]!.sale_id]);
    expect(ids({ ...NO_FILTERS, syncStatus: "failed-retryable" })).toEqual([rows[1]!.sale_id]);
  });

  it("every item carries the listed store and nothing POS-only", () => {
    const [item] = page([row()], 2, 1).items;
    expect(item!.storeRef).toBe(STORE);
    expect(Object.keys(item!).slice(0, 2)).toEqual(["saleRef", "storeRef"]);
    expect(item).not.toHaveProperty("visibility");
  });
});

describe("RT-562 console sales — detail projection and audit metadata", () => {
  it("drops receiptFacts and reprint and adds the store", () => {
    const detail = {
      summary: { saleRef: "s", voided: false },
      lines: [],
      receiptFacts: "complete",
      reprint: { duplicate: "allowed", saleRecord: "allowed", marks: [] },
      erpPosting: { sale: "unknown" },
    } as unknown as SaleHistoryDetail;
    const out = toConsoleSaleDetail(detail, STORE, "Africa/Cairo");
    expect(out).not.toHaveProperty("receiptFacts");
    expect(out).not.toHaveProperty("reprint");
    expect(out).toMatchObject({ storeTimezone: "Africa/Cairo", summary: { saleRef: "s", storeRef: STORE } });
  });

  it("records the store, the filters and the count; the sale number only as a flag; no row ids", () => {
    const parsed = ConsoleSaleListQuerySchema.parse({ ...BASE, sale_number: "S-0042", voided: "false", cursor: "abc" });
    const meta = listAuditOf(STORE, parsed, 3);
    expect(meta).toEqual({
      store_id: STORE,
      from: "2026-10-01",
      to: "2026-10-31",
      sale_number_filtered: true,
      sync_status: null,
      voided: false,
      return_state: null,
      erp_posting_state: null,
      page_size: 50,
      continued: true,
      item_count: 3,
    });
    expect(JSON.stringify(meta)).not.toContain("S-0042");
    expect(consoleFiltersOf(parsed).saleNumber).toBe("S-0042");
  });
});
