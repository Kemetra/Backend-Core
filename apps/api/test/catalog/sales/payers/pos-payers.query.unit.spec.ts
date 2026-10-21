/**
 * RT-802 — the `posListChargeablePayers` query and keyset cursor
 * (`pos-payers.openapi.yaml` 1.0.0-draft, RT-570). Docker-free.
 *
 * Pins the strict query (`category`, `cursor`, `page_size` only; an unknown or
 * repeated key is a 400), the page size (default 50, 1..200) and the opaque
 * cursor: it holds only the last payerRef and is bound to the operation, the
 * tenant, the store and the `category` filter, so anything else (a Console raw
 * uuid cursor, another store's or category's token) is a 400.
 */
import {
  decodePosPayersCursor,
  encodePosPayersCursor,
  InvalidPosPayersCursorError,
  POS_PAYERS_PAGE_SIZE_DEFAULT,
  PosPayersQuerySchema,
} from "../../../../src/catalog/sales/payers/pos-payers.query";

const TENANT = "0a802000-0000-4000-8000-000000000001";
const TENANT_OTHER = "0a802000-0000-4000-8000-000000000002";
const STORE = "0a802000-0000-4000-8000-0000000000a1";
const STORE_OTHER = "0a802000-0000-4000-8000-0000000000a2";
const PAYER = "0a802000-0000-7000-8000-0000000000c1";

const SCOPE = { tenantId: TENANT, storeId: STORE, category: null } as const;

describe("RT-802 posListChargeablePayers query", () => {
  it("accepts an empty query and defaults page_size to 50", () => {
    expect(PosPayersQuerySchema.parse({})).toEqual({});
    expect(POS_PAYERS_PAGE_SIZE_DEFAULT).toBe(50);
  });

  it("accepts category, cursor and page_size within bounds", () => {
    expect(PosPayersQuerySchema.parse({ category: "insurer", cursor: "abc_-1", page_size: "200" })).toEqual({
      category: "insurer",
      cursor: "abc_-1",
      page_size: 200,
    });
  });

  it.each([
    ["an unknown key", { store_id: STORE }],
    ["a free-text search", { q: "Ahmed" }],
    ["a malformed category", { category: "bank" }],
    ["a repeated category", { category: ["insurer", "corporate"] }],
    ["page_size 0", { page_size: "0" }],
    ["page_size 201", { page_size: "201" }],
    ["a fractional page_size", { page_size: "1.5" }],
    ["an empty cursor", { cursor: "" }],
    ["a cursor outside the alphabet", { cursor: "a+b/c=" }],
    ["a cursor over 512 chars", { cursor: "a".repeat(513) }],
  ])("refuses %s", (_label, query) => {
    expect(PosPayersQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("RT-802 posListChargeablePayers cursor", () => {
  it("round-trips the last payerRef for the same tenant, store and category", () => {
    const cursor = encodePosPayersCursor({ ...SCOPE, lastPayerRef: PAYER });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePosPayersCursor({ ...SCOPE, cursor })).toBe(PAYER);
  });

  it("never carries anything but the binding and the id", () => {
    const cursor = encodePosPayersCursor({ ...SCOPE, category: "insurer", lastPayerRef: PAYER });
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["c", "i", "k", "s", "t"]);
    expect(payload["i"]).toBe(PAYER);
  });

  it.each([
    ["another tenant", { tenantId: TENANT_OTHER }],
    ["another store", { storeId: STORE_OTHER }],
    ["another category", { category: "insurer" as const }],
  ])("refuses a cursor reused for %s", (_label, other) => {
    const cursor = encodePosPayersCursor({ ...SCOPE, lastPayerRef: PAYER });
    expect(() => decodePosPayersCursor({ ...SCOPE, ...other, cursor })).toThrow(InvalidPosPayersCursorError);
  });

  it("refuses a category cursor reused without the filter", () => {
    const cursor = encodePosPayersCursor({ ...SCOPE, category: "corporate", lastPayerRef: PAYER });
    expect(() => decodePosPayersCursor({ ...SCOPE, cursor })).toThrow(InvalidPosPayersCursorError);
  });

  it.each([
    ["a raw uuid (the Console cursor)", PAYER],
    ["undecodable base64", "____"],
    ["another operation's token", Buffer.from(JSON.stringify({ k: "sale_history", t: TENANT, s: STORE, c: null, i: PAYER })).toString("base64url")],
    ["a non-uuid id", Buffer.from(JSON.stringify({ k: "pos_payers", t: TENANT, s: STORE, c: null, i: "x" })).toString("base64url")],
    ["an extra field", Buffer.from(JSON.stringify({ k: "pos_payers", t: TENANT, s: STORE, c: null, i: PAYER, n: "name" })).toString("base64url")],
  ])("refuses %s", (_label, cursor) => {
    expect(() => decodePosPayersCursor({ ...SCOPE, cursor })).toThrow(InvalidPosPayersCursorError);
  });
});
