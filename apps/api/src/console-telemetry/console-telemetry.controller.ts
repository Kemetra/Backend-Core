/**
 * Console Sentry tunnel and its runtime config (RT-632, OBS-3), contract
 * `console-telemetry.openapi.yaml`.
 *
 * `GET config` tells the immutable Console bundle whether to start its SDK:
 * `{ tunnel, environment }`, or `204` when inert. It never returns the DSN;
 * the Console uses a placeholder DSN, which the tunnel ignores.
 *
 * The Admin-Console runs under `connect-src 'self'`, so its Sentry SDK posts
 * envelopes here (`tunnel` option) and this route forwards the scrubbed error
 * event to the Console Sentry project named by `CONSOLE_SENTRY_DSN`.
 *
 * `@Public()` (decision recorded on RT-632): Console errors can happen before
 * sign-in, so no credential is required and the session cookie is never read.
 * Abuse is bounded instead by, in order: a trusted `Origin` (RT-430 rule,
 * missing refused), a per-IP and a global rate limit, the media type and a
 * 64 KiB cap enforced while reading. The order keeps the cheap checks first
 * and reads no body from a caller that is refused.
 *
 * Every accepted outcome is the same `204` (forwarded, dropped by the
 * scrubber, rate-limit store unavailable, or inert), so the response says
 * nothing about the configuration. Nothing here logs the body.
 */
import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { assertTrustedOrigin } from "../auth/origin-check";
import { RateLimiter, type RateLimitBucket, type RateLimitDecision } from "../auth/rate-limit";
import { Public } from "../auth/route-auth";
import { ConsoleTelemetryForwarder } from "./console-telemetry.forwarder";
import {
  CONSOLE_TELEMETRY_BUCKETS,
  MAX_ENVELOPE_BYTES,
  MAX_RETRY_AFTER_SECONDS,
} from "./console-telemetry.limits";
import { EnvelopeMalformedError, buildForwardEnvelope } from "./envelope";
import { assertEnvelopeMediaType, readEnvelopeBody } from "./read-envelope-body";

const ROUTE_PREFIX = "api/v1/console/telemetry";
const TUNNEL_PATH = `/${ROUTE_PREFIX}/envelope`;

/** Contract `ConsoleTelemetryConfig`. */
export interface ConsoleTelemetryConfig {
  tunnel: string;
  environment: string;
}

/** The contract's 429 `RATE_LIMITED`, `Retry-After` clamped to [1, 600]. */
function rateLimited(res: Response, resetMs: number): HttpException {
  const resetSeconds = resetMs < 0 ? 1 : Math.ceil(resetMs / 1000);
  res.setHeader("Retry-After", String(Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, resetSeconds))));
  return new HttpException(
    { code: "RATE_LIMITED", message: "Too many telemetry envelopes." },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

@Public()
@Controller(ROUTE_PREFIX)
export class ConsoleTelemetryController {
  constructor(
    private readonly forwarder: ConsoleTelemetryForwarder,
    private readonly rateLimiter: RateLimiter,
  ) {}

  @Get("config")
  config(@Res({ passthrough: true }) res: Response): ConsoleTelemetryConfig | undefined {
    res.setHeader("Cache-Control", "no-store");
    const environment = this.forwarder.environment;
    if (environment === null) {
      res.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return { tunnel: TUNNEL_PATH, environment };
  }

  @Post("envelope")
  @HttpCode(HttpStatus.NO_CONTENT)
  async forwardEnvelope(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const environment = this.forwarder.environment;
    if (environment === null) return;
    assertTrustedOrigin(req);
    if (!(await this.withinBudget(req, res))) return;
    assertEnvelopeMediaType(req);

    const body = await readEnvelopeBody(req, MAX_ENVELOPE_BYTES);
    let envelope: Buffer | null;
    try {
      envelope = buildForwardEnvelope(body, environment);
    } catch (err: unknown) {
      if (!(err instanceof EnvelopeMalformedError)) throw err;
      throw new BadRequestException({ code: "envelope_malformed", message: err.message });
    }
    if (envelope !== null) this.forwarder.forward(envelope);
  }

  /**
   * Throws 429 when a budget is spent. Returns false (drop, still 204) when
   * the rate-limit store is unavailable: telemetry fails closed and quiet.
   */
  private async withinBudget(req: Request, res: Response): Promise<boolean> {
    const ip = String(req.ip ?? req.socket?.remoteAddress ?? "unknown");
    const checks: Array<[string, string, RateLimitBucket]> = [
      ["console_telemetry_ip", ip, CONSOLE_TELEMETRY_BUCKETS.perIp],
      ["console_telemetry_global", "global", CONSOLE_TELEMETRY_BUCKETS.global],
    ];
    for (const [bucketName, identifier, bucket] of checks) {
      let decision: RateLimitDecision;
      try {
        decision = await this.rateLimiter.check(bucketName, identifier, bucket);
      } catch {
        return false;
      }
      if (!decision.allowed) throw rateLimited(res, decision.resetMs);
    }
    return true;
  }
}
