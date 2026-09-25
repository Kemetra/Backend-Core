/**
 * auth.guard.unit.spec.ts
 *
 * Docker-free unit coverage for AuthGuard.
 *
 * Strategy: hand-written fakes for SessionRepository and AuthTokenRepository.
 * The guard is constructed directly with no NestJS test module required.
 * No Testcontainers, no DB, no Redis, no network.
 *
 * The Testcontainers integration spec (auth.guard.spec.ts) covers the full
 * stack including real session and token rows. This spec pins the guard's
 * own responsibilities:
 *   - cookie-vs-bearer precedence (cookie wins when both present)
 *   - all null-return branches of readSessionCookie (undefined / empty / whitespace)
 *   - all null-return branches of readBearerToken (absent / too-short / wrong prefix / empty-after-trim)
 *   - principal attached on success (correct kind, correct field values)
 *   - UnauthorizedException thrown on every failure mode
 */

import "reflect-metadata";

import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { AuthTokenRow, SessionRow } from "@data-pulse-2/db/schema";

import {
  AuthGuard,
  SESSION_COOKIE_NAME,
} from "../../src/auth/auth.guard";
import type { Principal } from "../../src/auth/auth.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { AuthTokenRepository } from "../../src/auth/auth-token.repository";

// ---------------------------------------------------------------------------
// Fixed IDs (UUIDv7-ish)
// ---------------------------------------------------------------------------

const SESSION_ID = "0a000000-0000-7000-8000-0000000ses01";
const TOKEN_ID   = "0a000000-0000-7000-8000-0000000tok01";
const USER_ID    = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID  = "0a000000-0000-7000-8000-0000000ten01";

// ---------------------------------------------------------------------------
// Fake repositories
// ---------------------------------------------------------------------------

const makeFakeSessions = () => ({
  findActiveByCredential: jest.fn<Promise<SessionRow | null>, [string]>(),
});

const makeFakeAuthTokens = () => ({
  findActiveByRawToken: jest.fn<Promise<AuthTokenRow | null>, [string]>(),
});

// ---------------------------------------------------------------------------
// Guard builder
// ---------------------------------------------------------------------------

function buildGuard() {
  const sessions   = makeFakeSessions();
  const authTokens = makeFakeAuthTokens();
  const guard      = new AuthGuard(
    sessions   as unknown as SessionRepository,
    authTokens as unknown as AuthTokenRepository,
  );
  return { guard, sessions, authTokens };
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    activeTenantId: TENANT_ID,
    activeStoreId: null,
    revokedAt: null,
    ...overrides,
  } as unknown as SessionRow;
}

function makeToken(overrides: Partial<AuthTokenRow> = {}): AuthTokenRow {
  return {
    id: TOKEN_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    deviceId: null,
    storeId: null,
    scope: "dashboard_api",
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    ...overrides,
  } as unknown as AuthTokenRow;
}

// ---------------------------------------------------------------------------
// Execution context builder
// ---------------------------------------------------------------------------

function makeCtx(req: object): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
    }),
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

function makeRequest(opts: { cookie?: string; bearer?: string }): Record<string, unknown> {
  const req: Record<string, unknown> = {
    headers: {} as Record<string, string>,
    cookies: {} as Record<string, string>,
  };
  if (opts.cookie !== undefined) {
    (req.cookies as Record<string, string>)[SESSION_COOKIE_NAME] = opts.cookie;
  }
  if (opts.bearer !== undefined) {
    (req.headers as Record<string, string>)["authorization"] = opts.bearer;
  }
  return req;
}

// ===========================================================================
// Session-cookie path
// ===========================================================================

describe("AuthGuard — session-cookie path", () => {
  it("AG1: cookie present + session found → principal attached, returns true, kind='session'", async () => {
    const { guard, sessions, authTokens } = buildGuard();
    const session = makeSession();
    sessions.findActiveByCredential.mockResolvedValue(session);

    const req = makeRequest({ cookie: SESSION_ID });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    expect(req.principal).toEqual<Principal>({
      kind: "session",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    expect(sessions.findActiveByCredential).toHaveBeenCalledWith(SESSION_ID);
    expect(authTokens.findActiveByRawToken).not.toHaveBeenCalled();
  });

  it("AG2: cookie present + session NOT found → throws UnauthorizedException", async () => {
    const { guard, sessions } = buildGuard();
    sessions.findActiveByCredential.mockResolvedValue(null);

    const req = makeRequest({ cookie: SESSION_ID });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);

    expect(sessions.findActiveByCredential).toHaveBeenCalledWith(SESSION_ID);
  });

  it("AG3: cookie wins over bearer when both present — bearer path NOT entered", async () => {
    const { guard, sessions, authTokens } = buildGuard();
    const session = makeSession();
    sessions.findActiveByCredential.mockResolvedValue(session);

    const req = makeRequest({ cookie: SESSION_ID, bearer: "Bearer some-token" });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    expect((req.principal as Principal).kind).toBe("session");
    expect(sessions.findActiveByCredential).toHaveBeenCalledTimes(1);
    expect(authTokens.findActiveByRawToken).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Bearer-token path
// ===========================================================================

describe("AuthGuard — bearer-token path", () => {
  it("AG4: bearer token present + token found → principal attached, returns true, kind='token'", async () => {
    const { guard, sessions, authTokens } = buildGuard();
    const token = makeToken();
    authTokens.findActiveByRawToken.mockResolvedValue(token);

    const rawTokenValue = "my-raw-token-value";
    const req = makeRequest({ bearer: `Bearer ${rawTokenValue}` });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    expect(req.principal).toEqual<Principal>({
      kind: "token",
      tokenId: TOKEN_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      storeId: null,
      scope: "dashboard_api",
    });
    expect(sessions.findActiveByCredential).not.toHaveBeenCalled();
    expect(authTokens.findActiveByRawToken).toHaveBeenCalledWith(rawTokenValue);
  });

  it("AG5: bearer token present + token NOT found → throws UnauthorizedException", async () => {
    const { guard, authTokens } = buildGuard();
    authTokens.findActiveByRawToken.mockResolvedValue(null);

    const req = makeRequest({ bearer: "Bearer some-token" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);

    expect(authTokens.findActiveByRawToken).toHaveBeenCalledWith("some-token");
  });

  it("AG6: no cookie, no bearer → throws UnauthorizedException", async () => {
    const { guard } = buildGuard();

    const req = makeRequest({});
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ===========================================================================
// readSessionCookie branches
// ===========================================================================

describe("AuthGuard — readSessionCookie edge cases", () => {
  it("AG7: cookie key absent (value is undefined) → falls through to bearer path", async () => {
    const { guard, sessions, authTokens } = buildGuard();
    // No cookie key set — but provide a bearer so we can distinguish "fell through" from "both failed"
    const token = makeToken();
    authTokens.findActiveByRawToken.mockResolvedValue(token);

    const req = makeRequest({ bearer: "Bearer raw-tok" });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    expect(sessions.findActiveByCredential).not.toHaveBeenCalled();
    expect(authTokens.findActiveByRawToken).toHaveBeenCalledWith("raw-tok");
  });

  it("AG8: cookie value is empty string → falls through to bearer path", async () => {
    const { guard, sessions, authTokens } = buildGuard();
    const token = makeToken();
    authTokens.findActiveByRawToken.mockResolvedValue(token);

    const req = makeRequest({ cookie: "", bearer: "Bearer raw-tok" });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    expect(sessions.findActiveByCredential).not.toHaveBeenCalled();
    expect(authTokens.findActiveByRawToken).toHaveBeenCalledWith("raw-tok");
  });

  it("AG9: cookie value is whitespace-only → falls through to bearer path", async () => {
    const { guard, sessions, authTokens } = buildGuard();
    const token = makeToken();
    authTokens.findActiveByRawToken.mockResolvedValue(token);

    const req = makeRequest({ cookie: "   ", bearer: "Bearer raw-tok" });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    expect(sessions.findActiveByCredential).not.toHaveBeenCalled();
    expect(authTokens.findActiveByRawToken).toHaveBeenCalledWith("raw-tok");
  });

  it("AG10: cookie value has surrounding whitespace → trimmed correctly, session path taken", async () => {
    const { guard, sessions } = buildGuard();
    const session = makeSession();
    sessions.findActiveByCredential.mockResolvedValue(session);

    const req = makeRequest({ cookie: `  ${SESSION_ID}  ` });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    // Guard must call findActiveByCredential with the trimmed value, not the padded one
    expect(sessions.findActiveByCredential).toHaveBeenCalledWith(SESSION_ID);
  });
});

// ===========================================================================
// readBearerToken branches
// ===========================================================================

describe("AuthGuard — readBearerToken edge cases", () => {
  it("AG11: Authorization header absent → no bearer path, throws UnauthorizedException", async () => {
    const { guard, authTokens } = buildGuard();

    const req = makeRequest({});
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);

    expect(authTokens.findActiveByRawToken).not.toHaveBeenCalled();
  });

  it("AG12: Authorization header too short (< 'bearer '.length) → no bearer path", async () => {
    const { guard, authTokens } = buildGuard();

    // "Bearer" (6 chars) is shorter than "bearer " (7 chars)
    const req = makeRequest({ bearer: "Bearer" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);

    expect(authTokens.findActiveByRawToken).not.toHaveBeenCalled();
  });

  it("AG13: Authorization header prefix is not 'bearer ' (e.g. 'Basic xxx') → no bearer path", async () => {
    const { guard, authTokens } = buildGuard();

    // "Basic xyz123" — length > 7, but slice(0,7).toLowerCase() === "basic x" ≠ "bearer "
    const req = makeRequest({ bearer: "Basic xyz123" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);

    expect(authTokens.findActiveByRawToken).not.toHaveBeenCalled();
  });

  it("AG14: Authorization header 'Bearer' with uppercase B → case-normalised, bearer path taken", async () => {
    const { guard, authTokens } = buildGuard();
    const token = makeToken();
    authTokens.findActiveByRawToken.mockResolvedValue(token);

    // Uppercase "Bearer" — the guard lowercases the prefix before comparing
    const req = makeRequest({ bearer: "Bearer abc123" });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    expect(authTokens.findActiveByRawToken).toHaveBeenCalledWith("abc123");
  });

  it("AG15: Bearer token raw value is empty after trim → no bearer path, throws UnauthorizedException", async () => {
    const { guard, authTokens } = buildGuard();

    // "bearer " followed only by whitespace — raw.trim() yields ""
    const req = makeRequest({ bearer: "bearer    " });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);

    expect(authTokens.findActiveByRawToken).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Principal shape assertions
// ===========================================================================

describe("AuthGuard — principal shape", () => {
  it("AG16: session principal has correct sessionId and userId from session row", async () => {
    const { guard, sessions } = buildGuard();
    const session = makeSession({ id: SESSION_ID, userId: USER_ID });
    sessions.findActiveByCredential.mockResolvedValue(session);

    const req = makeRequest({ cookie: SESSION_ID });
    await guard.canActivate(makeCtx(req));

    const principal = req.principal as Principal;
    expect(principal).toEqual<Principal>({
      kind: "session",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
  });

  it("AG17: token principal has correct tokenId, tenantId (non-null), userId from token row", async () => {
    const { guard, authTokens } = buildGuard();
    const token = makeToken({ id: TOKEN_ID, tenantId: TENANT_ID, userId: USER_ID });
    authTokens.findActiveByRawToken.mockResolvedValue(token);

    const req = makeRequest({ bearer: "Bearer raw-token-abc" });
    await guard.canActivate(makeCtx(req));

    const principal = req.principal as Principal;
    expect(principal).toEqual<Principal>({
      kind: "token",
      tokenId: TOKEN_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      storeId: null,
      scope: "dashboard_api",
    });
  });

  it("AG17b: token principal with null tenantId and null userId — fields preserved as null", async () => {
    const { guard, authTokens } = buildGuard();
    const token = makeToken({ tenantId: null, userId: null });
    authTokens.findActiveByRawToken.mockResolvedValue(token);

    const req = makeRequest({ bearer: "Bearer platform-admin-token" });
    await guard.canActivate(makeCtx(req));

    const principal = req.principal as Principal;
    expect(principal).toEqual<Principal>({
      kind: "token",
      tokenId: TOKEN_ID,
      tenantId: null,
      userId: null,
      storeId: null,
      scope: "dashboard_api",
    });
  });
});
