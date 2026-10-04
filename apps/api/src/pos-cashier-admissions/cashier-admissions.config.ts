/**
 * Cashier-admission server policy (RT-113 BC2).
 *
 * Read per request from the environment (the repo's gate convention, e.g.
 * `isPosReturnsEnabled`), so a changed policy reaches every terminal on its
 * next heartbeat: the contract requires `admitted` to carry the TTL the
 * server actually applied.
 *
 * | Variable                               | Default | Meaning |
 * | -------------------------------------- | ------- | ------- |
 * | `CASHIER_ADMISSION_TTL_SECONDS`        | 43200   | Server TTL of a live admission (10763 §3: 12 h). 1 … 604800 (7 days). |
 * | `CASHIER_OFFLINE_GRACE_SECONDS`        | 86400   | `offline_grace_seconds` on `admitted` (028 OQ-1: 24 h). ≥ 0. |
 * | `CASHIER_TAKEOVER_RATE_LIMIT`          | 10      | Takeover requests allowed per device per window. ≥ 1. |
 * | `CASHIER_TAKEOVER_RATE_WINDOW_SECONDS` | 3600    | The takeover window. ≥ 1. |
 *
 * An unset, non-integer or out-of-range value falls back to the default: a
 * typo must not disable the single-active rule or the rate limit.
 */
import type { RateLimitBucket } from "../auth/rate-limit";

export const DEFAULT_ADMISSION_TTL_SECONDS = 43_200;
export const DEFAULT_OFFLINE_GRACE_SECONDS = 86_400;
export const DEFAULT_TAKEOVER_RATE_LIMIT = 10;
export const DEFAULT_TAKEOVER_RATE_WINDOW_SECONDS = 3_600;

const MAX_ADMISSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface CashierAdmissionPolicy {
  /** TTL applied to a live admission (and the replay window's upper bound). */
  readonly admissionTtlSeconds: number;
  /** The bound the terminal uses for its sealed offline grant. */
  readonly offlineGraceSeconds: number;
  /** Per-device takeover budget. */
  readonly takeoverLimit: RateLimitBucket;
}

type Env = Readonly<Record<string, string | undefined>>;

interface IntSetting {
  readonly name: string;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
}

function readInt(env: Env, setting: IntSetting): number {
  const raw = (env[setting.name] ?? "").trim();
  if (!/^\d+$/.test(raw)) return setting.fallback;
  const value = Number(raw);
  return value >= setting.min && value <= setting.max ? value : setting.fallback;
}

export function readCashierAdmissionPolicy(env: Env = process.env): CashierAdmissionPolicy {
  const windowSeconds = readInt(env, {
    name: "CASHIER_TAKEOVER_RATE_WINDOW_SECONDS",
    fallback: DEFAULT_TAKEOVER_RATE_WINDOW_SECONDS,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  return {
    admissionTtlSeconds: readInt(env, {
      name: "CASHIER_ADMISSION_TTL_SECONDS",
      fallback: DEFAULT_ADMISSION_TTL_SECONDS,
      min: 1,
      max: MAX_ADMISSION_TTL_SECONDS,
    }),
    offlineGraceSeconds: readInt(env, {
      name: "CASHIER_OFFLINE_GRACE_SECONDS",
      fallback: DEFAULT_OFFLINE_GRACE_SECONDS,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    takeoverLimit: {
      limit: readInt(env, {
        name: "CASHIER_TAKEOVER_RATE_LIMIT",
        fallback: DEFAULT_TAKEOVER_RATE_LIMIT,
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      }),
      windowMs: windowSeconds * 1000,
    },
  };
}
