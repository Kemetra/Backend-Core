/**
 * 027 POS Terminal-Pairing CONSUME — controller (`posPairTerminal`).
 *
 * Implements POST /api/pos/v1/terminals/pair from the binding contract
 *   packages/contracts/openapi/pos-terminal-pairing.openapi.yaml
 * (the canonical POS path — every other POS surface is `/api/pos/v1/...`).
 *
 * AUTH — `security: []` (FR-002): this is the ONLY unauthenticated POS operation
 * (pairing IS the bootstrap that issues the device_token; the terminal has no
 * credential yet). The global fail-closed guard denies every unmarked route.
 * `@Public()` is the explicit opt-out for this one.
 * It is deliberately NOT `@Auditable`: the success carries a SECRET
 * (`device_token`) and MUST emit no audit payload (§VII).
 *
 * The closed result union from `PairingService.pair` maps 1:1 to the contract's
 * closed error set, surfaced through the GlobalExceptionFilter (which honours a
 * user-supplied `error.code`). NestJS has no `GoneException`, so 410 is a raw
 * `HttpException`. The minted `device_token` and the `pairing_code` are NEVER
 * logged or echoed anywhere but the 200 body.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { RATE_LIMIT_BUCKETS, RateLimiter } from "../auth/rate-limit";
import {
  TerminalPairRequestSchema,
  type TerminalPairResponseBody,
} from "./dto/terminal-pair.dto";
import { PairingService } from "./pairing.service";
import { Public } from "../auth/route-auth";

@Public()
@Controller()
export class PairingController {
  constructor(
    private readonly service: PairingService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /**
   * Consume a one-time pairing code. Anonymous (no guard). Success → 200 with the
   * device_token ONCE; the closed error set is thrown with the contract's exact
   * fine-grained `error.code` at the contract's status.
   */
  @Post("api/pos/v1/terminals/pair")
  @HttpCode(HttpStatus.OK)
  async pair(
    @Body() rawBody: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TerminalPairResponseBody> {
    // Source-IP throttling runs before validation and code lookup so malformed
    // bodies and unknown codes cannot be used as an unlimited enumeration path.
    // req.ip is derived by Express from the explicitly configured trust-proxy
    // policy; this code never reads X-Forwarded-For directly.
    const ip = String(req.ip ?? req.socket?.remoteAddress ?? "unknown");
    const ipDecision = await this.rateLimiter.check(
      "pairing_ip",
      ip,
      RATE_LIMIT_BUCKETS.pairingPerIp,
    );
    if (!ipDecision.allowed) {
      const resetSeconds = ipDecision.resetMs < 0
        ? 1
        : Math.ceil(ipDecision.resetMs / 1000);
      res.setHeader("Retry-After", String(Math.min(300, Math.max(1, resetSeconds))));
      throw new HttpException(
        { code: "RATE_LIMITED", message: "Too many pairing attempts." },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Validate in-controller (not via the shared ZodValidationPipe) so a bad body
    // surfaces the contract's `validation_failure` code rather than the global
    // `validation_error` — the contract's closed error enum is `validation_failure`
    // and POS-Pulse's failure-mapping switches on that exact key.
    const parsed = TerminalPairRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        code: "validation_failure",
        message: "Request body did not match TerminalPairRequest.",
      });
    }

    const result = await this.service.pair(parsed.data.pairing_code);

    switch (result.kind) {
      case "ok":
        return result.body;

      case "invalid":
        // Non-disclosing 404 — absent / cross-tenant codes share this (§XIV).
        throw new NotFoundException({
          code: "INVALID_CODE",
          message: "Pairing code not found.",
        });

      case "expired":
        // 410 — used / cancelled / past expiry (NestJS has no GoneException).
        throw new HttpException(
          { code: "EXPIRED_CODE", message: "Pairing code is no longer redeemable." },
          HttpStatus.GONE,
        );

      case "already_paired":
        throw new ConflictException({
          code: "ALREADY_PAIRED",
          message: "Terminal is already paired under this branch.",
        });

      case "branch_mismatch":
        throw new ConflictException({
          code: "BRANCH_MISMATCH",
          message: "Terminal is already paired under a different branch.",
        });

      case "rate_limited": {
        // Retry-After in seconds, clamped to the contract's [1, 300].
        const retryAfter = Math.min(300, Math.max(1, result.retryAfterSeconds));
        res.setHeader("Retry-After", String(retryAfter));
        throw new HttpException(
          { code: "RATE_LIMITED", message: "Too many pairing attempts." },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }
}
