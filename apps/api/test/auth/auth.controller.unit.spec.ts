/**
 * auth.controller.unit.spec.ts
 *
 * Docker-free unit coverage for AuthController.
 *
 * Strategy: minimal Nest app mounting only AuthController.
 * AuthGuard replaced with a scripted CanActivate double; AuthService and
 * RateLimiter replaced with hand-written fakes. No Testcontainers, no DB,
 * no Redis, no network.
 *
 * The Testcontainers integration spec (auth.controller.spec.ts) covers the
 * full stack including real sessions, real tokens, and email spy. This spec
 * pins the controller's own responsibilities:
 *   - rate-limit guard wiring (bucket names, short-circuit on per-account block)
 *   - Zod body validation (ZodValidationPipe; 400 validation_error envelope)
 *   - session cookie set/clear/refresh (httpOnly, sameSite=lax, no Secure in test)
 *   - guard chain wiring (AuthGuard on guarded endpoints)
 *   - principal kind check (session vs token on signOut / refresh / emailVerify)
 *   - service delegation (args forwarded correctly)
 *   - null userId guard in requestEmailVerification
 *
 * Endpoints:
 *   POST /api/v1/auth/signin                 → 200 { user, memberships: [] }
 *   POST /api/v1/auth/signout                → 204 No Content
 *   POST /api/v1/auth/refresh                → 204 No Content
 *   POST /api/v1/auth/password-reset/request → 202 No Content
 *   POST /api/v1/auth/password-reset/confirm → 204 No Content
 *   POST /api/v1/auth/email/verify/request   → 202 No Content
 *   POST /api/v1/auth/email/verify/confirm   → 204 No Content
 */
import "reflect-metadata";

import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AuthGuard } from "../../src/auth/auth.guard";
import type { AuthedRequest } from "../../src/auth/auth.guard";
import type { Principal } from "../../src/auth/auth.guard";
import { AuthService } from "../../src/auth/auth.service";
import { RateLimiter } from "../../src/auth/rate-limit";
import type { RateLimitDecision } from "../../src/auth/rate-limit";
import { AuthController } from "../../src/auth/auth.controller";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import type { SignInResult } from "../../src/auth/dto";
import type { RefreshResult } from "../../src/auth/auth.service";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const USER_ID    = "0c000000-0000-7000-8000-000000000001";
const SESSION_ID = "0c000000-0000-7000-8000-000000000002";
const SESSION_CREDENTIAL = "cspnrg-cookie-value-not-the-row-id";
const TOKEN_ID   = "0c000000-0000-7000-8000-000000000003";
const TENANT_ID  = "0c000000-0000-7000-8000-000000000004";

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Fake AuthService
// ---------------------------------------------------------------------------

interface SignOutCall { sessionId: string }
interface RefreshCall { sessionId: string }
interface RequestPasswordResetCall { email: string }
interface ConfirmPasswordResetCall { rawToken: string; newPassword: string }
interface RequestEmailVerificationCall { userId: string }
interface ConfirmEmailVerificationCall { rawToken: string }

class FakeAuthService {
  lastSignInArgs:                   { email: string; password: string } | null = null;
  lastSignOutArgs:                  SignOutCall | null = null;
  lastRefreshArgs:                  RefreshCall | null = null;
  lastRequestPasswordResetArgs:     RequestPasswordResetCall | null = null;
  lastConfirmPasswordResetArgs:     ConfirmPasswordResetCall | null = null;
  lastRequestEmailVerificationArgs: RequestEmailVerificationCall | null = null;
  lastConfirmEmailVerificationArgs: ConfirmEmailVerificationCall | null = null;

  signInResult: SignInResult = {
    sessionId: SESSION_ID,
    sessionCredential: SESSION_CREDENTIAL,
    userId: USER_ID,
    absoluteExpiresAt: FUTURE,
    user: { id: USER_ID, email: "user@example.com", display_name: null, is_platform_admin: false },
  };
  refreshResult: RefreshResult | null = {
    sessionId: SESSION_ID,
    userId: USER_ID,
    absoluteExpiresAt: FUTURE,
  };

  async signIn(input: { email: string; password: string }): Promise<SignInResult> {
    this.lastSignInArgs = input;
    return this.signInResult;
  }

  async signOut(sessionId: string): Promise<void> {
    this.lastSignOutArgs = { sessionId };
  }

  async refresh(sessionId: string): Promise<RefreshResult | null> {
    this.lastRefreshArgs = { sessionId };
    return this.refreshResult;
  }

  async requestPasswordReset(input: { email: string }): Promise<void> {
    this.lastRequestPasswordResetArgs = input;
  }

  async confirmPasswordReset(input: { rawToken: string; newPassword: string }): Promise<void> {
    this.lastConfirmPasswordResetArgs = input;
  }

  async requestEmailVerification(input: { userId: string }): Promise<void> {
    this.lastRequestEmailVerificationArgs = input;
  }

  async confirmEmailVerification(input: { rawToken: string }): Promise<void> {
    this.lastConfirmEmailVerificationArgs = input;
  }
}

// ---------------------------------------------------------------------------
// Fake RateLimiter
// ---------------------------------------------------------------------------

class FakeRateLimiter {
  /** Buckets forced to block. Every bucket not listed here allows. */
  private blockedBuckets = new Set<string>();
  /** Ordered record of bucket names that check() was actually called with. */
  calledBuckets: string[] = [];

  blockBucket(bucketName: string): void {
    this.blockedBuckets.add(bucketName);
  }

  allowAll(): void {
    this.blockedBuckets.clear();
  }

  async check(
    bucketName: string,
    _identifier: string,
    _policy: { limit: number; windowMs: number },
  ): Promise<RateLimitDecision> {
    this.calledBuckets.push(bucketName);
    const allowed = !this.blockedBuckets.has(bucketName);
    return { allowed, count: allowed ? 1 : 100, remaining: allowed ? 99 : 0, resetMs: 60_000 };
  }
}

// ---------------------------------------------------------------------------
// Scripted AuthGuard
// ---------------------------------------------------------------------------

class ScriptedAuthGuard implements CanActivate {
  mode: "ok" | "reject" = "ok";
  principal: Principal = { kind: "session", sessionId: SESSION_ID, userId: USER_ID };

  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "reject") throw new UnauthorizedException("Unauthorized");
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    req.principal = this.principal;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function expectErrorEnvelope(body: unknown, expectedCode: string): void {
  expect(body).toMatchObject({
    error: {
      code: expectedCode,
      message: expect.any(String),
      request_id: expect.any(String),
    },
  });
}

// ---------------------------------------------------------------------------
// Fixture — one app instance for all tests in this file
// ---------------------------------------------------------------------------

let app: INestApplication;
let svc: FakeAuthService;
let rl: FakeRateLimiter;
let guard: ScriptedAuthGuard;

beforeAll(async () => {
  svc   = new FakeAuthService();
  rl    = new FakeRateLimiter();
  guard = new ScriptedAuthGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: AuthService,   useValue: svc },
      { provide: RateLimiter,   useValue: rl  },
    ],
  })
    .overrideGuard(AuthGuard).useValue(guard)
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  guard.mode = "ok";
  guard.principal = { kind: "session", sessionId: SESSION_ID, userId: USER_ID };
  rl.allowAll();
  rl.calledBuckets = [];

  svc.lastSignInArgs                   = null;
  svc.lastSignOutArgs                  = null;
  svc.lastRefreshArgs                  = null;
  svc.lastRequestPasswordResetArgs     = null;
  svc.lastConfirmPasswordResetArgs     = null;
  svc.lastRequestEmailVerificationArgs = null;
  svc.lastConfirmEmailVerificationArgs = null;

  svc.signInResult = {
    sessionId: SESSION_ID,
    sessionCredential: SESSION_CREDENTIAL,
    userId: USER_ID,
    absoluteExpiresAt: FUTURE,
    user: { id: USER_ID, email: "user@example.com", display_name: null, is_platform_admin: false },
  };
  svc.refreshResult = {
    sessionId: SESSION_ID,
    userId: USER_ID,
    absoluteExpiresAt: FUTURE,
  };
});

function http() {
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// POST /api/v1/auth/signin
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/signin", () => {
  it("happy path: 200 with user body and memberships: []", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "secret123" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: {
        id: USER_ID,
        email: "user@example.com",
        display_name: null,
        is_platform_admin: false,
      },
      memberships: [],
    });
  });

  it("sets session cookie with correct attributes", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "secret123" });

    const setCookie: string | string[] | undefined = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string];
    const sessionCookie = cookies.find((c) => c.startsWith("dp2_session="));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).toMatch(/Path=\//i);
    // NODE_ENV=test → Secure flag must NOT be present
    expect(sessionCookie).not.toMatch(/;\s*Secure/i);
    // Cookie value is the CSPRNG credential, not the sessions row id.
    expect(sessionCookie).toContain(`dp2_session=${SESSION_CREDENTIAL}`);
    expect(sessionCookie).not.toContain(`dp2_session=${SESSION_ID}`);
  });

  it("forwards email and password to authService.signIn", async () => {
    await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "mypassword" });

    expect(svc.lastSignInArgs).not.toBeNull();
    expect(svc.lastSignInArgs!.email).toBe("user@example.com");
    expect(svc.lastSignInArgs!.password).toBe("mypassword");
  });

  it("checks per-account rate limit before per-IP", async () => {
    await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "p" });

    expect(rl.calledBuckets[0]).toBe("signin_account");
    expect(rl.calledBuckets[1]).toBe("signin_ip");
  });

  it("returns 429 when per-account bucket is exhausted — per-IP not checked", async () => {
    rl.blockBucket("signin_account");
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "p" });

    expect(res.status).toBe(429);
    expectErrorEnvelope(res.body, "rate_limited");
    // Per-IP must not have been called (short-circuit)
    expect(rl.calledBuckets).toEqual(["signin_account"]);
    expect(svc.lastSignInArgs).toBeNull();
  });

  it("returns 429 when per-IP bucket is exhausted — service not called", async () => {
    rl.blockBucket("signin_ip");
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "p" });

    expect(res.status).toBe(429);
    expectErrorEnvelope(res.body, "rate_limited");
    expect(svc.lastSignInArgs).toBeNull();
  });

  it("returns 401 when authService.signIn throws UnauthorizedException", async () => {
    svc.signIn = async () => { throw new UnauthorizedException("Unauthorized"); };

    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "wrong" });

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    svc.signIn = async (input) => { svc.lastSignInArgs = input; return svc.signInResult; };
  });

  it("returns 400 (validation_error) for missing email — rate limiter not called", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ password: "secret123" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(rl.calledBuckets).toHaveLength(0);
    expect(svc.lastSignInArgs).toBeNull();
  });

  it("returns 400 (validation_error) for invalid email format", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "not-an-email", password: "secret123" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastSignInArgs).toBeNull();
  });

  it("returns 400 (validation_error) for missing password", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastSignInArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/signout
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/signout", () => {
  it("happy path (session principal): 204 and cookie cleared", async () => {
    const res = await http().post("/api/v1/auth/signout");

    expect(res.status).toBe(204);
    const setCookie: string | string[] | undefined = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string];
    const cleared = cookies.find((c) => c.startsWith("dp2_session="));
    expect(cleared).toBeDefined();
    // Express clears cookie by setting Expires in the past or Max-Age=0
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });

  it("forwards sessionId to authService.signOut", async () => {
    await http().post("/api/v1/auth/signout");

    expect(svc.lastSignOutArgs).not.toBeNull();
    expect(svc.lastSignOutArgs!.sessionId).toBe(SESSION_ID);
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    guard.mode = "reject";
    const res = await http().post("/api/v1/auth/signout");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastSignOutArgs).toBeNull();
  });

  it("returns 401 when principal is kind='token' — service not called", async () => {
    guard.principal = { kind: "token", tokenId: TOKEN_ID, tenantId: TENANT_ID, userId: USER_ID, scope: "dashboard_api" as const };
    const res = await http().post("/api/v1/auth/signout");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastSignOutArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/refresh
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/refresh", () => {
  it("happy path: 204 and cookie re-issued", async () => {
    const res = await http()
      .post("/api/v1/auth/refresh")
      .set("Cookie", [`dp2_session=${SESSION_CREDENTIAL}`]);

    expect(res.status).toBe(204);
    const setCookie: string | string[] | undefined = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    const reissued = cookies.find((c) => c.startsWith("dp2_session="));
    expect(reissued).toBeDefined();
    expect(reissued).toContain(`dp2_session=${SESSION_CREDENTIAL}`);
  });

  it("forwards sessionId to authService.refresh", async () => {
    await http().post("/api/v1/auth/refresh");

    expect(svc.lastRefreshArgs).not.toBeNull();
    expect(svc.lastRefreshArgs!.sessionId).toBe(SESSION_ID);
  });

  it("returns 401 when authService.refresh returns null", async () => {
    svc.refreshResult = null;
    const res = await http().post("/api/v1/auth/refresh");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 401 when AuthGuard rejects", async () => {
    guard.mode = "reject";
    const res = await http().post("/api/v1/auth/refresh");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastRefreshArgs).toBeNull();
  });

  it("returns 401 when principal is kind='token'", async () => {
    guard.principal = { kind: "token", tokenId: TOKEN_ID, tenantId: TENANT_ID, userId: USER_ID, scope: "dashboard_api" as const };
    const res = await http().post("/api/v1/auth/refresh");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastRefreshArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/password-reset/request
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/password-reset/request", () => {
  it("happy path: 202 with empty body", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: "user@example.com" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
  });

  it("forwards email to authService.requestPasswordReset", async () => {
    await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: "user@example.com" });

    expect(svc.lastRequestPasswordResetArgs).not.toBeNull();
    expect(svc.lastRequestPasswordResetArgs!.email).toBe("user@example.com");
  });

  it("returns 429 when per-IP rate limit blocks — service not called", async () => {
    rl.blockBucket("pwreset_ip");
    const res = await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: "user@example.com" });

    expect(res.status).toBe(429);
    expectErrorEnvelope(res.body, "rate_limited");
    expect(svc.lastRequestPasswordResetArgs).toBeNull();
  });

  it("returns 400 (validation_error) for missing email", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/request")
      .send({});

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(rl.calledBuckets).toHaveLength(0);
  });

  it("returns 400 (validation_error) for invalid email format", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/password-reset/confirm
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/password-reset/confirm", () => {
  it("happy path: 204 with empty body", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "some-token", new_password: "newpassword12345" });

    expect(res.status).toBe(204);
  });

  it("forwards token and new_password to authService.confirmPasswordReset", async () => {
    await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "tok123", new_password: "newpassword12345" });

    expect(svc.lastConfirmPasswordResetArgs).not.toBeNull();
    expect(svc.lastConfirmPasswordResetArgs!.rawToken).toBe("tok123");
    expect(svc.lastConfirmPasswordResetArgs!.newPassword).toBe("newpassword12345");
  });

  it("returns 400 (validation_error) when service throws BadRequestException", async () => {
    svc.confirmPasswordReset = async () => {
      throw new BadRequestException("Invalid or expired token");
    };

    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "expired", new_password: "newpassword12345" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    svc.confirmPasswordReset = async (input) => { svc.lastConfirmPasswordResetArgs = input; };
  });

  it("returns 400 (validation_error) for too-short new_password (<12 chars)", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "tok", new_password: "short" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastConfirmPasswordResetArgs).toBeNull();
  });

  it("returns 400 (validation_error) for missing token field", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ new_password: "newpassword12345" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastConfirmPasswordResetArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/email/verify/request
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/email/verify/request", () => {
  it("happy path (session principal with userId): 202", async () => {
    const res = await http().post("/api/v1/auth/email/verify/request");

    expect(res.status).toBe(202);
    expect(svc.lastRequestEmailVerificationArgs).not.toBeNull();
    expect(svc.lastRequestEmailVerificationArgs!.userId).toBe(USER_ID);
  });

  it("happy path (token principal with non-null userId): 202", async () => {
    guard.principal = { kind: "token", tokenId: TOKEN_ID, tenantId: TENANT_ID, userId: USER_ID, scope: "dashboard_api" as const };
    const res = await http().post("/api/v1/auth/email/verify/request");

    expect(res.status).toBe(202);
    expect(svc.lastRequestEmailVerificationArgs).not.toBeNull();
    expect(svc.lastRequestEmailVerificationArgs!.userId).toBe(USER_ID);
  });

  it("returns 400 when token principal has null userId", async () => {
    guard.principal = { kind: "token", tokenId: TOKEN_ID, tenantId: TENANT_ID, userId: null, scope: "dashboard_api" as const };
    const res = await http().post("/api/v1/auth/email/verify/request");

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastRequestEmailVerificationArgs).toBeNull();
  });

  it("returns 401 when AuthGuard rejects", async () => {
    guard.mode = "reject";
    const res = await http().post("/api/v1/auth/email/verify/request");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastRequestEmailVerificationArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/email/verify/confirm
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/email/verify/confirm", () => {
  it("happy path: 204 with empty body", async () => {
    const res = await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({ token: "verify-token" });

    expect(res.status).toBe(204);
  });

  it("forwards token to authService.confirmEmailVerification", async () => {
    await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({ token: "verify-token" });

    expect(svc.lastConfirmEmailVerificationArgs).not.toBeNull();
    expect(svc.lastConfirmEmailVerificationArgs!.rawToken).toBe("verify-token");
  });

  it("returns 400 (validation_error) when service throws BadRequestException", async () => {
    svc.confirmEmailVerification = async () => {
      throw new BadRequestException("Invalid or expired token");
    };

    const res = await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({ token: "expired" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    svc.confirmEmailVerification = async (input) => { svc.lastConfirmEmailVerificationArgs = input; };
  });

  it("returns 400 (validation_error) for missing token field", async () => {
    const res = await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({});

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastConfirmEmailVerificationArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B5.0 — requestEmailVerification !principal defensive branch
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/email/verify/request — !principal defensive branch", () => {
  it("B5.0: guard succeeds but principal is undefined → 401 (defensive guard)", async () => {
    // ScriptedAuthGuard sets req.principal = this.principal. Setting
    // principal to undefined makes canActivate succeed while leaving
    // req.principal unset, exercising the !principal branch in the handler.
    guard.principal = undefined as unknown as Principal;

    const res = await http().post("/api/v1/auth/email/verify/request");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastRequestEmailVerificationArgs).toBeNull();
  });
});
