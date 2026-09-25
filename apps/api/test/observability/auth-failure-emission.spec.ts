/**
 * T470 — auth_failure_total / suspicious_login_total emission-site test.
 *
 * Sibling of `auth-failure-signals.spec.ts` (which pins the bounded cause
 * set and label policy). This spec pins the actual EMISSION call sites —
 * the wire-up that the previous evidence run found missing:
 *
 *   - auth.service.ts        — bad_password on every credential-verify miss
 *   - auth.guard.ts          — bad_token on invalid session cookie
 *   - auth.guard.ts          — bad_token on invalid/missing/wrong-scope bearer
 *   - auth.guard.ts          — missing on no-credential-at-all
 *   - auth.controller.ts     — rate_limited + rapid_retry on signin 429
 *
 * Strategy:
 *   - Mock the emission helpers via `jest.mock` on the api.metrics module.
 *   - Construct each unit (AuthService, AuthGuard, AuthController) directly
 *     with hand-written fakes — same pattern as the existing *.unit.spec.ts
 *     files. No Testcontainers, no Nest app, no live SDK.
 *   - Assert each path emits with the bounded cause/reason value AND ONLY
 *     the documented label key (no PII, no IDs, no high-cardinality data).
 *   - Assert the existing throw semantics (UnauthorizedException,
 *     HttpException(429)) are unchanged — behaviour preserved.
 *
 * Constitution §VII / FR-B-001 / FR-B-006 / FR-ISO-4 / T470.
 */

import "reflect-metadata";

import { HttpException, HttpStatus, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { AuthTokenRow, SessionRow } from "@data-pulse-2/db/schema";

// ---------------------------------------------------------------------------
// Module mocks — applied BEFORE any imports that transitively load them
// ---------------------------------------------------------------------------

// Replace emission helpers with jest.fn() so each emission can be observed
// without registering an OTel MetricReader. Other exports (constants, types,
// other helpers) flow through unchanged.
jest.mock("../../src/observability/metrics/api.metrics", () => {
  const actual = jest.requireActual(
    "../../src/observability/metrics/api.metrics",
  );
  return {
    ...actual,
    recordAuthFailure: jest.fn(),
    recordSuspiciousLogin: jest.fn(),
  };
});

// Avoid pulling real drizzle / pg / argon2 into this spec. AuthService is
// constructed with fake repositories whose methods we control, so the DB
// path is never exercised — we still mock these to keep module load fast
// and side-effect-free.
jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve({ rowCount: 0 }) }) }),
  })),
}));

jest.mock("@data-pulse-2/auth", () => {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return {
    verifyPassword: jest.fn(),
    hashPassword: jest.fn(),
    generateRawToken: jest.fn(() => "raw-token-fixture"),
    hashToken: (token: string): Buffer => createHash("sha256").update(token).digest(),
  };
});

// Imports AFTER mocks
import {
  recordAuthFailure,
  recordSuspiciousLogin,
} from "../../src/observability/metrics/api.metrics";
import { AuthService } from "../../src/auth/auth.service";
import { AuthGuard, SESSION_COOKIE_NAME } from "../../src/auth/auth.guard";
import { AuthController } from "../../src/auth/auth.controller";
import {
  RateLimiter,
  type RateLimitDecision,
} from "../../src/auth/rate-limit";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import type { EmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";
import type { AuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import { verifyPassword } from "@data-pulse-2/auth";

const mockVerifyPassword = verifyPassword as jest.MockedFunction<typeof verifyPassword>;
const mockRecordAuthFailure = recordAuthFailure as jest.MockedFunction<typeof recordAuthFailure>;
const mockRecordSuspiciousLogin = recordSuspiciousLogin as jest.MockedFunction<typeof recordSuspiciousLogin>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID    = "0b000000-0000-7000-8000-0000000user1";
const SESSION_ID = "0b000000-0000-7000-8000-0000000sess1";
const TOKEN_ID   = "0b000000-0000-7000-8000-0000000tok01";
const TENANT_ID  = "0b000000-0000-7000-8000-0000000ten01";
const USER_EMAIL = "alice@example.com";

const VALID_AUTH_FAILURE_KEYS = ["cause"] as const;
const VALID_SUSPICIOUS_LOGIN_KEYS = ["reason"] as const;

function assertOnlyAllowedKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Object.keys(args);
  expect(keys).toEqual(allowed.slice(0, keys.length));
  for (const k of keys) {
    expect(allowed).toContain(k);
  }
}

function makeUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: USER_EMAIL,
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$fake$fakehash",
    displayName: "Alice",
    isPlatformAdmin: false,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    emailVerifiedAt: null,
    activeTenantId: null,
    ...overrides,
  };
}

function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    activeTenantId: null,
    activeStoreId: null,
    revokedAt: null,
    absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    issuedAt: new Date(),
    lastSeenAt: new Date(),
    userAgent: null,
    ipAtIssue: null,
    ...overrides,
  } as unknown as SessionRow;
}

function makeTokenRow(overrides: Partial<AuthTokenRow> = {}): AuthTokenRow {
  return {
    id: TOKEN_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    scope: "dashboard_api",
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    tokenHash: Buffer.from("fake"),
    deviceId: null,
    storeId: null,
    issuedAt: new Date(),
    ...overrides,
  } as unknown as AuthTokenRow;
}

// ---------------------------------------------------------------------------
// Service-layer fakes
// ---------------------------------------------------------------------------

class FakeSessionRepository {
  findActiveByCredential = jest.fn<Promise<SessionRow | null>, [string]>().mockResolvedValue(null);
  create = jest.fn().mockResolvedValue(makeSessionRow());
  revoke = jest.fn().mockResolvedValue(true);
  touchLastSeen = jest.fn().mockResolvedValue(true);
}

class FakeAuthTokenRepository {
  findActiveByRawToken = jest.fn<Promise<AuthTokenRow | null>, [string]>().mockResolvedValue(null);
  issue = jest.fn().mockResolvedValue(makeTokenRow());
  revoke = jest.fn().mockResolvedValue(true);
}

class FakeEmailJobs implements EmailJobEnqueuer {
  enqueuePasswordReset = jest.fn().mockResolvedValue(undefined);
  enqueueEmailVerification = jest.fn().mockResolvedValue(undefined);
  enqueueInvitation = jest.fn().mockResolvedValue(undefined);
}

class FakeAuditEnqueuer implements AuditJobEnqueuer {
  enqueue = jest.fn().mockResolvedValue(undefined);
}

function buildAuthService(): {
  service: AuthService;
  sessions: FakeSessionRepository;
  setUser: (row: ReturnType<typeof makeUserRow> | null) => void;
} {
  const sessions = new FakeSessionRepository();
  const authTokens = new FakeAuthTokenRepository();
  const emailJobs = new FakeEmailJobs();
  const auditEnqueuer = new FakeAuditEnqueuer();

  const service = new AuthService(
    {} as never,
    sessions as unknown as SessionRepository,
    authTokens as unknown as AuthTokenRepository,
    emailJobs,
    { auditEnqueuer },
  );

  // Monkey-patch the private user lookup so we don't have to mock drizzle
  // chain depth. Bracket-property assignment is the documented escape
  // hatch used in the existing auth.service.unit.spec.ts.
  let userRow: ReturnType<typeof makeUserRow> | null = null;
  (service as unknown as Record<string, unknown>)["findActiveUserByEmail"] =
    async (_email: string) => userRow;

  return {
    service,
    sessions,
    setUser: (row) => {
      userRow = row;
    },
  };
}

// ---------------------------------------------------------------------------
// Guard fixtures
// ---------------------------------------------------------------------------

function makeExecCtx(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
    }),
  } as unknown as ExecutionContext;
}

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

// ---------------------------------------------------------------------------
// Controller fixtures
// ---------------------------------------------------------------------------

class FakeRateLimiter {
  blocked = new Set<string>();
  async check(
    bucketName: string,
    _identifier: string,
    _policy: { limit: number; windowMs: number },
  ): Promise<RateLimitDecision> {
    const allowed = !this.blocked.has(bucketName);
    return {
      allowed,
      count: allowed ? 1 : 999,
      remaining: allowed ? 99 : 0,
      resetMs: 60_000,
    };
  }
}

type GuardRateLimit = (
  bucket: string,
  identifier: string,
  policy: { limit: number; windowMs: number },
) => Promise<void>;

function buildController(): { controller: AuthController; rateLimiter: FakeRateLimiter; callGuard: GuardRateLimit } {
  const rateLimiter = new FakeRateLimiter();
  const controller = new AuthController(
    // AuthService is never called in these tests — guardRateLimit short-
    // circuits on a blocked bucket before any service work.
    {} as never,
    rateLimiter as unknown as RateLimiter,
  );
  const callGuard = (
    (controller as unknown as Record<string, unknown>)["guardRateLimit"] as GuardRateLimit
  ).bind(controller);
  return { controller, rateLimiter, callGuard };
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockRecordAuthFailure.mockClear();
  mockRecordSuspiciousLogin.mockClear();
  mockVerifyPassword.mockReset();
});

// ===========================================================================
// 1. AuthService — bad_password emission (3 anti-enumeration branches)
// ===========================================================================

describe("T470 — AuthService.signIn emits auth_failure_total{cause:bad_password}", () => {
  it("unknown email (user row null) emits exactly once with cause=bad_password", async () => {
    const { service, sessions, setUser } = buildAuthService();
    setUser(null);
    mockVerifyPassword.mockResolvedValue(false);

    await expect(
      service.signIn({ email: "nobody@example.com", password: "anything" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith({ cause: "bad_password" });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("wrong password (user found, verify false) emits cause=bad_password", async () => {
    const { service, setUser } = buildAuthService();
    setUser(makeUserRow());
    mockVerifyPassword.mockResolvedValue(false);

    await expect(
      service.signIn({ email: USER_EMAIL, password: "wrong" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith({ cause: "bad_password" });
  });

  it("SSO-only user (null passwordHash) emits cause=bad_password (anti-enumeration)", async () => {
    const { service, setUser } = buildAuthService();
    setUser(makeUserRow({ passwordHash: null }));
    mockVerifyPassword.mockResolvedValue(false);

    await expect(
      service.signIn({ email: USER_EMAIL, password: "anything" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith({ cause: "bad_password" });
  });

  it("successful sign-in does NOT emit any auth failure", async () => {
    const { service, setUser } = buildAuthService();
    setUser(makeUserRow());
    mockVerifyPassword.mockResolvedValue(true);

    await service.signIn({ email: USER_EMAIL, password: "correct" });

    expect(mockRecordAuthFailure).not.toHaveBeenCalled();
    expect(mockRecordSuspiciousLogin).not.toHaveBeenCalled();
  });

  it("UnauthorizedException message is unchanged (behaviour preserved)", async () => {
    const { service, setUser } = buildAuthService();
    setUser(null);
    mockVerifyPassword.mockResolvedValue(false);

    const thrown = await service
      .signIn({ email: "x@x.com", password: "x" })
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(UnauthorizedException);
    const res = (thrown as UnauthorizedException).getResponse() as { message?: string };
    expect(res.message).toBe("Invalid credentials");
  });
});

// ===========================================================================
// 2. AuthGuard — bad_token / missing emissions
// ===========================================================================

describe("T470 — AuthGuard emits auth_failure_total on every failure mode", () => {
  function buildGuard() {
    const sessions = new FakeSessionRepository();
    const authTokens = new FakeAuthTokenRepository();
    const guard = new AuthGuard(
      sessions as unknown as SessionRepository,
      authTokens as unknown as AuthTokenRepository,
    );
    return { guard, sessions, authTokens };
  }

  it("session cookie present but findActiveByCredential returns null → bad_token", async () => {
    const { guard, sessions } = buildGuard();
    sessions.findActiveByCredential.mockResolvedValue(null);

    const req = makeRequest({ cookie: SESSION_ID });
    await expect(guard.canActivate(makeExecCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith({ cause: "bad_token" });
  });

  it("bearer token present but findActiveByRawToken returns null → bad_token", async () => {
    const { guard, authTokens } = buildGuard();
    authTokens.findActiveByRawToken.mockResolvedValue(null);

    const req = makeRequest({ bearer: "Bearer some-raw-token" });
    await expect(guard.canActivate(makeExecCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith({ cause: "bad_token" });
  });

  it("bearer token has single-use workflow scope (password_reset) → bad_token", async () => {
    const { guard, authTokens } = buildGuard();
    // The guard explicitly rejects workflow scopes even when the row IS
    // found — it must NOT accept them as bearer credentials.
    authTokens.findActiveByRawToken.mockResolvedValue(
      makeTokenRow({ scope: "password_reset" as never }),
    );

    const req = makeRequest({ bearer: "Bearer reset-token" });
    await expect(guard.canActivate(makeExecCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith({ cause: "bad_token" });
  });

  it("no cookie and no bearer header → missing", async () => {
    const { guard } = buildGuard();

    const req = makeRequest({});
    await expect(guard.canActivate(makeExecCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith({ cause: "missing" });
  });

  it("empty/whitespace cookie AND no bearer → missing (cookie reader returns null, falls through)", async () => {
    const { guard } = buildGuard();

    const req = makeRequest({ cookie: "   " });
    await expect(guard.canActivate(makeExecCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith({ cause: "missing" });
  });

  it("malformed bearer header (no space) AND no cookie → missing", async () => {
    const { guard } = buildGuard();

    // "Token foo" — wrong prefix, readBearerToken returns null
    const req = makeRequest({ bearer: "Token foo" });
    await expect(guard.canActivate(makeExecCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith({ cause: "missing" });
  });

  it("valid session cookie does NOT emit any failure", async () => {
    const { guard, sessions } = buildGuard();
    sessions.findActiveByCredential.mockResolvedValue(makeSessionRow());

    const req = makeRequest({ cookie: SESSION_ID });
    await expect(guard.canActivate(makeExecCtx(req))).resolves.toBe(true);

    expect(mockRecordAuthFailure).not.toHaveBeenCalled();
  });

  it("valid bearer token does NOT emit any failure", async () => {
    const { guard, authTokens } = buildGuard();
    authTokens.findActiveByRawToken.mockResolvedValue(makeTokenRow());

    const req = makeRequest({ bearer: "Bearer good-token" });
    await expect(guard.canActivate(makeExecCtx(req))).resolves.toBe(true);

    expect(mockRecordAuthFailure).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 3. AuthController.guardRateLimit — rate_limited + rapid_retry emission
// ===========================================================================

describe("T470 — AuthController.guardRateLimit emits on signin 429", () => {
  it("signin_account block emits auth_failure{rate_limited} AND suspicious_login{rapid_retry}", async () => {
    const { rateLimiter, callGuard } = buildController();
    rateLimiter.blocked.add("signin_account");

    await expect(
      callGuard("signin_account", USER_EMAIL, { limit: 5, windowMs: 60_000 }),
    ).rejects.toBeInstanceOf(HttpException);

    expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith({ cause: "rate_limited" });
    expect(mockRecordSuspiciousLogin).toHaveBeenCalledTimes(1);
    expect(mockRecordSuspiciousLogin).toHaveBeenCalledWith({ reason: "rapid_retry" });
  });

  it("signin_ip block emits both signals", async () => {
    const { rateLimiter, callGuard } = buildController();
    rateLimiter.blocked.add("signin_ip");

    await expect(
      callGuard("signin_ip", "127.0.0.1", { limit: 30, windowMs: 60_000 }),
    ).rejects.toBeInstanceOf(HttpException);

    expect(mockRecordAuthFailure).toHaveBeenCalledWith({ cause: "rate_limited" });
    expect(mockRecordSuspiciousLogin).toHaveBeenCalledWith({ reason: "rapid_retry" });
  });

  it("pwreset_ip block emits NEITHER signal (password reset is not an auth attempt)", async () => {
    const { rateLimiter, callGuard } = buildController();
    rateLimiter.blocked.add("pwreset_ip");

    await expect(
      callGuard("pwreset_ip", "127.0.0.1", { limit: 100, windowMs: 86_400_000 }),
    ).rejects.toBeInstanceOf(HttpException);

    expect(mockRecordAuthFailure).not.toHaveBeenCalled();
    expect(mockRecordSuspiciousLogin).not.toHaveBeenCalled();
  });

  it("allowed bucket emits NEITHER signal and does not throw", async () => {
    const { callGuard } = buildController();

    await expect(
      callGuard("signin_account", USER_EMAIL, { limit: 5, windowMs: 60_000 }),
    ).resolves.toBeUndefined();

    expect(mockRecordAuthFailure).not.toHaveBeenCalled();
    expect(mockRecordSuspiciousLogin).not.toHaveBeenCalled();
  });

  it("HTTP status of the thrown exception remains 429 (behaviour preserved)", async () => {
    const { rateLimiter, callGuard } = buildController();
    rateLimiter.blocked.add("signin_account");

    const thrown = await callGuard("signin_account", USER_EMAIL, {
      limit: 5,
      windowMs: 60_000,
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });
});

// ===========================================================================
// 4. Label discipline — no PII / IDs / high-cardinality values ever emitted
// ===========================================================================

describe("T470 — emitted labels are bounded and PII-free", () => {
  it("every recordAuthFailure call uses exactly the {cause} label key", async () => {
    // Fire every wired emission path once.
    const { service, setUser } = buildAuthService();
    setUser(null);
    mockVerifyPassword.mockResolvedValue(false);
    await service
      .signIn({ email: "a@b.c", password: "x" })
      .catch(() => undefined);

    const guardFixture = (() => {
      const sessions = new FakeSessionRepository();
      const authTokens = new FakeAuthTokenRepository();
      const guard = new AuthGuard(
        sessions as unknown as SessionRepository,
        authTokens as unknown as AuthTokenRepository,
      );
      return { guard, sessions, authTokens };
    })();
    await guardFixture.guard
      .canActivate(makeExecCtx(makeRequest({ cookie: SESSION_ID })))
      .catch(() => undefined);
    await guardFixture.guard
      .canActivate(makeExecCtx(makeRequest({ bearer: "Bearer x" })))
      .catch(() => undefined);
    await guardFixture.guard
      .canActivate(makeExecCtx(makeRequest({})))
      .catch(() => undefined);

    const { rateLimiter, callGuard } = buildController();
    rateLimiter.blocked.add("signin_account");
    await callGuard("signin_account", "a@b.c", { limit: 1, windowMs: 1 }).catch(
      () => undefined,
    );

    expect(mockRecordAuthFailure.mock.calls.length).toBeGreaterThan(0);
    for (const [arg] of mockRecordAuthFailure.mock.calls) {
      const args = arg as Record<string, unknown>;
      assertOnlyAllowedKeys(args, VALID_AUTH_FAILURE_KEYS);
      // No PII / ID / high-cardinality slipped in.
      expect(args).not.toHaveProperty("email");
      expect(args).not.toHaveProperty("user_id");
      expect(args).not.toHaveProperty("tenant_id");
      expect(args).not.toHaveProperty("store_id");
      expect(args).not.toHaveProperty("ip");
      expect(args).not.toHaveProperty("request_id");
      expect(args).not.toHaveProperty("path");
      expect(args).not.toHaveProperty("route");
      // cause is a bounded enum literal
      expect(typeof args["cause"]).toBe("string");
      expect([
        "bad_password",
        "bad_token",
        "expired",
        "missing",
        "rate_limited",
      ]).toContain(args["cause"]);
    }
  });

  it("every recordSuspiciousLogin call uses exactly the {reason} label key", async () => {
    const { rateLimiter, callGuard } = buildController();
    rateLimiter.blocked.add("signin_account");
    await callGuard("signin_account", "a@b.c", { limit: 1, windowMs: 1 }).catch(
      () => undefined,
    );
    rateLimiter.blocked.add("signin_ip");
    await callGuard("signin_ip", "1.1.1.1", { limit: 1, windowMs: 1 }).catch(
      () => undefined,
    );

    expect(mockRecordSuspiciousLogin.mock.calls.length).toBeGreaterThan(0);
    for (const [arg] of mockRecordSuspiciousLogin.mock.calls) {
      const args = arg as Record<string, unknown>;
      assertOnlyAllowedKeys(args, VALID_SUSPICIOUS_LOGIN_KEYS);
      expect(args).not.toHaveProperty("email");
      expect(args).not.toHaveProperty("user_id");
      expect(args).not.toHaveProperty("ip");
      expect(["rapid_retry", "geo_anomaly", "unknown_device"]).toContain(
        args["reason"],
      );
    }
  });
});
