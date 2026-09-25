/**
 * T100 — AuthGuard spec.
 *
 * Unit-level: SessionRepository / AuthTokenRepository are mocked. Real
 * Postgres lookups are exercised in their own repository specs (T102 /
 * T104) — this spec is about the guard's branching, the cookie-vs-bearer
 * precedence, and the FR-ISO-4 uniform 401 contract.
 *
 * Mock surface is intentionally narrow: only the two repository methods
 * the guard calls (`findActiveByCredential` and `findActiveByRawToken`). Anything
 * else on those classes can change without breaking these tests.
 */
import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { AuthTokenRow, SessionRow } from "@data-pulse-2/db/schema";
import {
  AuthGuard,
  BEARER_AUTH_SCOPES,
  SESSION_COOKIE_NAME,
  type AuthedRequest,
  type Principal,
} from "../../src/auth/auth.guard";
import { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import { SessionRepository } from "../../src/auth/session.repository";

interface MockSessionRepo {
  findActiveByCredential: jest.Mock<Promise<SessionRow | null>, [string]>;
}

interface MockTokenRepo {
  findActiveByRawToken: jest.Mock<Promise<AuthTokenRow | null>, [string]>;
}

function buildGuard(
  sessions: MockSessionRepo,
  tokens: MockTokenRepo,
): AuthGuard {
  return new AuthGuard(
    sessions as unknown as SessionRepository,
    tokens as unknown as AuthTokenRepository,
  );
}

function makeRequest(opts: {
  cookies?: Record<string, string | undefined>;
  authorization?: string;
}): AuthedRequest {
  return {
    cookies: opts.cookies,
    headers: opts.authorization
      ? { authorization: opts.authorization }
      : {},
  } as unknown as AuthedRequest;
}

function makeContext(request: AuthedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as unknown as T,
      getResponse: <T>() => ({}) as T,
      getNext: <T>() => ({}) as T,
    }),
  } as unknown as ExecutionContext;
}

const SESSION_ID = "0a000000-0000-7000-8000-0000000000s1";
const USER_ID = "0a000000-0000-7000-8000-0000000000u1";
const TOKEN_ID = "0a000000-0000-7000-8000-0000000000t1";
const TENANT_ID = "0a000000-0000-7000-8000-0000000000a1";
const RAW_TOKEN = "raw-token-value";

function activeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    activeTenantId: null,
    activeStoreId: null,
    issuedAt: new Date(),
    lastSeenAt: new Date(),
    absoluteExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: null,
    userAgent: null,
    ipAtIssue: null,
    ...overrides,
  };
}

function activeToken(overrides: Partial<AuthTokenRow> = {}): AuthTokenRow {
  return {
    id: TOKEN_ID,
    tokenHash: Buffer.alloc(32),
    tenantId: TENANT_ID,
    userId: USER_ID,
    deviceId: null,
    storeId: null,
    scope: "dashboard_api",
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: null,
    ...overrides,
  };
}

let sessionRepo: MockSessionRepo;
let tokenRepo: MockTokenRepo;
let guard: AuthGuard;

beforeEach(() => {
  sessionRepo = { findActiveByCredential: jest.fn() };
  tokenRepo = { findActiveByRawToken: jest.fn() };
  guard = buildGuard(sessionRepo, tokenRepo);
});

describe("AuthGuard — cookie path", () => {
  it("allows when cookie maps to an active session and attaches principal", async () => {
    const session = activeSession();
    sessionRepo.findActiveByCredential.mockResolvedValue(session);
    const request = makeRequest({
      cookies: { [SESSION_COOKIE_NAME]: SESSION_ID },
    });

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(sessionRepo.findActiveByCredential).toHaveBeenCalledTimes(1);
    expect(sessionRepo.findActiveByCredential).toHaveBeenCalledWith(SESSION_ID);
    expect(tokenRepo.findActiveByRawToken).not.toHaveBeenCalled();

    const principal = request.principal as Principal & { kind: "session" };
    expect(principal).toEqual({
      kind: "session",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
  });

  it("rejects with UnauthorizedException when the session is not active (revoked/expired/unknown)", async () => {
    sessionRepo.findActiveByCredential.mockResolvedValue(null);
    const request = makeRequest({
      cookies: { [SESSION_COOKIE_NAME]: SESSION_ID },
    });

    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tokenRepo.findActiveByRawToken).not.toHaveBeenCalled();
    expect(request.principal).toBeUndefined();
  });

  it("ignores empty/whitespace cookie value and treats it as no credential", async () => {
    const request = makeRequest({
      cookies: { [SESSION_COOKIE_NAME]: "   " },
    });

    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessionRepo.findActiveByCredential).not.toHaveBeenCalled();
  });
});

describe("AuthGuard — bearer path", () => {
  it("allows when header maps to an active token and attaches principal", async () => {
    const token = activeToken();
    tokenRepo.findActiveByRawToken.mockResolvedValue(token);
    const request = makeRequest({
      authorization: `Bearer ${RAW_TOKEN}`,
    });

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(tokenRepo.findActiveByRawToken).toHaveBeenCalledTimes(1);
    expect(tokenRepo.findActiveByRawToken).toHaveBeenCalledWith(RAW_TOKEN);
    expect(sessionRepo.findActiveByCredential).not.toHaveBeenCalled();

    expect(request.principal).toEqual({
      kind: "token",
      tokenId: TOKEN_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      storeId: null,
      scope: "dashboard_api",
    });
  });

  it("accepts case-insensitive scheme (`bearer ...`)", async () => {
    tokenRepo.findActiveByRawToken.mockResolvedValue(activeToken());
    const request = makeRequest({ authorization: `bearer ${RAW_TOKEN}` });

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(tokenRepo.findActiveByRawToken).toHaveBeenCalledWith(RAW_TOKEN);
  });

  it("carries platform-admin tokens (tenantId / userId nullable) through to the principal", async () => {
    tokenRepo.findActiveByRawToken.mockResolvedValue(
      activeToken({ tenantId: null, userId: null }),
    );
    const request = makeRequest({ authorization: `Bearer ${RAW_TOKEN}` });

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.principal).toEqual({
      kind: "token",
      tokenId: TOKEN_ID,
      tenantId: null,
      userId: null,
      storeId: null,
      scope: "dashboard_api",
    });
  });

  it("rejects a token with scope 'password_reset' (single-use workflow token cannot authenticate)", async () => {
    tokenRepo.findActiveByRawToken.mockResolvedValue(
      activeToken({ scope: "password_reset" }),
    );
    const request = makeRequest({ authorization: `Bearer ${RAW_TOKEN}` });

    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("rejects a token with scope 'email_verify' (single-use workflow token cannot authenticate)", async () => {
    tokenRepo.findActiveByRawToken.mockResolvedValue(
      activeToken({ scope: "email_verify" }),
    );
    const request = makeRequest({ authorization: `Bearer ${RAW_TOKEN}` });

    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each(["dashboard_api", "pos", "pos_operator"] as const)(
    "accepts token with bearer-safe scope '%s'",
    async (scope) => {
      tokenRepo.findActiveByRawToken.mockResolvedValue(activeToken({ scope }));
      const request = makeRequest({ authorization: `Bearer ${RAW_TOKEN}` });

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect((request.principal as Principal & { kind: "token" }).scope).toBe(scope);
    },
  );

  it("rejects when token lookup returns null (revoked/expired/unknown)", async () => {
    tokenRepo.findActiveByRawToken.mockResolvedValue(null);
    const request = makeRequest({ authorization: `Bearer ${RAW_TOKEN}` });

    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("rejects malformed Authorization header (`Basic ...`) without calling the repo", async () => {
    const request = makeRequest({ authorization: "Basic dXNlcjpwYXNz" });

    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tokenRepo.findActiveByRawToken).not.toHaveBeenCalled();
  });

  it("rejects empty bearer (`Bearer `) without calling the repo", async () => {
    const request = makeRequest({ authorization: "Bearer    " });

    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tokenRepo.findActiveByRawToken).not.toHaveBeenCalled();
  });
});

describe("AuthGuard — precedence and uniformity", () => {
  it("prefers cookie over bearer when both are present", async () => {
    sessionRepo.findActiveByCredential.mockResolvedValue(activeSession());
    tokenRepo.findActiveByRawToken.mockResolvedValue(activeToken());
    const request = makeRequest({
      cookies: { [SESSION_COOKIE_NAME]: SESSION_ID },
      authorization: `Bearer ${RAW_TOKEN}`,
    });

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(sessionRepo.findActiveByCredential).toHaveBeenCalledTimes(1);
    expect(tokenRepo.findActiveByRawToken).not.toHaveBeenCalled();
    expect((request.principal as Principal).kind).toBe("session");
  });

  it("if cookie path fails, does NOT fall through to bearer (cookie is authoritative)", async () => {
    sessionRepo.findActiveByCredential.mockResolvedValue(null);
    tokenRepo.findActiveByRawToken.mockResolvedValue(activeToken());
    const request = makeRequest({
      cookies: { [SESSION_COOKIE_NAME]: SESSION_ID },
      authorization: `Bearer ${RAW_TOKEN}`,
    });

    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tokenRepo.findActiveByRawToken).not.toHaveBeenCalled();
  });

  it("rejects when neither cookie nor bearer is present", async () => {
    const request = makeRequest({});

    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessionRepo.findActiveByCredential).not.toHaveBeenCalled();
    expect(tokenRepo.findActiveByRawToken).not.toHaveBeenCalled();
  });

  it("uses the same exception class for every failure mode (FR-ISO-4)", async () => {
    sessionRepo.findActiveByCredential.mockResolvedValue(null);
    // Default: token lookup returns null (expired/unknown). The wrong-scope
    // case below overrides this with a live token that has a disallowed scope.
    tokenRepo.findActiveByRawToken.mockResolvedValue(null);

    const cases: Array<{ req: AuthedRequest; tokenOverride?: ReturnType<typeof activeToken> }> = [
      { req: makeRequest({}) },
      { req: makeRequest({ cookies: { [SESSION_COOKIE_NAME]: SESSION_ID } }) },
      { req: makeRequest({ authorization: `Bearer ${RAW_TOKEN}` }) },
      { req: makeRequest({ authorization: "Basic xyz" }) },
      { req: makeRequest({ authorization: "Bearer " }) },
      // Wrong-scope token: token lookup finds a row, but the scope is single-use.
      {
        req: makeRequest({ authorization: `Bearer ${RAW_TOKEN}` }),
        tokenOverride: activeToken({ scope: "password_reset" }),
      },
    ];

    for (const { req, tokenOverride } of cases) {
      if (tokenOverride !== undefined) {
        tokenRepo.findActiveByRawToken.mockResolvedValueOnce(tokenOverride);
      }
      const err = await guard
        .canActivate(makeContext(req))
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).getStatus()).toBe(401);
    }
  });

  it("BEARER_AUTH_SCOPES contains exactly dashboard_api, pos, pos_operator, and connector", () => {
    // `connector` (015): the opaque machine scheme the ERPNext connector presents
    // on the 012 posting-feed surface. Added in lockstep with the scope set, like
    // every drift test in this repo — a new bearer scope cannot land silently.
    expect([...BEARER_AUTH_SCOPES].sort()).toEqual(
      ["dashboard_api", "pos", "pos_operator", "connector"].sort(),
    );
  });
});
