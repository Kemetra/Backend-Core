/**
 * Per-device takeover rate limit (RT-113 BC2; contract 429 `rate_limited`).
 *
 * Reuses the platform `RateLimiter` (Redis fixed window, the ADR 0009
 * per-device keying used for POS writes). The bucket is
 * `rl:cashierAdmissionTakeover:<device_id>`; its size comes from
 * `CashierAdmissionPolicy.takeoverLimit`.
 *
 * Fail-open (ADR 0009 D3): if the limiter's store is unavailable, or does not
 * answer within `timeoutMs` (default 250 ms), the takeover is allowed and a
 * warning is logged. The check runs inside the admission transaction while
 * both advisory locks and a pool connection are held, so it is bounded: an
 * ioredis client with an offline queue and retries could otherwise hold them
 * for seconds. There is no limiter-error metric in the repo yet (ADR 0009's
 * counter is AD-TOOL-003-phase-gated); the warning is the signal. The limit is defence in depth; the
 * takeover is still serialised, eligibility-checked and audited, so a Redis
 * outage must not lock a cashier out of "take over here".
 */
import type { Logger } from "@data-pulse-2/shared";

import type { RateLimitBucket, RateLimiter } from "../auth/rate-limit";
import { DEFAULT_TAKEOVER_LIMITER_TIMEOUT_MS } from "./cashier-admissions.config";

export const TAKEOVER_BUCKET_NAME = "cashierAdmissionTakeover";

export interface TakeoverRateLimitOptions {
  /** Max wait for the limiter's store before failing open. */
  readonly timeoutMs: number;
}

class TakeoverLimiterTimeout extends Error {
  override readonly name = "TakeoverLimiterTimeout";
}

/** Reject after `ms`; the timer never keeps the process alive. */
function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new TakeoverLimiterTimeout()), ms).unref();
  });
}

export interface TakeoverLimit {
  /** Count one takeover attempt for `deviceId`; false when over the limit. */
  allow(deviceId: string, bucket: RateLimitBucket): Promise<boolean>;
}

export class TakeoverRateLimit implements TakeoverLimit {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly logger?: Pick<Logger, "warn">,
    private readonly options: TakeoverRateLimitOptions = { timeoutMs: DEFAULT_TAKEOVER_LIMITER_TIMEOUT_MS },
  ) {}

  async allow(deviceId: string, bucket: RateLimitBucket): Promise<boolean> {
    try {
      const decision = await Promise.race([
        this.limiter.check(TAKEOVER_BUCKET_NAME, deviceId, bucket),
        timeout(this.options.timeoutMs),
      ]);
      return decision.allowed;
    } catch (err) {
      this.logger?.warn(
        { device_id: deviceId, err_class: err instanceof Error ? err.name : typeof err },
        "cashier admission takeover limiter unavailable; failing open (request allowed)",
      );
      return true;
    }
  }
}
