/**
 * AuthGuard — slice 3b.
 *
 * Authenticates a request via either:
 *   1. The dashboard cookie `dp2_session` (preferred when present), or
 *   2. The `Authorization: Bearer <raw-token>` header.
 *
 * Cookie wins when both are present: dashboard humans go through the
 * cookie path, and a stale `Authorization` header (e.g. copy-pasted from
 * a curl session) must not override the active dashboard session.
 *
 * Every failure mode — missing credential, malformed header, expired,
 * revoked, unknown — produces the SAME `UnauthorizedException`. The
 * global exception filter renders that as the canonical 401 envelope.
 * This uniformity is required by FR-ISO-4 (no email/session-existence
 * leak via differing error shapes).
 *
 * On success the guard attaches a `principal` object to the request so
 * downstream interceptors / controllers (slice 3c+) can read who the
 * caller is without re-doing the lookup.
 *
 * Wiring: this guard is intentionally NOT registered globally and NOT
 * attached to any controller in this slice. The auth controller (slice
 * 3c) will `@UseGuards(AuthGuard)` once it lands.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { AuthTokenRow, BearerAuthScope, SessionRow } from "@data-pulse-2/db/schema";
import { SessionRepository } from "./session.repository";
import { AuthTokenRepository } from "./auth-token.repository";
import { recordAuthFailure } from "../observability/metrics/api.metrics";

export const SESSION_COOKIE_NAME = "dp2_session";
const BEARER_PREFIX = "bearer ";

/**
 * Scopes that are valid for general bearer API authentication. Single-use
 * workflow tokens (`password_reset`, `email_verify`) are intentionally
 * excluded — they must never be accepted as API credentials.
 */
export const BEARER_AUTH_SCOPES = new Set<BearerAuthScope>([
  "dashboard_api",
  "pos",
  "pos_operator",
  "connector",
]);

/**
 * The authenticated caller, attached as `request.principal` on success.
 *
 * `kind: "session"` is a dashboard human authenticated via cookie.
 * `sessionId` is the sessions row key, not the cookie. The cookie is a
 * separate CSPRNG value looked up by SHA-256.
 *
 * `kind: "token"` is an API/POS caller authenticated via opaque bearer
 * token. `tenantId` is null for platform-admin tokens.
 */
export type Principal =
  | {
      kind: "session";
      sessionId: string;
      userId: string;
    }
  | {
      kind: "token";
      tokenId: string;
      tenantId: string | null;
      userId: string | null;
      /**
       * Store binding from `auth_tokens.store_id`. Per 002 FR-POS-AUTH-4 a
       * `pos_operator` token is "bound to the operator user, the device, and
       * the resolved (tenant_id, store_id)" — so the column is populated at
       * sign-in and propagated here. `dashboard_api` / `pos` scopes carry no
       * store binding and pass through as null. Downstream consumers (e.g.
       * TenantContextGuard.resolveToken) read this to populate
       * ResolvedContext.storeId without a second DB lookup.
       */
      storeId: string | null;
      /** Always a bearer-safe scope — single-use workflow scopes are rejected before principal creation. */
      scope: BearerAuthScope;
    };

/**
 * Express request shape with the per-request fields populated by upstream
 * interceptors (`request-id.interceptor.ts`) plus the new `principal`
 * field this guard attaches.
 */
export type AuthedRequest = Request & {
  cookies?: Record<string, string | undefined>;
  requestId?: string;
  principal?: Principal;
  /**
   * 018-US4 — the resolved connector instance identity, attached by
   * `ConnectorAuthGuard` on a successful connector request (FR-017). Absent on
   * non-connector requests.
   */
  connector?: { registrationId: string; tenantId: string; environment: string };
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    // `protected` (not private) so subclasses (ConnectorAuthGuard) can reuse the
    // injected AuthTokenRepository for connector-credential resolution (018-US4).
    protected readonly sessions: SessionRepository,
    protected readonly authTokens: AuthTokenRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();

    const sessionCredential = readSessionCookie(request);
    if (sessionCredential !== null) {
      const session = await this.sessions.findActiveByCredential(sessionCredential);
      if (!session) {
        // T470 — observability: emit auth_failure_total{cause="bad_token"}.
        // `findActiveById` returns null for every non-live row (missing,
        // revoked, past absolute-expiry) without distinguishing between
        // them — that's FR-ISO-4 by design. We therefore cannot emit the
        // `expired` cause cleanly from this site without changing repo
        // behaviour, so `bad_token` covers the whole "session cookie was
        // presented but is not valid" outcome.
        // Bounded enum (AuthFailureCause):
        //   "bad_password" | "bad_token" | "expired" | "missing" | "rate_limited"
        recordAuthFailure({ cause: "bad_token" });
        throw unauthorized();
      }
      request.principal = principalFromSession(session);
      return true;
    }

    const rawToken = readBearerToken(request);
    if (rawToken !== null) {
      const token = await this.authTokens.findActiveByRawToken(rawToken);
      // Reject missing tokens AND single-use workflow tokens — both must
      // produce the same UnauthorizedException shape (FR-ISO-4).
      if (!token || !BEARER_AUTH_SCOPES.has(token.scope as BearerAuthScope)) {
        // T470 — observability: emit auth_failure_total{cause="bad_token"}.
        // Same FR-ISO-4 rationale as the session branch above —
        // `findActiveByRawToken` returns null for missing/revoked/expired
        // uniformly, plus we explicitly reject single-use workflow scopes
        // (password_reset/email_verify) here. All such paths roll up to a
        // single `bad_token` outcome.
        recordAuthFailure({ cause: "bad_token" });
        throw unauthorized();
      }
      request.principal = principalFromToken(token);
      return true;
    }

    // T470 — observability: emit auth_failure_total{cause="missing"}.
    // No usable credential on the request: no session cookie AND no bearer
    // header (or both were syntactically invalid: empty/whitespace cookie,
    // header shorter than "bearer ", wrong prefix, empty-after-trim).
    recordAuthFailure({ cause: "missing" });
    throw unauthorized();
  }
}

export function readSessionCookie(request: AuthedRequest): string | null {
  const parsed = request.cookies?.[SESSION_COOKIE_NAME];
  if (typeof parsed === "string" && parsed.trim().length > 0) {
    return parsed.trim();
  }
  const header = request.headers?.cookie;
  if (typeof header !== "string") return null;
  return cookieValue(header, SESSION_COOKIE_NAME);
}

function cookieValue(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function readBearerToken(request: AuthedRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return null;
  if (header.length < BEARER_PREFIX.length) return null;
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return null;
  }
  const raw = header.slice(BEARER_PREFIX.length).trim();
  return raw.length > 0 ? raw : null;
}

function principalFromSession(session: SessionRow): Principal {
  return {
    kind: "session",
    sessionId: session.id,
    userId: session.userId,
  };
}

function principalFromToken(token: AuthTokenRow): Principal {
  return {
    kind: "token",
    tokenId: token.id,
    tenantId: token.tenantId,
    userId: token.userId,
    storeId: token.storeId,
    scope: token.scope as BearerAuthScope,
  };
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}
