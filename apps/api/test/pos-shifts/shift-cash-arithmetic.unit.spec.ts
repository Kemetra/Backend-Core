/**
 * RT-17 slice 2b-2 — the closeShift arithmetic invariant, in exact decimal
 * (`pos-shifts.openapi.yaml` 1.1.0-draft, `CloseShiftRequest`):
 *
 *   expectedCash = openingFloat + cashSalesTotal − cashRefundsTotal + payInTotal − payOutTotal
 *   variance     = countedCash − expectedCash
 *
 * with `openingFloat` equal to the float recorded at open. Amounts are
 * strings; nothing is parsed into a JS number.
 */
import {
  closeFitsCurrency,
  isCashUpConsistent,
  type CashUpTotals,
} from "../../src/pos-shifts/shift-cash-arithmetic";

const TOTALS: CashUpTotals = {
  openingFloat: "500.00",
  cashSalesTotal: "2450.00",
  cashRefundsTotal: "75.00",
  payInTotal: "0.00",
  payOutTotal: "120.00",
  expectedCash: "2755.00",
  countedCash: "2750.00",
  variance: "-5.00",
};

const LARGEST = "999999999999999.9999";

/** A close's totals checked against the float recorded at open. */
interface ArithmeticCase {
  readonly totals: Partial<CashUpTotals>;
  readonly recordedFloat?: string;
}

const consistent = (c: ArithmeticCase): boolean =>
  isCashUpConsistent({ ...TOTALS, ...c.totals }, c.recordedFloat ?? "500.0000");

const largest: ArithmeticCase = {
  totals: {
    openingFloat: LARGEST,
    cashSalesTotal: "0",
    cashRefundsTotal: "0",
    payOutTotal: "0",
    expectedCash: LARGEST,
    countedCash: "0",
    variance: `-${LARGEST}`,
  },
  recordedFloat: LARGEST,
};

describe("isCashUpConsistent", () => {
  it.each<[string, ArithmeticCase]>([
    ["the contract example", { totals: {} }],
    ["spellings of the same amounts", { totals: { openingFloat: "500", countedCash: "2750.0", variance: "-5" } }],
    ["a zero variance", { totals: { countedCash: "2755.00", variance: "0.00" } }],
    ["a negative zero variance", { totals: { countedCash: "2755.00", variance: "-0.00" } }],
    ["an overage", { totals: { countedCash: "2760.50", variance: "5.50" } }],
    ["4-digit amounts", { totals: { cashSalesTotal: "2450.0001", expectedCash: "2755.0001", variance: "-5.0001" } }],
    ["the largest amounts", largest],
  ])("%s holds", (_label, c) => {
    expect(consistent(c)).toBe(true);
  });

  it.each<[string, ArithmeticCase]>([
    ["expectedCash off by 0.0001", { totals: { expectedCash: "2755.0001", variance: "-5.0001" } }],
    ["variance off by one cent", { totals: { variance: "-5.01" } }],
    ["a variance of the wrong sign", { totals: { variance: "5.00" } }],
    ["a pay-in left out", { totals: { payInTotal: "10.00" } }],
    ["refunds added instead of subtracted", { totals: { expectedCash: "2905.00", variance: "-155.00" } }],
    ["an openingFloat other than the one recorded", { totals: { openingFloat: "600.00", expectedCash: "2855.00", variance: "-105.00" } }],
    ["a float recorded at another amount", { totals: {}, recordedFloat: "500.0100" }],
  ])("%s does not hold", (_label, c) => {
    expect(consistent(c)).toBe(false);
  });
});

describe("closeFitsCurrency — every close amount within the currency's minor unit", () => {
  it.each<[string, Partial<CashUpTotals>, boolean]>([
    ["EGP", {}, true],
    ["EGP", { variance: "-5.001", countedCash: "2749.999" }, false],
    ["EGP", { payInTotal: "0.000" }, false],
    ["JPY", {}, false],
    ["KWD", { cashSalesTotal: "2450.125" }, true],
  ])("%s %j → %s", (currencyCode, totals, fits) => {
    expect(closeFitsCurrency({ totals: { ...TOTALS, ...totals }, currencyCode })).toBe(fits);
  });
});
