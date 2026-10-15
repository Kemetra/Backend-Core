/**
 * RT-509 (S8786) — `canonicalDecimal` equivalence table plus a linear-time
 * guard on the trailing-zero strip. Docker-free.
 */
import { canonicalDecimal } from "../../src/erpnext-reconciliation/reconciliation-run.processor";

describe("canonicalDecimal — one string per exact decimal value", () => {
  it.each([
    ["10", "10"],
    ["10.000000", "10"],
    ["10.0", "10"],
    ["007.10", "7.1"],
    ["0", "0"],
    ["-0.0", "0"],
    ["-5.500", "-5.5"],
    ["0.000100", "0.0001"],
  ])("%s → %s", (value, canonical) => {
    expect(canonicalDecimal(value)).toBe(canonical);
  });

  it("strips a long trailing-zero run behind a significant digit without backtracking", () => {
    const value = `1.${"0".repeat(100_000)}1`;
    const started = performance.now();
    const canonical = canonicalDecimal(value);
    expect(performance.now() - started).toBeLessThan(200);
    expect(canonical).toBe(value);
  }, 30_000);
});
