/**
 * RT-619 — console rate-limit configuration (RT-574 D3/D4/D6, owner rulings
 * O2/O4 and O3b).
 *
 * Pins the owner-given numbers exactly and the boot-time env parsing: the
 * default mode is `off`, and a typo must never switch the limiter on.
 */
import {
  CONSOLE_COST_CLASSES,
  CONSOLE_RATE_LIMIT_BUDGETS,
  DEFAULT_CONSOLE_RATE_LIMIT_TIMEOUT_MS,
  readConsoleRateLimitConfig,
} from "../../src/console-rate-limit/console-rate-limit.config";

const MINUTE = 60 * 1000;

describe("console rate-limit budgets (RT-574 D3, owner O2/O4)", () => {
  it("has exactly the six cost classes", () => {
    expect([...CONSOLE_COST_CLASSES]).toEqual([
      "cheapRead",
      "expensiveRead",
      "write",
      "jobOrPreview",
      "onboarding",
      "incidentControl",
    ]);
  });

  it("uses the owner-approved starting budgets as given", () => {
    expect(CONSOLE_RATE_LIMIT_BUDGETS).toEqual({
      cheapRead: { limit: 300, windowMs: MINUTE },
      expensiveRead: { limit: 60, windowMs: MINUTE },
      write: { limit: 30, windowMs: MINUTE },
      jobOrPreview: { limit: 10, windowMs: 10 * MINUTE },
      onboarding: { limit: 20, windowMs: 60 * MINUTE },
      incidentControl: { limit: 120, windowMs: 10 * MINUTE },
    });
  });
});

describe("readConsoleRateLimitConfig (RT-574 D6, owner O3b)", () => {
  it("defaults to mode off and a 250 ms timeout when nothing is set", () => {
    expect(readConsoleRateLimitConfig({})).toEqual({ mode: "off", timeoutMs: 250 });
    expect(DEFAULT_CONSOLE_RATE_LIMIT_TIMEOUT_MS).toBe(250);
  });

  it.each(["off", "report", "enforce"] as const)("accepts mode %s", (mode) => {
    expect(readConsoleRateLimitConfig({ CONSOLE_RATE_LIMIT_MODE: mode }).mode).toBe(mode);
  });

  it("accepts surrounding whitespace and any letter case", () => {
    expect(readConsoleRateLimitConfig({ CONSOLE_RATE_LIMIT_MODE: " Report " }).mode).toBe("report");
  });

  it.each(["", "on", "enforced", "true", "1"])("falls back to off for %p (a typo never enables it)", (value) => {
    expect(readConsoleRateLimitConfig({ CONSOLE_RATE_LIMIT_MODE: value }).mode).toBe("off");
  });

  it.each([
    ["1", 1],
    ["10000", 10_000],
    ["500", 500],
  ])("accepts timeout %s", (raw, expected) => {
    expect(readConsoleRateLimitConfig({ CONSOLE_RATE_LIMIT_TIMEOUT_MS: raw }).timeoutMs).toBe(expected);
  });

  it.each(["0", "10001", "-5", "abc", "2.5", ""])("falls back to 250 ms for timeout %p", (raw) => {
    expect(readConsoleRateLimitConfig({ CONSOLE_RATE_LIMIT_TIMEOUT_MS: raw }).timeoutMs).toBe(250);
  });
});
