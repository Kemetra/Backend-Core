/**
 * PosWriteRateLimitGuard — ADR 0009 (audit M-2).
 *
 * A per-DEVICE throughput ceiling on POS write endpoints (sale capture,
 * settlement-intent). Layered AFTER `PosOperatorEnvelopeSaleGuard`, so
 * `request.principal` is already the resolved `pos_operator` token principal.
 *
 * Keying (ADR 0009 D1): the bucket identifier is the bound DEVICE, recovered
 * from the token via `OperatorReverifier.recoverDeviceId(principal.tokenId)`.
 * Per-IP collapses a store's NAT'd terminals; per-token resets the budget every
 * 8h re-sign-in. Per-device is the stable, abuse-resistant subject.
 *
 * Over-limit: `RateLimiter.check` not-allowed → 429 Too Many Requests with a
 * `Retry-After` header (seconds, clamped [1, 300]), mirroring the existing
 * sign-in / pairing 429 convention.
 *
 * Fail-open (ADR 0009 D3): if the rate-limiter throws (Redis outage) OR the
 * device id cannot be resolved, the guard ALLOWS the request and logs a warn.
 * The throttle is defence-in-depth, not the primary correctness control
 * (idempotency + live operator re-verification are independent), so a
 * rate-limiter datastore outage must NEVER convert into a selling outage. This
 * is the same observe-and-degrade posture as ADR 0010 D1. The metric/alert
 * counter is AD-TOOL-003-phase-gated and lands separately; this is the warn-log.
 */
import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Logger } from "@data-pulse-2/shared";

import { ROOT_LOGGER } from "../common/logging.interceptor";
import {
  OPERATOR_CONTEXT_RESOLVER,
  type OperatorReverifier,
} from "./operator-context-resolver";
import {
  POS_WRITE_RATE_LIMIT_BUCKET_KEY,
  type PosWriteBucketName,
} from "./pos-write-rate-limit.decorator";
import { POS_WRITE_RATE_LIMIT_BUCKETS, RateLimiter } from "./rate-limit";

@Injectable()
export class PosWriteRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: RateLimiter,
    @Inject(OPERATOR_CONTEXT_RESOLVER)
    private readonly reverifier: OperatorReverifier,
    private readonly reflector: Reflector,
    // ROOT_LOGGER is provided app-wide by RootLoggerModule (RT-124). It stays
    // @Optional() for standalone test modules; when absent `this.logger?.warn`
    // no-ops and the fail-open ALLOW still happens (correctness is independent
    // of the log).
    @Optional()
    @Inject(ROOT_LOGGER)
    private readonly logger?: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Per-route bucket comes from the @PosWriteRateLimitBucket decorator (the
    // per-route-config-for-an-enhancer pattern — a class-referenced guard is one
    // shared instance, so policy MUST be route metadata, not constructor state).
    // A route without the annotation is NOT throttled — allow it (the guard is
    // inert until a route opts in).
    const bucketName = this.reflector.get<PosWriteBucketName | undefined>(
      POS_WRITE_RATE_LIMIT_BUCKET_KEY,
      context.getHandler(),
    );
    if (!bucketName) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<{
      principal?: { kind: string; scope: string; tokenId: string | null } | null;
    }>();
    const principal = request.principal;

    // The envelope guard runs first and guarantees a pos_operator token
    // principal; defensively, if it is absent we do not invent a key — allow and
    // let the upstream guard's decision stand (this guard only THROTTLES).
    if (!principal || principal.kind !== "token" || principal.tokenId === null) {
      return true;
    }

    // D1: resolve the device dimension. A lookup miss is fail-open (D3) — never
    // hard-block a write because the device row could not be read.
    let deviceId: string | null;
    try {
      deviceId = await this.reverifier.recoverDeviceId(principal.tokenId);
    } catch (err) {
      this.logger?.warn(
        { err },
        "PosWriteRateLimitGuard: device-id resolution failed; failing open (request allowed)",
      );
      return true;
    }
    if (deviceId === null) {
      this.logger?.warn(
        { tokenId: principal.tokenId },
        "PosWriteRateLimitGuard: no device id for token; failing open (request allowed)",
      );
      return true;
    }

    // Check the per-device bucket. Fail-open (D3) on any rate-limiter error.
    let decision;
    try {
      decision = await this.rateLimiter.check(
        bucketName,
        deviceId,
        POS_WRITE_RATE_LIMIT_BUCKETS[bucketName],
      );
    } catch (err) {
      this.logger?.warn(
        { err, deviceId },
        "PosWriteRateLimitGuard: rate-limiter unavailable; failing open (request allowed)",
      );
      return true;
    }

    if (!decision.allowed) {
      const retryAfter = Math.min(
        300,
        Math.max(1, Math.ceil((decision.resetMs < 0 ? 0 : decision.resetMs) / 1000)),
      );
      http.getResponse<{ setHeader: (k: string, v: string) => void }>().setHeader(
        "Retry-After",
        String(retryAfter),
      );
      throw new HttpException(
        { code: "RATE_LIMITED", message: "Too many requests." },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
