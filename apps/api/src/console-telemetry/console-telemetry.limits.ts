/**
 * Bounds of the Console Sentry tunnel (RT-632, OBS-3). The 64 KiB cap is in
 * the contract (`console-telemetry.openapi.yaml`); the buckets are tunable
 * starting values, far above a working Console's error rate.
 */
import type { RateLimitBucket } from "../auth/rate-limit";

/** Byte cap of one envelope (contract: `Envelope.maxLength`, `413 envelope_too_large`). */
export const MAX_ENVELOPE_BYTES = 64 * 1024;

const TEN_MINUTES_MS = 10 * 60 * 1000;

export const CONSOLE_TELEMETRY_BUCKETS = {
  /** Per client IP (`req.ip`, which honours `TRUST_PROXY`). */
  perIp: { limit: 30, windowMs: TEN_MINUTES_MS },
  /** Across all callers: bounds what reaches the Console Sentry project's quota. */
  global: { limit: 600, windowMs: TEN_MINUTES_MS },
} as const satisfies Record<string, RateLimitBucket>;

/** Longest `Retry-After` sent with a 429, in seconds (the window length). */
export const MAX_RETRY_AFTER_SECONDS = 600;
