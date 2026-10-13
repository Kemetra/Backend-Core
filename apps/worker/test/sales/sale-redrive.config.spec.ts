/**
 * RT-457 — sale re-drive interval / minimum-age resolution: defaults, valid
 * overrides, and boot refusal on anything else.
 */
import {
  DEFAULT_SALE_REDRIVE_INTERVAL_MS,
  DEFAULT_SALE_REDRIVE_MIN_AGE_MS,
  resolveSaleRedriveIntervalMs,
  resolveSaleRedriveMinAgeMs,
} from "../../src/sales/sale-redrive.config";

describe("sale re-drive config (RT-457)", () => {
  it("defaults to a 5-minute interval and a 15-minute minimum age", () => {
    expect(resolveSaleRedriveIntervalMs({})).toBe(DEFAULT_SALE_REDRIVE_INTERVAL_MS);
    expect(resolveSaleRedriveMinAgeMs({ SALE_REDRIVE_MIN_AGE_MS: "  " })).toBe(DEFAULT_SALE_REDRIVE_MIN_AGE_MS);
  });

  it("accepts whole milliseconds of at least one minute", () => {
    expect(resolveSaleRedriveIntervalMs({ SALE_REDRIVE_INTERVAL_MS: "60000" })).toBe(60_000);
    expect(resolveSaleRedriveMinAgeMs({ SALE_REDRIVE_MIN_AGE_MS: "3600000" })).toBe(3_600_000);
  });

  it.each(["59999", "1.5e6", "-60000", "ten"])("refuses %p", (raw) => {
    expect(() => resolveSaleRedriveIntervalMs({ SALE_REDRIVE_INTERVAL_MS: raw })).toThrow(/SALE_REDRIVE_INTERVAL_MS/);
    expect(() => resolveSaleRedriveMinAgeMs({ SALE_REDRIVE_MIN_AGE_MS: raw })).toThrow(/SALE_REDRIVE_MIN_AGE_MS/);
  });
});
