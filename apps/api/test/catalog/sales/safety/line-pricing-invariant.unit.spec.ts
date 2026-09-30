/**
 * line-pricing-invariant.unit.spec.ts — RT-105 (RT-87 decision D).
 *
 * Docker-free coverage of the sale-line price invariant captureSale enforces:
 * a line's `unitPrice` / `lineAmount` fit the currency's minor unit,
 * `lineAmount = unitPrice × quantity` exactly, and `quantity` is whole. Only
 * such a line can be returned exactly: the Connector posts a return at the
 * original rate × returned quantity, which ERPNext keeps at currency precision.
 */
import {
  findLinePricingViolation,
  type PricedLineInput,
} from "../../../../src/catalog/sales/sale-line-pricing";

function line(overrides: Partial<PricedLineInput> = {}): PricedLineInput {
  return { unitPrice: "3.33", quantity: "3", lineAmount: "9.99", currencyCode: "EGP", ...overrides };
}

describe("RT-105 — sale-line price invariant", () => {
  describe("accepts a conforming line", () => {
    it.each([
      ["a 2dp price times a whole quantity", line()],
      ["trailing zeros in the price and amount", line({ unitPrice: "3.3300", lineAmount: "9.9900" })],
      ["a whole quantity written with zero decimals", line({ quantity: "3.000000" })],
      ["a free line", line({ unitPrice: "0", quantity: "5", lineAmount: "0.0000" })],
      ["a 0-minor currency", line({ currencyCode: "JPY", unitPrice: "100", quantity: "2", lineAmount: "200" })],
      ["a 3-minor currency", line({ currencyCode: "KWD", unitPrice: "1.125", quantity: "2", lineAmount: "2.250" })],
      [
        "the largest price at the column bound",
        line({ unitPrice: "0.01", quantity: "9999999999999", lineAmount: "99999999999.99" }),
      ],
    ])("%s", (_name, l) => {
      expect(findLinePricingViolation([l])).toBeNull();
    });
  });

  describe("rejects a line that cannot be returned exactly", () => {
    it.each([
      ["lineAmount is not unitPrice × quantity", line({ lineAmount: "10.00" })],
      ["unitPrice has more decimals than the currency allows", line({ unitPrice: "3.3333", lineAmount: "9.9999" })],
      ["lineAmount has more decimals than the currency allows", line({ unitPrice: "1.00", quantity: "1", lineAmount: "1.005" })],
      ["quantity is fractional, even when the product holds", line({ unitPrice: "2.00", quantity: "0.5", lineAmount: "1.00" })],
      ["a 0-minor currency with a fractional price", line({ currencyCode: "JPY", unitPrice: "100.5", quantity: "2", lineAmount: "201" })],
      ["the bench shape: 1 of 3 at 3.3333 for 10.00", line({ unitPrice: "3.3333", quantity: "3", lineAmount: "10.00" })],
    ])("%s", (_name, l) => {
      expect(findLinePricingViolation([l])).toBe(0);
    });
  });

  it("reports the index of the first violating line", () => {
    expect(findLinePricingViolation([line(), line(), line({ lineAmount: "10.00" }), line({ quantity: "0.5" })])).toBe(2);
  });
});
