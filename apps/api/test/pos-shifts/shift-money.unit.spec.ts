/**
 * RT-17 slice 2b — shift cash-up money and time helpers: strict wire
 * precision (#711 review note 4), minor-unit formatting for projections and
 * hashes (#712 review note 4), canonical instants for the payload hash.
 */
import { canonicalInstant, fitsCurrencyPrecision, formatMoney } from "../../src/pos-shifts/shift-money";

describe("fitsCurrencyPrecision — digits as written, never more than the ISO-4217 minor unit", () => {
  it.each([
    ["500.00", "EGP", true],
    ["500", "EGP", true],
    ["500.000", "EGP", false],
    ["500", "JPY", true],
    ["500.0", "JPY", false],
    ["1.250", "KWD", true],
    ["1.2500", "KWD", false],
    ["1", "XAU", false],
    ["1", "ZZZ", false],
  ])("%s %s → %s", (amount, currencyCode, fits) => {
    expect(fitsCurrencyPrecision({ amount, currencyCode })).toBe(fits);
  });
});

describe("formatMoney — the currency's minor-unit digits, padding or dropping zeros only", () => {
  it.each([
    ["500.0000", "EGP", "500.00"],
    ["500", "EGP", "500.00"],
    ["0500.5", "EGP", "500.50"],
    ["500.0000", "JPY", "500"],
    ["12.2500", "KWD", "12.250"],
    ["-5.0000", "EGP", "-5.00"],
    ["-0.0000", "EGP", "0.00"],
    ["0", "JPY", "0"],
    ["1.2345", "XAU", "1.2345"],
  ])("%s %s → %s", (amount, currencyCode, text) => {
    expect(formatMoney({ amount, currencyCode })).toBe(text);
  });

  it("refuses to drop a significant digit", () => {
    expect(() => formatMoney({ amount: "500.005", currencyCode: "EGP" })).toThrow(RangeError);
  });
});

describe("canonicalInstant — one form per instant, any RFC 3339 offset, full precision", () => {
  it.each([
    ["2026-10-05T08:00:00Z", "2026-10-05T08:00:00.000Z"],
    ["2026-10-05T08:00:00.5Z", "2026-10-05T08:00:00.500Z"],
    ["2026-10-05T08:00:00.123456Z", "2026-10-05T08:00:00.1234560Z"],
    ["2026-10-05T10:00:00+02:00", "2026-10-05T08:00:00Z"],
    ["2026-10-05T03:00:00.5-05:00", "2026-10-05T08:00:00.500Z"],
    ["2026-10-05T08:00:00-00:00", "2026-10-05T08:00:00Z"],
    ["2026-10-06T01:30:00.123456+05:30", "2026-10-05T20:00:00.123456Z"],
  ])("%s and %s are the same instant", (a, b) => {
    expect(canonicalInstant(a)).toBe(canonicalInstant(b));
  });

  it.each([
    ["2026-10-05T08:00:00Z", "2026-10-05T08:00:01Z"],
    ["2026-10-05T08:00:00.123456Z", "2026-10-05T08:00:00.123457Z"],
    ["2026-10-05T08:00:00+02:00", "2026-10-05T08:00:00Z"],
  ])("%s and %s differ", (a, b) => {
    expect(canonicalInstant(a)).not.toBe(canonicalInstant(b));
  });
});

describe("canonicalInstant — trailing fraction zeros strip in linear time (RT-509, S8786)", () => {
  it.each([
    ["2026-10-05T08:00:00.120Z", "1791187200.12"],
    ["2026-10-05T08:00:00.000Z", "1791187200"],
    ["2026-10-05T08:00:00.1010Z", "1791187200.101"],
  ])("%s → %s", (value, canonical) => {
    expect(canonicalInstant(value)).toBe(canonical);
  });

  it("keeps a long zero run before a significant digit without backtracking", () => {
    const fraction = `1${"0".repeat(100_000)}1`;
    const started = performance.now();
    const canonical = canonicalInstant(`2026-10-05T08:00:00.${fraction}Z`);
    expect(performance.now() - started).toBeLessThan(200);
    expect(canonical).toBe(`1791187200.${fraction}`);
  }, 30_000);
});
