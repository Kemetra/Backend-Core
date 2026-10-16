/**
 * RT-539 (RT-534 S3) — the sale-history query, cursor and reprint body
 * (`pos-sales/sale-history.yaml` 1.0.0-draft). Docker-free.
 *
 * Pins the OD-534-4 bounds (both dates required and inclusive, at most 31
 * business days, never truncated), the strict query (an unknown key is a 400),
 * the page size (default 50, 1..100), the opaque keyset cursor (bound to the
 * tenant, the store, the operation and the filters; anything else is a 400)
 * and the `localCopyNumber` rule of SaleReprintRequest (required with
 * `record`, forbidden with `authorize`).
 */
import {
  decodeSaleHistoryCursor,
  encodeSaleHistoryCursor,
  InvalidSaleHistoryCursorError,
  PAGE_SIZE_DEFAULT,
  SaleHistoryListQuerySchema,
  SaleReprintRequestSchema,
  type SaleHistoryFilters,
} from "../../../../src/catalog/sales/history/sale-history.query";

const TENANT = "0a539000-0000-4000-8000-000000000001";
const TENANT_OTHER = "0a539000-0000-4000-8000-000000000002";
const STORE = "0a539000-0000-4000-8000-0000000000a1";
const STORE_OTHER = "0a539000-0000-4000-8000-0000000000a2";
const SALE = "0a539000-0000-4000-8000-0000000000c1";

const FILTERS: SaleHistoryFilters = {
  from: "2026-10-01",
  to: "2026-10-16",
  deviceRef: null,
  operatorUserId: null,
  saleNumber: null,
};
const KEYSET = { businessDate: "2026-10-15", occurredAtKey: "2026-10-15T09:30:00.123456Z", saleId: SALE };

function parse(query: Record<string, unknown>) {
  return SaleHistoryListQuerySchema.safeParse(query);
}

describe("listSaleHistory query (OD-534-4)", () => {
  it("accepts an inclusive range and defaults page_size to 50", () => {
    const r = parse({ from: "2026-10-01", to: "2026-10-01" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.page_size).toBe(PAGE_SIZE_DEFAULT);
    expect(PAGE_SIZE_DEFAULT).toBe(50);
  });

  it("accepts exactly 31 business days (to - from = 30)", () => {
    expect(parse({ from: "2026-10-01", to: "2026-10-31" }).success).toBe(true);
  });

  it("refuses 32 business days (to - from = 31): never truncated", () => {
    expect(parse({ from: "2026-10-01", to: "2026-11-01" }).success).toBe(false);
  });

  it("counts the span on the calendar across a month and a leap day", () => {
    expect(parse({ from: "2028-02-01", to: "2028-03-02" }).success).toBe(true); // 30 days
    expect(parse({ from: "2028-02-01", to: "2028-03-03" }).success).toBe(false); // 31 days
  });

  it("refuses to before from", () => {
    expect(parse({ from: "2026-10-02", to: "2026-10-01" }).success).toBe(false);
  });

  it.each([
    ["a missing from", { to: "2026-10-01" }],
    ["a missing to", { from: "2026-10-01" }],
    ["an impossible date", { from: "2026-02-30", to: "2026-03-01" }],
    ["year zero", { from: "0000-01-01", to: "0000-01-02" }],
    ["a date-time", { from: "2026-10-01T00:00:00Z", to: "2026-10-02" }],
    ["a repeated key", { from: ["2026-10-01", "2026-10-02"], to: "2026-10-03" }],
    ["an unknown key", { from: "2026-10-01", to: "2026-10-01", store_id: STORE }],
    ["a non-uuid device_ref", { from: "2026-10-01", to: "2026-10-01", device_ref: "till-1" }],
    ["a non-uuid operator_user_id", { from: "2026-10-01", to: "2026-10-01", operator_user_id: "x" }],
    ["an empty sale_number", { from: "2026-10-01", to: "2026-10-01", sale_number: "" }],
    ["a 97-character sale_number", { from: "2026-10-01", to: "2026-10-01", sale_number: "x".repeat(97) }],
    ["page_size 0", { from: "2026-10-01", to: "2026-10-01", page_size: "0" }],
    ["page_size 101", { from: "2026-10-01", to: "2026-10-01", page_size: "101" }],
    ["a fractional page_size", { from: "2026-10-01", to: "2026-10-01", page_size: "1.5" }],
    ["a non-numeric page_size", { from: "2026-10-01", to: "2026-10-01", page_size: "ten" }],
    ["a cursor with padding", { from: "2026-10-01", to: "2026-10-01", cursor: "abc=" }],
  ])("refuses %s (400)", (_label, query) => {
    expect(parse(query).success).toBe(false);
  });

  it("parses page_size from its query string and lower-cases the ids", () => {
    const r = parse({
      from: "2026-10-01",
      to: "2026-10-01",
      page_size: "100",
      device_ref: STORE.toUpperCase(),
      operator_user_id: SALE.toUpperCase(),
      sale_number: "till-1-2026-10-01-000001",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toMatchObject({ page_size: 100, device_ref: STORE, operator_user_id: SALE });
  });
});

describe("sale-history cursor (tenant, store, operation and filters bound)", () => {
  const cursor = encodeSaleHistoryCursor({ tenantId: TENANT, storeId: STORE, filters: FILTERS, keyset: KEYSET });

  it("round-trips the keyset, opaque base64url", () => {
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSaleHistoryCursor({ tenantId: TENANT, storeId: STORE, filters: FILTERS, cursor })).toEqual(KEYSET);
  });

  it.each([
    ["another tenant", { tenantId: TENANT_OTHER, storeId: STORE, filters: FILTERS }],
    ["another store", { tenantId: TENANT, storeId: STORE_OTHER, filters: FILTERS }],
    ["another range", { tenantId: TENANT, storeId: STORE, filters: { ...FILTERS, to: "2026-10-15" } }],
    ["another device filter", { tenantId: TENANT, storeId: STORE, filters: { ...FILTERS, deviceRef: SALE } }],
    ["another operator filter", { tenantId: TENANT, storeId: STORE, filters: { ...FILTERS, operatorUserId: SALE } }],
    ["another sale number", { tenantId: TENANT, storeId: STORE, filters: { ...FILTERS, saleNumber: "n-1" } }],
  ])("is refused when reused for %s", (_label, scope) => {
    expect(() => decodeSaleHistoryCursor({ ...scope, cursor })).toThrow(InvalidSaleHistoryCursorError);
  });

  function forged(payload: unknown): string {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  }

  it.each([
    ["garbage", "not-a-cursor"],
    ["a JSON array", forged([1, 2])],
    ["another operation's cursor", forged({ k: "shift_closes", t: TENANT, c: "2026-10-15T09:30:00.123456Z", s: SALE })],
    ["an impossible business date", reissue({ d: "2026-02-30" })],
    ["an impossible instant", reissue({ o: "2026-10-15T25:30:00.123456Z" })],
    ["a millisecond instant", reissue({ o: "2026-10-15T09:30:00.123Z" })],
    ["a non-uuid sale id", reissue({ i: "sale-1" })],
    ["an extra field", reissue({ x: 1 })],
  ])("refuses %s", (_label, token) => {
    expect(() => decodeSaleHistoryCursor({ tenantId: TENANT, storeId: STORE, filters: FILTERS, cursor: token })).toThrow(
      InvalidSaleHistoryCursorError,
    );
  });

  /** The issued cursor with some fields replaced (a hand-edited token). */
  function reissue(patch: Record<string, unknown>): string {
    const issued = JSON.parse(
      Buffer.from(
        encodeSaleHistoryCursor({ tenantId: TENANT, storeId: STORE, filters: FILTERS, keyset: KEYSET }),
        "base64url",
      ).toString("utf8"),
    ) as Record<string, unknown>;
    return forged({ ...issued, ...patch });
  }
});

describe("SaleReprintRequest (RT-537 D-7, Q-5)", () => {
  const printedAt = "2026-10-16T08:00:00.000Z";

  it("accepts authorize without localCopyNumber and record with it", () => {
    expect(SaleReprintRequestSchema.safeParse({ mode: "authorize", kind: "duplicate", printedAt }).success).toBe(true);
    expect(
      SaleReprintRequestSchema.safeParse({ mode: "record", kind: "sale_record", printedAt, localCopyNumber: 2 }).success,
    ).toBe(true);
  });

  it.each([
    ["record without localCopyNumber", { mode: "record", kind: "duplicate", printedAt }],
    ["authorize with localCopyNumber", { mode: "authorize", kind: "duplicate", printedAt, localCopyNumber: 1 }],
    ["localCopyNumber 0", { mode: "record", kind: "duplicate", printedAt, localCopyNumber: 0 }],
    ["a fractional localCopyNumber", { mode: "record", kind: "duplicate", printedAt, localCopyNumber: 1.5 }],
    ["an unknown mode", { mode: "replay", kind: "duplicate", printedAt }],
    ["an unknown kind", { mode: "authorize", kind: "original", printedAt }],
    ["a missing printedAt", { mode: "authorize", kind: "duplicate" }],
    ["a printedAt without a zone", { mode: "authorize", kind: "duplicate", printedAt: "2026-10-16T08:00:00" }],
    ["a year-zero printedAt", { mode: "authorize", kind: "duplicate", printedAt: "0000-10-16T08:00:00Z" }],
    ["an unknown field", { mode: "authorize", kind: "duplicate", printedAt, saleRef: SALE }],
  ])("refuses %s (400)", (_label, body) => {
    expect(SaleReprintRequestSchema.safeParse(body).success).toBe(false);
  });
});
