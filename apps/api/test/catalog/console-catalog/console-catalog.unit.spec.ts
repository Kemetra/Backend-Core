/**
 * RT-730 (CAT-R2) — Docker-free units of the console catalog read: the query
 * schema, the filter-bound keyset cursor, the ILIKE escaping and the stored
 * amount rendering shared with the read-down.
 */
import {
  catalogFiltersOf,
  CatalogProductListQuerySchema,
  decodeCatalogCursor,
  encodeCatalogCursor,
  InvalidCatalogCursorError,
  substringPattern,
  type CatalogCursorBinding,
  type CatalogProductKeyset,
} from "../../../src/catalog/console-catalog/console-catalog.query";
import { normalizeAmount } from "../../../src/catalog/read-down/read-down.toBody";
import { storedAmount, storeOverrideJoinSql } from "../../../src/catalog/store-resolution/store-product-resolution";

const TENANT = "0a000000-0000-7000-8000-00000000ada1";
const OTHER_TENANT = "0b000000-0000-7000-8000-00000000bdb1";
const PRODUCT = "0a000000-0000-7000-8000-0000007301a1";
const STORE = "0a000000-0000-7000-8000-00000000a5a1";

const BINDING: CatalogCursorBinding = {
  tenantId: TENANT,
  filters: { q: "water", status: "active", categoryId: null, storeId: STORE },
};
const KEYSET: CatalogProductKeyset = { matchRank: 1, name: "Water 1.5L", productId: PRODUCT };

describe("console catalog — list query schema", () => {
  const parse = (q: Record<string, unknown>) => CatalogProductListQuerySchema.safeParse(q);

  it("accepts the documented keys and defaults status to active", () => {
    const r = parse({ q: "000123", status: "any", category_id: STORE.toUpperCase(), store_id: STORE, limit: "100" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.limit).toBe(100);
    expect(r.success && r.data.category_id).toBe(STORE);
    expect(catalogFiltersOf({})).toEqual({ q: null, status: "active", categoryId: null, storeId: null });
  });

  it.each([
    ["an unknown key", { tenant_id: TENANT }],
    ["a repeated key", { q: ["a", "b"] }],
    ["an empty q", { q: "" }],
    ["a q over 100 code points", { q: "x".repeat(101) }],
    ["a lone surrogate", { q: "a\uD800" }],
    ["a NUL", { q: "a\u0000" }],
    ["an unknown status", { status: "deleted" }],
    ["limit 0", { limit: "0" }],
    ["limit 101", { limit: "101" }],
    ["a non-integer limit", { limit: "5.5" }],
    ["a malformed store_id", { store_id: "not-a-uuid" }],
    ["a cursor with padding", { cursor: "abc=" }],
  ])("rejects %s", (_label, query) => {
    expect(parse(query).success).toBe(false);
  });

  it("counts q in code points, not UTF-16 units", () => {
    expect(parse({ q: "😀".repeat(100) }).success).toBe(true);
  });
});

describe("console catalog — keyset cursor", () => {
  it("round-trips the keyset under the same tenant and filters", () => {
    expect(decodeCatalogCursor(BINDING, encodeCatalogCursor(BINDING, KEYSET))).toEqual(KEYSET);
  });

  it("holds a 500 code-point name within the contract's 4096 characters", () => {
    const longest = { ...KEYSET, name: "😀".repeat(500) };
    const cursor = encodeCatalogCursor(BINDING, longest);
    expect(cursor.length).toBeLessThanOrEqual(4096);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCatalogCursor(BINDING, cursor)).toEqual(longest);
  });

  it.each([
    ["another tenant", { ...BINDING, tenantId: OTHER_TENANT }],
    ["another q", { ...BINDING, filters: { ...BINDING.filters, q: "Water" } }],
    ["another status", { ...BINDING, filters: { ...BINDING.filters, status: "any" as const } }],
    ["another category", { ...BINDING, filters: { ...BINDING.filters, categoryId: STORE } }],
    ["no store", { ...BINDING, filters: { ...BINDING.filters, storeId: null } }],
  ])("is rejected under %s", (_label, binding) => {
    const cursor = encodeCatalogCursor(BINDING, KEYSET);
    expect(() => decodeCatalogCursor(binding, cursor)).toThrow(InvalidCatalogCursorError);
  });

  function tampered(edit: (bytes: Buffer) => Buffer): string {
    return edit(Buffer.from(encodeCatalogCursor(BINDING, KEYSET), "base64url")).toString("base64url");
  }

  it.each([
    ["a foreign token", "c2FsZXM"],
    ["a truncated token", tampered((b) => b.subarray(0, 50))],
    ["another version", tampered((b) => Buffer.concat([Buffer.from([2]), b.subarray(1)]))],
    ["a match rank of 2", tampered((b) => Buffer.concat([b.subarray(0, 1), Buffer.from([2]), b.subarray(2)]))],
    ["an invalid UTF-8 name", tampered((b) => Buffer.concat([b.subarray(0, 50), Buffer.from([0xc3, 0x28])]))],
    ["a NUL in the name", tampered((b) => Buffer.concat([b.subarray(0, 50), Buffer.from("a\u0000", "utf8")]))],
    ["a name over 500 code points", tampered((b) => Buffer.concat([b.subarray(0, 50), Buffer.from("x".repeat(501))]))],
  ])("rejects %s", (_label, cursor) => {
    expect(() => decodeCatalogCursor(BINDING, cursor)).toThrow(InvalidCatalogCursorError);
  });
});

describe("console catalog — name pattern", () => {
  it("makes %, _ and \\ literal", () => {
    expect(substringPattern("50%_off\\x")).toBe("%50\\%\\_off\\\\x%");
    expect(substringPattern("water")).toBe("%water%");
  });
});

describe("store resolution — shared amount and join", () => {
  it("renders a representable amount exactly as the read-down does", () => {
    for (const [amount, currency] of [
      ["8.5000", "EGP"],
      ["100.0000", "JPY"],
      ["1.2340", "KWD"],
      ["0.0000", "EGP"],
    ] as const) {
      expect(storedAmount(amount, currency)).toBe(normalizeAmount(amount, currency));
    }
    expect(storedAmount("8.5000", "EGP")).toBe("8.50");
  });

  it("keeps a non-representable amount's significant digits, never rounding", () => {
    expect(storedAmount("9.9990", "EGP")).toBe("9.999");
    expect(storedAmount("100.5000", "JPY")).toBe("100.5");
  });

  it("accepts only a placeholder as the store reference", () => {
    expect(storeOverrideJoinSql("$10::uuid")).toContain("spo.store_id = $10::uuid");
    expect(() => storeOverrideJoinSql("'x' OR TRUE")).toThrow();
  });
});
