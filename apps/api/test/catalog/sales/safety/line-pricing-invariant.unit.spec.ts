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
  type PricedLineDiscountInput,
  type PricedLineInput,
} from "../../../../src/catalog/sales/sale-line-pricing";
import { minorUnitExponent } from "../../../../src/catalog/sales/iso4217-minor-units";

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
      // Comment 10537 gap 2: exponents beyond the read-down map come from ISO 4217.
      ["OMR at its 3 minor digits", line({ currencyCode: "OMR", unitPrice: "1.234", quantity: "2", lineAmount: "2.468" })],
      ["CLF at its 4 minor digits", line({ currencyCode: "CLF", unitPrice: "1.2345", quantity: "2", lineAmount: "2.4690" })],
      ["KRW at 0 minor digits", line({ currencyCode: "KRW", unitPrice: "1000", quantity: "3", lineAmount: "3000" })],
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
      // Comment 10537 gap 2: no assumed 2 minor digits for a currency the read-down map lacks.
      ["KRW (0 minor) with a fractional price", line({ currencyCode: "KRW", unitPrice: "1.5", quantity: "2", lineAmount: "3" })],
      ["OMR (3 minor) with 4 fractional digits", line({ currencyCode: "OMR", unitPrice: "1.2345", quantity: "2", lineAmount: "2.469" })],
      ["a code whose ISO-4217 minor unit is N.A. (XAU)", line({ currencyCode: "XAU", unitPrice: "3", lineAmount: "9" })],
      ["the ISO-4217 no-currency code (XXX)", line({ currencyCode: "XXX", unitPrice: "3", lineAmount: "9" })],
      ["a code that is not in ISO 4217 (ZZZ)", line({ currencyCode: "ZZZ", unitPrice: "3", lineAmount: "9" })],
    ])("%s", (_name, l) => {
      expect(findLinePricingViolation([l])).toBe(0);
    });
  });

  describe("ISO-4217 minor units (comment 10537 gap 2)", () => {
    it.each([
      ["JPY", 0], ["KRW", 0], ["CLP", 0], ["VND", 0], ["XOF", 0],
      ["EGP", 2], ["USD", 2], ["EUR", 2], ["ZWG", 2], ["XCG", 2],
      ["KWD", 3], ["BHD", 3], ["OMR", 3], ["JOD", 3], ["TND", 3], ["IQD", 3], ["LYD", 3],
      ["CLF", 4], ["UYW", 4],
    ])("%s has %i minor digits", (code, exponent) => {
      expect(minorUnitExponent(code)).toBe(exponent);
    });

    it.each(["XAU", "XAG", "XDR", "XTS", "XXX", "ZZZ", "egp", ""])("%s has no minor unit", (code) => {
      expect(minorUnitExponent(code)).toBeNull();
    });
  });

  it("reports the index of the first violating line", () => {
    expect(findLinePricingViolation([line(), line(), line({ lineAmount: "10.00" }), line({ quantity: "0.5" })])).toBe(2);
  });
});

/**
 * RT-740 (sales.yaml 1.13.0-draft, RT-699 doc 28 option C-A): a discounted
 * line carries its NET, `lineAmount = unitPrice × quantity − discount.amount`,
 * and the discount's own arithmetic holds (percent: half up on the line gross,
 * OD-28-3; amount: value = amount). Without `discount` nothing changes.
 */
describe("RT-740 — the invariant with a manual discount", () => {
  function pct(value: string, amount: string): PricedLineDiscountInput {
    return { kind: "percent", value, amount };
  }
  function off(value: string, amount: string = value): PricedLineDiscountInput {
    return { kind: "amount", value, amount };
  }
  /** A discounted line: unit price, quantity, net, discount, currency (EGP unless named). */
  function priced(
    unitPrice: string,
    quantity: string,
    lineAmount: string,
    discount: PricedLineDiscountInput,
    currencyCode = "EGP",
  ): PricedLineInput {
    return { unitPrice, quantity, lineAmount, currencyCode, discount };
  }
  /** 2 × 45.00 = 90.00 gross (doc 28 §5 receipt example). */
  function gross90(lineAmount: string, discount: PricedLineDiscountInput): PricedLineInput {
    return { unitPrice: "45.00", quantity: "2", lineAmount, currencyCode: "EGP", discount };
  }

  describe("accepts a conforming discounted line", () => {
    it.each([
      ["10% of 90.00 is 9.00, net 81.00 (doc 28 §5)", gross90("81.00", pct("10", "9.00"))],
      ["trailing zeros compare numerically", gross90("81.0000", pct("10", "9.0000"))],
      ["5.00 off 90.00, net 85.00", gross90("85.00", off("5.00"))],
      ["an amount discount written with other trailing zeros", gross90("85.00", off("5", "5.0000"))],
      ["100% makes a free line: net 0 (OD-28-4)", gross90("0", pct("100", "90.00"))],
      ["an amount equal to the gross makes a free line", gross90("0.00", off("90.00"))],
      // Half up on the line gross, once (doc 28 §8): 45 × 10% = 4.5 → 5; 44 × 10% = 4.4 → 4.
      [
        "half up at the boundary: 0.45 at 10% rounds 0.045 up to 0.05",
        priced("0.45", "1", "0.40", pct("10", "0.05")),
      ],
      [
        "half up below the boundary: 0.44 at 10% rounds 0.044 down to 0.04",
        priced("0.44", "1", "0.40", pct("10", "0.04")),
      ],
      [
        "computed on the line gross, never per unit: 3 × 0.15 at 10% is 0.045 → 0.05",
        priced("0.15", "3", "0.40", pct("10", "0.05")),
      ],
      [
        "a percent that rounds to 0 gives amount 0 and the gross: 1% of 0.01",
        priced("0.01", "1", "0.01", pct("1", "0")),
      ],
      [
        "a 0-minor currency rounds to whole units: 15% of JPY 1003 is 150.45 → 150",
        priced("1003", "1", "853", pct("15", "150"), "JPY"),
      ],
      [
        "a 3-minor currency: 10% of KWD 1.125 × 2 is 0.225",
        priced("1.125", "2", "2.025", pct("10", "0.225"), "KWD"),
      ],
      [
        "a net that does not divide by quantity is still a valid capture (2.99 over 3)",
        priced("1.00", "3", "2.99", off("0.01")),
      ],
      [
        "near the column bound: 0.01 × 9999999999999 at 100%",
        priced("0.01", "9999999999999", "0", pct("100", "99999999999.99")),
      ],
    ])("%s", (_name, l) => {
      expect(findLinePricingViolation([l])).toBeNull();
    });
  });

  describe("rejects a discounted line whose arithmetic does not hold", () => {
    it.each([
      ["lineAmount is the gross, not the net", gross90("90.00", pct("10", "9.00"))],
      ["lineAmount is not gross − amount", gross90("80.00", pct("10", "9.00"))],
      ["percent amount rounded down instead of half up", priced("0.45", "1", "0.41", pct("10", "0.04"))],
      ["percent amount computed per unit (3 × round(0.015) = 0.06)", priced("0.15", "3", "0.39", pct("10", "0.06"))],
      ["percent amount that does not match its value", gross90("72.00", pct("10", "18.00"))],
      ["an amount discount whose value differs from its amount", gross90("85.00", off("4.00", "5.00"))],
      ["an amount beyond the minor unit", gross90("84.995", off("5.005"))],
      ["a percent value outside 1–100", gross90("0", pct("101", "90.00"))],
      ["a percent value of 0", gross90("90.00", pct("0", "0"))],
      ["a fractional percent value", gross90("85.50", pct("5.0", "4.50"))],
      ["a fractional quantity, discount or not", priced("2.00", "0.5", "0.90", pct("10", "0.10"))],
      ["a currency with no ISO-4217 minor unit", priced("3", "3", "8", off("1"), "XAU")],
    ])("%s", (_name, l) => {
      expect(findLinePricingViolation([l as PricedLineInput])).toBe(0);
    });
  });

  it("a line without discount is unchanged: its net must equal its gross", () => {
    expect(findLinePricingViolation([line()])).toBeNull();
    expect(findLinePricingViolation([line({ lineAmount: "8.99" })])).toBe(0);
  });

  it("a zero-total sale: every line discounted 100% conforms", () => {
    const free = (unitPrice: string, quantity: string, gross: string): PricedLineInput => ({
      unitPrice,
      quantity,
      lineAmount: "0.00",
      currencyCode: "EGP",
      discount: pct("100", gross),
    });
    expect(findLinePricingViolation([free("45.00", "2", "90.00"), free("12.50", "1", "12.50")])).toBeNull();
  });

  it("mixes discounted and plain lines and reports the first bad one", () => {
    expect(
      findLinePricingViolation([line(), gross90("81.00", pct("10", "9.00")), gross90("80.00", pct("10", "9.00"))]),
    ).toBe(2);
  });
});
