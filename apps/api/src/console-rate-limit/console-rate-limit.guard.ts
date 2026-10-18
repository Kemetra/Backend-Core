/**
 * ConsoleRateLimitGuard — RT-619 (RT-574 issue 1; decision record
 * `docs/decisions/rt-574-console-rate-limiting.md` D1-D6, owner rulings
 * O1-O3b).
 *
 * A global APP_GUARD registered IMMEDIATELY AFTER `FailClosedAuthGuard` in
 * AppModule's providers (pinned by the order spec). Global guards run before
 * controller guards and before every interceptor, so `request.principal` is
 * already set and a 429 never claims an idempotency key.
 *
 * Modes (`CONSOLE_RATE_LIMIT_MODE`, read at boot):
 *   - `off` (default, O3b): return at once. No Redis call, no metric, no header.
 *   - `report`: check and count; never refuse.
 *   - `enforce`: refuse an over-budget request with the canonical 429.
 *
 * Subject (D2), an ALLOWLIST: a cookie session keys on its user; a
 * `dashboard_api` bearer keys on its user, or its token when it has none.
 * Every other caller (no principal, `pos`, `pos_operator`, `connector`, any
 * future scope) is not touched. Keys: `rl:console_<class>:u:<userId>` /
 * `…:t:<tokenId>`.
 *
 * Fail-open (D4, O3): a limiter error, a limiter call slower than the timeout
 * (250 ms default), an open circuit breaker, or any unexpected error inside
 * this guard ALLOWS the request and counts `fail_open`. Logs are throttled and
 * carry the class and route only, never a user, tenant or IP.
 *
 * L5 (ioredis offline-queue replay): this guard reuses the shared Redis
 * client, so a check that timed out stays queued in the client and replays
 * when Redis comes back, over-counting the bucket briefly. Harmless in
 * `report`; a dedicated `enableOfflineQueue: false` connection is an open
 * item before the enforce flip (RT-622).
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
import { ErrorCodes, type Logger } from "@data-pulse-2/shared";

import { RateLimiter, type RateLimitDecision } from "../auth/rate-limit";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import { REQUEST_ID_HEADER, resolveRequestId } from "../common/request-id.interceptor";
import { routeTemplate } from "../common/route-template";
import {
  recordConsoleRateLimit,
  recordConsoleRateLimitUtilisation,
  type ConsoleRateLimitOutcome,
} from "../observability/metrics/api.metrics";
import { ConsoleRateLimitBreaker } from "./circuit-breaker";
import { resolveConsoleRateLimitClass } from "./console-rate-limit.classify";
import {
  CONSOLE_RATE_LIMIT_BREAKER,
  CONSOLE_RATE_LIMIT_BUCKET_PREFIX,
  CONSOLE_RATE_LIMIT_BUDGETS,
  CONSOLE_RATE_LIMIT_CONFIG,
  CONSOLE_RATE_LIMIT_LOG_INTERVAL_MS,
  CONSOLE_RATE_LIMIT_NEAR_LIMIT_RATIO,
  CONSOLE_RETRY_AFTER_MAX_SECONDS,
  CONSOLE_RETRY_AFTER_MIN_SECONDS,
  type ConsoleCostClass,
  type ConsoleRateLimitClass,
  type ConsoleRateLimitConfig,
} from "./console-rate-limit.config";

/** DI token for an injectable clock (tests); defaults to `Date.now`. */
export const CONSOLE_RATE_LIMIT_CLOCK = "CONSOLE_RATE_LIMIT_CLOCK";

interface PrincipalLike {
  kind?: unknown;
  userId?: unknown;
  tokenId?: unknown;
  scope?: unknown;
}

interface GuardRequest {
  principal?: PrincipalLike | null;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: string };
  requestId?: string;
}

interface GuardResponse {
  setHeader(name: string, value: string): void;
}

/** A refusal decided in enforce mode; thrown outside the fail-open net. */
interface Refusal {
  readonly retryAfterSeconds: number;
}

class ConsoleLimiterTimeout extends Error {
  override readonly name = "ConsoleLimiterTimeout";
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** D2 subject, or null when the caller is not a console principal. */
export function consoleRateLimitSubject(principal: PrincipalLike | null | undefined): string | null {
  if (!principal) return null;
  if (principal.kind === "session") {
    return nonEmpty(principal.userId) ? `u:${principal.userId}` : null;
  }
  if (principal.kind === "token" && principal.scope === "dashboard_api") {
    if (nonEmpty(principal.userId)) return `u:${principal.userId}`;
    return nonEmpty(principal.tokenId) ? `t:${principal.tokenId}` : null;
  }
  return null;
}

function retryAfterSeconds(resetMs: number): number {
  const seconds = Math.ceil(Math.max(0, resetMs) / 1000);
  return Math.min(CONSOLE_RETRY_AFTER_MAX_SECONDS, Math.max(CONSOLE_RETRY_AFTER_MIN_SECONDS, seconds));
}

function errClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

@Injectable()
export class ConsoleRateLimitGuard implements CanActivate {
  private readonly breaker: ConsoleRateLimitBreaker;
  private readonly lastLogAt = new Map<string, number>();

  constructor(
    @Inject(CONSOLE_RATE_LIMIT_CONFIG) private readonly config: ConsoleRateLimitConfig,
    private readonly rateLimiter: RateLimiter,
    // ROOT_LOGGER is app-wide (RootLoggerModule); optional for standalone harnesses.
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Pick<Logger, "warn">,
    @Optional() @Inject(CONSOLE_RATE_LIMIT_CLOCK) private readonly now: () => number = Date.now,
  ) {
    this.breaker = new ConsoleRateLimitBreaker(CONSOLE_RATE_LIMIT_BREAKER, () => this.now());
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.config.mode === "off") return true;
    const refusal = await this.evaluateFailingOpen(context);
    return refusal === null || this.refuse(context, refusal);
  }

  /** {@link evaluate}, except that any unexpected error allows the request. */
  private async evaluateFailingOpen(context: ExecutionContext): Promise<Refusal | null> {
    try {
      return await this.evaluate(context);
    } catch (err) {
      // A bug here must never turn into a 500 on every console request.
      this.warnThrottled("internal", { err_class: errClass(err) }, "console rate limit: guard error; failing open (request allowed)");
      return null;
    }
  }

  private async evaluate(context: ExecutionContext): Promise<Refusal | null> {
    const request = context.switchToHttp().getRequest<GuardRequest>();
    const subject = consoleRateLimitSubject(request.principal);
    if (subject === null) return null;

    const costClass = resolveConsoleRateLimitClass(context.getClass(), context.getHandler());
    const route = routeTemplate(context, request);
    if (costClass === "exempt") {
      recordConsoleRateLimit({ class: costClass, outcome: "allowed", route });
      return null;
    }

    const decision = await this.checkWithinBounds(costClass, subject, route);
    if (decision === null) return null;

    const budget = CONSOLE_RATE_LIMIT_BUDGETS[costClass];
    recordConsoleRateLimitUtilisation({ class: costClass, route }, decision.count / budget.limit);
    const outcome = this.outcomeOf(decision, budget.limit);
    recordConsoleRateLimit({ class: costClass, outcome, route });
    if (outcome === "would_limit") {
      this.warnThrottled(
        `would_limit:${costClass}`,
        { class: costClass, route },
        "console rate limit: request over budget (report mode; allowed)",
      );
    }
    return outcome === "limited" ? { retryAfterSeconds: retryAfterSeconds(decision.resetMs) } : null;
  }

  /** The limiter decision, or null when it failed open (already counted). */
  private async checkWithinBounds(
    costClass: ConsoleCostClass,
    subject: string,
    route: string,
  ): Promise<RateLimitDecision | null> {
    if (!this.breaker.tryAcquire()) {
      this.failOpen(costClass, route, "BreakerOpen");
      return null;
    }
    try {
      const decision = await this.withTimeout(
        this.rateLimiter.check(
          `${CONSOLE_RATE_LIMIT_BUCKET_PREFIX}${costClass}`,
          subject,
          CONSOLE_RATE_LIMIT_BUDGETS[costClass],
        ),
      );
      this.breaker.onSuccess();
      return decision;
    } catch (err) {
      this.breaker.onFailure();
      this.failOpen(costClass, route, errClass(err));
      return null;
    }
  }

  private outcomeOf(decision: RateLimitDecision, limit: number): ConsoleRateLimitOutcome {
    if (!decision.allowed) return this.config.mode === "enforce" ? "limited" : "would_limit";
    return decision.count / limit >= CONSOLE_RATE_LIMIT_NEAR_LIMIT_RATIO ? "near_limit" : "allowed";
  }

  private failOpen(costClass: ConsoleRateLimitClass, route: string, errName: string): void {
    recordConsoleRateLimit({ class: costClass, outcome: "fail_open", route });
    this.warnThrottled(
      `fail_open:${costClass}`,
      { class: costClass, route, err_class: errName },
      "console rate limit: limiter unavailable; failing open (request allowed)",
    );
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ConsoleLimiterTimeout()), this.config.timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** D5: canonical 429; the guard assigns the request id itself (L6). */
  private refuse(context: ExecutionContext, refusal: Refusal): never {
    const http = context.switchToHttp();
    const request = http.getRequest<GuardRequest>();
    const response = http.getResponse<GuardResponse>();
    const requestId = request.requestId ?? resolveRequestId(request.headers[REQUEST_ID_HEADER]);
    request.requestId = requestId;
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("Retry-After", String(refusal.retryAfterSeconds));
    response.setHeader("Cache-Control", "no-store");
    throw new HttpException(
      { code: ErrorCodes.RATE_LIMITED, message: "Too many requests." },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private warnThrottled(key: string, fields: Record<string, string>, message: string): void {
    const now = this.now();
    const last = this.lastLogAt.get(key);
    if (last !== undefined && now - last < CONSOLE_RATE_LIMIT_LOG_INTERVAL_MS) return;
    this.lastLogAt.set(key, now);
    this.logger?.warn(fields, message);
  }
}
