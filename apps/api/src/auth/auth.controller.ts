/**
 * AuthController — slice 3c.
 *
 * Implements the seven endpoints in
 * `specs/001-foundation-auth-tenant-store/contracts/auth.openapi.yaml`.
 *
 * Cross-cutting:
 *   - Bodies are validated by Zod schemas via `ZodValidationPipe`. Bad
 *     bodies bubble as `ZodError`, which the global filter renders as
 *     a 400 `validation_error` envelope.
 *   - Errors are thrown (UnauthorizedException, BadRequestException,
 *     HttpException(429)). The global filter shapes them into the
 *     uniform error envelope. FR-ISO-4: 401 / 404 / 403 share the
 *     envelope shape, so `unauthorized` and `not_found` look identical
 *     to a caller (the differing `code` is the only signal).
 *   - Cookie attributes are `HttpOnly; SameSite=Lax`; `Secure` is set
 *     in production. Tests run with NODE_ENV=test so the cookie is
 *     accepted over HTTP.
 *   - Rate limits are enforced HERE, before any DB work, using the
 *     slice-3b RateLimiter + RATE_LIMIT_BUCKETS.
 *   - Real email delivery is OUT OF SCOPE: the service calls a NoOp
 *     `EmailJobEnqueuer` by default. T112/T113 swap in BullMQ.
 */
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AuthService } from "./auth.service";
import { AuthGuard, type AuthedRequest, readSessionCookie, SESSION_COOKIE_NAME } from "./auth.guard";
import { Public } from "./route-auth";
import {
  RATE_LIMIT_BUCKETS,
  RateLimiter,
} from "./rate-limit";
import {
  EmailVerifyConfirmSchema,
  PasswordResetConfirmSchema,
  PasswordResetRequestSchema,
  SignInSchema,
  type EmailVerifyConfirmInput,
  type PasswordResetConfirmInput,
  type PasswordResetRequestInput,
  type SignInInput,
} from "./dto";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  recordAuthFailure,
  recordSuspiciousLogin,
} from "../observability/metrics/api.metrics";

/**
 * Rate-limit bucket names that represent failed sign-in attempts. A 429 on
 * one of these counts as both an auth failure (cause="rate_limited") and a
 * suspicious-login event (reason="rapid_retry"). The pwreset bucket is NOT
 * an authentication attempt and is intentionally excluded.
 */
const SIGNIN_RATE_LIMIT_BUCKETS = new Set<string>([
  "signin_account",
  "signin_ip",
]);

/** Conforms to OpenAPI `SignInResponse`. */
interface SignInResponseBody {
  user: {
    id: string;
    email: string;
    display_name: string | null;
    is_platform_admin: boolean;
  };
  /**
   * Memberships are part of the contract but the slice-3c surface does
   * not yet ship a memberships repository — controller returns an empty
   * array. The dashboard chooser feature lands in a later slice.
   */
  memberships: never[];
}

const RATE_LIMIT_429: HttpException = new HttpException(
  "Too many requests",
  HttpStatus.TOO_MANY_REQUESTS,
);

@Controller("api/v1/auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  // ---------------------------------------------------------------------
  // POST /signin — public; sets session cookie on 200.
  // ---------------------------------------------------------------------

  @Public()
  @Post("signin")
  @HttpCode(HttpStatus.OK)
  async signIn(
    @Body(new ZodValidationPipe(SignInSchema)) body: SignInInput,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignInResponseBody> {
    const ip = readClientIp(req);
    await this.guardRateLimit("signin_account", body.email, RATE_LIMIT_BUCKETS.signInPerAccount);
    await this.guardRateLimit("signin_ip", ip, RATE_LIMIT_BUCKETS.signInPerIp);

    const result = await this.authService.signIn(body);

    setSessionCookie(res, result.sessionCredential, result.absoluteExpiresAt);

    // `memberships` is part of the OpenAPI shape but its source
    // repository isn't in this slice — return an empty array so the
    // wire schema is satisfied; a later slice fills it in.
    return {
      user: result.user,
      memberships: [],
    };
  }

  // ---------------------------------------------------------------------
  // POST /signout — guarded; revokes session and clears cookie.
  // ---------------------------------------------------------------------

  @Post("signout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard)
  async signOut(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const principal = req.principal;
    if (!principal || principal.kind !== "session") {
      // Bearer-token callers can't "sign out" a session — guard already
      // accepted them, but the contract is cookie-only. Treat as 401.
      throw new UnauthorizedException("Unauthorized");
    }
    await this.authService.signOut(principal.sessionId);
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  }

  // ---------------------------------------------------------------------
  // POST /refresh — guarded; refreshes sliding window.
  // ---------------------------------------------------------------------

  @Post("refresh")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard)
  async refresh(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const principal = req.principal;
    if (!principal || principal.kind !== "session") {
      throw new UnauthorizedException("Unauthorized");
    }
    const result = await this.authService.refresh(principal.sessionId);
    if (!result) {
      throw new UnauthorizedException("Unauthorized");
    }
    // Re-issue the same CSPRNG cookie. Refresh extends last_seen_at only
    // and must not replace the cookie with the row id.
    const credential = readSessionCookie(req);
    if (credential === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    setSessionCookie(res, credential, result.absoluteExpiresAt);
  }

  // ---------------------------------------------------------------------
  // POST /password-reset/request — public; 202 always.
  // ---------------------------------------------------------------------

  @Public()
  @Post("password-reset/request")
  @HttpCode(HttpStatus.ACCEPTED)
  async requestPasswordReset(
    @Body(new ZodValidationPipe(PasswordResetRequestSchema))
    body: PasswordResetRequestInput,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const ip = readClientIp(req);
    await this.guardRateLimit("pwreset_ip", ip, RATE_LIMIT_BUCKETS.passwordResetPerIp);
    await this.authService.requestPasswordReset({ email: body.email });
    // Body is empty — contract says 202 with no schema.
  }

  // ---------------------------------------------------------------------
  // POST /password-reset/confirm — public; 204 / 400.
  // ---------------------------------------------------------------------

  @Public()
  @Post("password-reset/confirm")
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmPasswordReset(
    @Body(new ZodValidationPipe(PasswordResetConfirmSchema))
    body: PasswordResetConfirmInput,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const ip = readClientIp(req);
    await this.guardRateLimit("pwreset_confirm_ip", ip, RATE_LIMIT_BUCKETS.passwordResetConfirmPerIp);
    await this.authService.confirmPasswordReset({
      rawToken: body.token,
      newPassword: body.new_password,
    });
  }

  // ---------------------------------------------------------------------
  // POST /email/verify/request — guarded; 202.
  // ---------------------------------------------------------------------

  @Post("email/verify/request")
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(AuthGuard)
  async requestEmailVerification(@Req() req: AuthedRequest): Promise<void> {
    const principal = req.principal;
    if (!principal) {
      throw new UnauthorizedException("Unauthorized");
    }
    const userId =
      principal.kind === "session" ? principal.userId : principal.userId;
    if (!userId) {
      // Platform-admin token without a user id can't verify "their" email.
      throw new BadRequestException("No user associated with this credential");
    }
    await this.authService.requestEmailVerification({ userId });
  }

  // ---------------------------------------------------------------------
  // POST /email/verify/confirm — public; 204 / 400.
  // ---------------------------------------------------------------------

  @Public()
  @Post("email/verify/confirm")
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmEmailVerification(
    @Body(new ZodValidationPipe(EmailVerifyConfirmSchema))
    body: EmailVerifyConfirmInput,
  ): Promise<void> {
    await this.authService.confirmEmailVerification({ rawToken: body.token });
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async guardRateLimit(
    bucket: string,
    identifier: string,
    policy: { limit: number; windowMs: number },
  ): Promise<void> {
    const decision = await this.rateLimiter.check(bucket, identifier, policy);
    if (!decision.allowed) {
      // T470 — observability: a 429 on a sign-in bucket is a failed auth
      // attempt AND the existing rate-limit detector for rapid-retry
      // suspicious-login activity. We do not invent new detection here —
      // the rate-limit verdict IS the existing detector.
      //
      // Label sets (both bounded):
      //   auth_failure_total.cause:  "bad_password" | "bad_token" | "expired"
      //                              | "missing" | "rate_limited"
      //   suspicious_login_total.reason: "rapid_retry" | "geo_anomaly"
      //                                  | "unknown_device"
      //
      // The pwreset_ip bucket is intentionally NOT emitted as an auth
      // failure: password-reset request is not an authentication attempt.
      if (SIGNIN_RATE_LIMIT_BUCKETS.has(bucket)) {
        recordAuthFailure({ cause: "rate_limited" });
        recordSuspiciousLogin({ reason: "rapid_retry" });
      }
      throw RATE_LIMIT_429;
    }
  }
}

function readClientIp(req: AuthedRequest): string {
  // Express sets `req.ip` honoring `trust proxy`. Behind the dashboard
  // edge in production this should be configured; for now, fall back to
  // the raw socket address so tests / dev still get a value.
  const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
  return String(ip);
}

function setSessionCookie(
  res: Response,
  sessionId: string,
  expires: Date,
): void {
  const env = process.env["NODE_ENV"];
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: env !== "test" && env !== "development",
    sameSite: "lax",
    expires,
    path: "/",
  });
}
