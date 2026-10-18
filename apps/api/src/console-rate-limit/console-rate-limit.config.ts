/**
 * Console rate limiting — the one configuration module (RT-619, RT-574
 * issue 1). Every number the console limiter uses lives here.
 *
 * Budgets (RT-574 D3) are the owner-approved STARTING defaults (rulings
 * O2/O4, 2026-10-17): six cost classes, `incidentControl` a separate,
 * generous 120 per 10 minutes. They are tunable, not contract: calibrate from
 * `report`-mode telemetry before any enforce flip (RT-622).
 *
 * Boot-time environment:
 *
 * | Variable                         | Default | Meaning |
 * |----------------------------------|---------|---------|
 * | `CONSOLE_RATE_LIMIT_MODE`        | `off`   | `off` / `report` / `enforce` (O3b). Anything else is `off`: a typo never switches the limiter on. |
 * | `CONSOLE_RATE_LIMIT_TIMEOUT_MS`  | 250     | Max wait for the limiter's store before failing open (D4). 1 … 10000; anything else is 250. |
 *
 * Enabling `report` or `enforce` in any environment is RT-622 (owner,
 * production configuration); merging this module changes no behaviour.
 */
import type { RateLimitBucket } from "../auth/rate-limit";

export const CONSOLE_COST_CLASSES = [
  "cheapRead",
  "expensiveRead",
  "write",
  "jobOrPreview",
  "onboarding",
  "incidentControl",
] as const;
export type ConsoleCostClass = (typeof CONSOLE_COST_CLASSES)[number];

/** A resolved route class: a cost class, or `exempt` (shared exemption list). */
export type ConsoleRateLimitClass = ConsoleCostClass | "exempt";

const MINUTE_MS = 60 * 1000;

/** Fixed window per user per class (RT-574 D3; owner O2/O4). */
export const CONSOLE_RATE_LIMIT_BUDGETS: Readonly<Record<ConsoleCostClass, RateLimitBucket>> = {
  cheapRead: { limit: 300, windowMs: MINUTE_MS },
  expensiveRead: { limit: 60, windowMs: MINUTE_MS },
  write: { limit: 30, windowMs: MINUTE_MS },
  jobOrPreview: { limit: 10, windowMs: 10 * MINUTE_MS },
  onboarding: { limit: 20, windowMs: 60 * MINUTE_MS },
  incidentControl: { limit: 120, windowMs: 10 * MINUTE_MS },
};

export const CONSOLE_RATE_LIMIT_MODES = ["off", "report", "enforce"] as const;
export type ConsoleRateLimitMode = (typeof CONSOLE_RATE_LIMIT_MODES)[number];

/** O3b: unset means off. */
export const DEFAULT_CONSOLE_RATE_LIMIT_MODE: ConsoleRateLimitMode = "off";
/** D4: the bound on a limiter call before failing open (same as the takeover limiter). */
export const DEFAULT_CONSOLE_RATE_LIMIT_TIMEOUT_MS = 250;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 10_000;

/** D4: open after 5 consecutive failures; probe with one request after 10 s. */
export const CONSOLE_RATE_LIMIT_BREAKER = { failureThreshold: 5, openMs: 10_000 } as const;

/** D6: an allowed hit at or above this share of the budget counts `near_limit`. */
export const CONSOLE_RATE_LIMIT_NEAR_LIMIT_RATIO = 0.5;

/** D5: `Retry-After` clamp (seconds). A deliberate exception to the POS [1,300]. */
export const CONSOLE_RETRY_AFTER_MIN_SECONDS = 1;
export const CONSOLE_RETRY_AFTER_MAX_SECONDS = 3600;

/** D6: warn logs (would-limit, fail-open) at most once per class per interval. */
export const CONSOLE_RATE_LIMIT_LOG_INTERVAL_MS = 60_000;

/** Redis key namespace: `rl:console_<class>:u:<userId>` / `…:t:<tokenId>` (D2). */
export const CONSOLE_RATE_LIMIT_BUCKET_PREFIX = "console_";

export interface ConsoleRateLimitConfig {
  readonly mode: ConsoleRateLimitMode;
  readonly timeoutMs: number;
}

/** DI token for the boot-time config. */
export const CONSOLE_RATE_LIMIT_CONFIG = "CONSOLE_RATE_LIMIT_CONFIG";

type Env = Readonly<Record<string, string | undefined>>;

function readMode(raw: string | undefined): ConsoleRateLimitMode {
  const value = (raw ?? "").trim().toLowerCase();
  return (CONSOLE_RATE_LIMIT_MODES as readonly string[]).includes(value)
    ? (value as ConsoleRateLimitMode)
    : DEFAULT_CONSOLE_RATE_LIMIT_MODE;
}

function readTimeoutMs(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (!/^\d+$/.test(value)) return DEFAULT_CONSOLE_RATE_LIMIT_TIMEOUT_MS;
  const parsed = Number(value);
  return parsed >= MIN_TIMEOUT_MS && parsed <= MAX_TIMEOUT_MS ? parsed : DEFAULT_CONSOLE_RATE_LIMIT_TIMEOUT_MS;
}

/** Read once at boot. Invalid values fall back to the safe defaults. */
export function readConsoleRateLimitConfig(env: Env = process.env): ConsoleRateLimitConfig {
  return {
    mode: readMode(env["CONSOLE_RATE_LIMIT_MODE"]),
    timeoutMs: readTimeoutMs(env["CONSOLE_RATE_LIMIT_TIMEOUT_MS"]),
  };
}
