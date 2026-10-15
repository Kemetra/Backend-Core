/**
 * toBody.unit.spec.ts — 010-POLISH (T092) Docker-free unit coverage for the
 * money-normalization + representability edges the integration fixtures don't
 * exercise (all-positive-EGP). Closes the `read-down.toBody` branch-coverage gap
 * (normalizeAmount neg / JPY-0-minor / 3-minor; isRepresentable trailing-zeros).
 */
import "reflect-metadata";

import {
  isRepresentable,
  toSellableRow,
  type ResolvedCatalogRow,
} from "../../../src/catalog/read-down/read-down.toBody";

function row(overrides: Partial<ResolvedCatalogRow>): ResolvedCatalogRow {
  return {
    product_id: "p",
    sku: "sku",
    name: "n",
    aliases: [],
    amount: "1.0000",
    currency_code: "EGP",
    tax_category: "standard",
    row_sequence: null,
    ...overrides,
  };
}

describe("isRepresentable — significant fractional digits vs currency minor unit", () => {
  it("EGP (2dp): trailing zeros do NOT count — 8.5000 is representable", () => {
    expect(isRepresentable("8.5000", "EGP")).toBe(true);
    expect(isRepresentable("9.9900", "EGP")).toBe(true);
    expect(isRepresentable("9.000", "EGP")).toBe(true);
  });
  it("EGP (2dp): 9.999 (3 significant) is NOT representable", () => {
    expect(isRepresentable("9.999", "EGP")).toBe(false);
    expect(isRepresentable("9.9990", "EGP")).toBe(false);
  });
  it("JPY (0 minor): any fractional part is NOT representable", () => {
    expect(isRepresentable("100", "JPY")).toBe(true);
    expect(isRepresentable("100.5", "JPY")).toBe(false);
    expect(isRepresentable("100.0000", "JPY")).toBe(true); // trailing zeros strip
  });
  it("KWD (3 minor): up to 3 significant digits is representable", () => {
    expect(isRepresentable("1.234", "KWD")).toBe(true);
    expect(isRepresentable("1.2345", "KWD")).toBe(false);
  });
  it("an unmapped currency defaults to 2 minor digits", () => {
    expect(isRepresentable("1.99", "ZZZ")).toBe(true);
    expect(isRepresentable("1.999", "ZZZ")).toBe(false);
  });
});

describe("toSellableRow — normalizeAmount emits at the currency natural minor precision", () => {
  it("EGP (2dp): 8.5000 → 8.50; 9.9900 → 9.99; 9.0000 → 9.00", () => {
    expect(toSellableRow(row({ amount: "8.5000" }), "c").price.amount).toBe("8.50");
    expect(toSellableRow(row({ amount: "9.9900" }), "c").price.amount).toBe("9.99");
    expect(toSellableRow(row({ amount: "9.0000" }), "c").price.amount).toBe("9.00");
  });
  it("JPY (0 minor): 100.0000 → 100 (no decimal point)", () => {
    expect(
      toSellableRow(row({ amount: "100.0000", currency_code: "JPY" }), "c").price.amount,
    ).toBe("100");
  });
  it("KWD (3 minor): 1.2000 → 1.200", () => {
    expect(
      toSellableRow(row({ amount: "1.2000", currency_code: "KWD" }), "c").price.amount,
    ).toBe("1.200");
  });
  it("integer amount with no decimal point pads to the minor unit (EGP: 5 → 5.00)", () => {
    expect(toSellableRow(row({ amount: "5" }), "c").price.amount).toBe("5.00");
  });
  it("row_cursor falls back to the response cursor when the row has no change-log sequence", () => {
    const out = toSellableRow(row({ row_sequence: null }), "RESP-CURSOR");
    expect(out.row_cursor).toBe("RESP-CURSOR");
  });
  it("row_cursor is an opaque per-row token when a change-log sequence exists", () => {
    const out = toSellableRow(row({ row_sequence: "42" }), "RESP-CURSOR");
    expect(out.row_cursor).not.toBe("RESP-CURSOR");
    expect(typeof out.row_cursor).toBe("string");
    expect(out.row_cursor.length).toBeGreaterThan(0);
  });
  it("a sellable row is always active=true and carries the curated fields only", () => {
    const out = toSellableRow(row({}), "c");
    expect(out.active).toBe(true);
    expect(Object.keys(out).sort()).toEqual(
      ["active", "aliases", "name", "price", "product_id", "row_cursor", "sku", "tax_category"].sort(),
    );
  });
});

describe("isRepresentable — trailing-zero strip runs in linear time (RT-509, S8786)", () => {
  it("rejects a long zero run before a significant digit without backtracking", () => {
    const started = performance.now();
    const representable = isRepresentable(`1.${"0".repeat(100_000)}1`, "EGP");
    expect(performance.now() - started).toBeLessThan(200);
    expect(representable).toBe(false);
  }, 30_000);
});
