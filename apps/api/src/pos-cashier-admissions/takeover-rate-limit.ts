/**
 * Per-device takeover rate limit (RT-113 BC2; contract 429 `rate_limited`).
 *
 * Reuses the platform `RateLimiter` (Redis fixed window, the ADR 0009
 * per-device keying used for POS writes). The bucket is
 * `rl:cashierAdmissionTakeover:<device_id>`; its size comes from
 * `CashierAdmissionPolicy.takeoverLimit`.
 *
 * Fail-open (ADR 0009 D3): if the limiter's store is unavailable the takeover
 * is allowed and a warning is logged. The limit is defence in depth; the
 * takeover is still serialised, eligibility-checked and audited, so a Redis
 * outage must not lock a cashier out of "take over here".
 */
import type { Logger } from "@data-pulse-2/shared";

import type { RateLimitBucket, RateLimiter } from "../auth/rate-limit";

export const TAKEOVER_BUCKET_NAME = "cashierAdmissionTakeover";

export interface TakeoverLimit {
  /** Count one takeover attempt for `deviceId`; false when over the limit. */
  allow(deviceId: string, bucket: RateLimitBucket): Promise<boolean>;
}

export class TakeoverRateLimit implements TakeoverLimit {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly logger?: Pick<Logger, "warn">,
  ) {}

  async allow(deviceId: string, bucket: RateLimitBucket): Promise<boolean> {
    try {
      const decision = await this.limiter.check(TAKEOVER_BUCKET_NAME, deviceId, bucket);
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
