/**
 * T110 — AuthController integration spec.
 *
 * Real Postgres via Testcontainers. The NestJS app is built from
 * `AuthModule` with three provider overrides:
 *
 *   - PG_POOL          → test pool against the container
 *   - REDIS_CLIENT     → in-memory `FakeRedis` (same shape as
 *                        rate-limit.spec.ts) so rate-limit decisions
 *                        are real and deterministic
 *   - EMAIL_JOB_ENQUEUER → Jest spy so we can assert
 *                          `enqueuePasswordReset` /
 *                          `enqueueEmailVerification` were (or weren't)
 *                          called
 *
 * Coverage:
 *   - signin happy / wrong password / unknown email / SSO-only / locked
 *     user — uniform 401 envelope (FR-ISO-4)
 *   - signin per-account rate limit (5 / 15 min) → 429
 *   - signin body validation (Zod)
 *   - signout authed → 204; unauthed → 401; revocation visible
 *     immediately (≤5 min)
 *   - refresh authed → 204; refresh after revoke → 401
 *   - password-reset/request: 202 either way (no leak), enqueuer fired
 *     only for known email, token row written
 *   - password-reset/confirm valid → 204, password updated, all sessions
 *     revoked; bad token → 400; wrong-scope token → 400
 *   - email/verify/request authed → 202, token + enqueuer
 *   - email/verify/confirm valid → 204, email_verified_at set,
 *     wrong-scope → 400
 *   - 401 envelope shape matches 404 envelope shape
 */
import "reflect-metadata";

// jest.mock("bullmq") -- required even though EmailQueueProducer now
// implements OnModuleDestroy (PR #241). Reason: this spec uses
// `overrideProvider(EMAIL_JOB_ENQUEUER).useValue(emailSpy)`. Nest's
// override REPLACES the binding but does NOT undo the original
// useFactory's side effects -- the factory at auth.module.ts:112
// already invoked `new Queue(EMAIL_QUEUE_NAME, { connection: { url:
// REDIS_URL } })` before the override took effect. The producer wrapped
// around that queue is then ORPHANED out of the container (replaced by
// emailSpy), so its OnModuleDestroy hook is never called by Nest. The
// real Queue's background ioredis client survives `app.close()` and
// Jest reports "worker process has failed to exit gracefully" -> CI
// exit-1 once cumulative leaks cross threshold. The architecturally
// correct fix is to defer Queue construction in the factory itself,
// but that's a larger refactor; mocking bullmq here keeps the spec
// fast and hermetic without touching production semantics. Same
// pattern as auth/email-queue.wiring.spec.ts.
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(function () {
    return { add: jest.fn(), close: jest.fn().mockResolvedValue(undefined) };
  }),
}));

import { hashPassword, hashToken } from "@data-pulse-2/auth";
import { newId } from "@data-pulse-2/shared";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { Pool } from "pg";
import request from "supertest";

import { AuthModule, PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
import {
  EMAIL_JOB_ENQUEUER,
  NoOpEmailJobEnqueuer,
  type EmailJobEnqueuer,
} from "../../src/auth/email-job.enqueuer";
import { ContextInterceptor } from "../../src/context/context.interceptor";
import { ContextModule } from "../../src/context/context.module";
import { StoresModule } from "../../src/stores/stores.module";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { LoggingInterceptor, ROOT_LOGGER } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { createLogger } from "@data-pulse-2/shared";
import type { RedisLike } from "../../src/auth/rate-limit";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// -----------------------------------------------------------------------
// Fakes — keep parity with rate-limit.spec.ts so behaviour is identical
// -----------------------------------------------------------------------

interface FakeEntry {
  value: number;
  expiresAt: number | null;
}

class FakeRedis implements RedisLike {
  private readonly store = new Map<string, FakeEntry>();
  reset(): void {
    this.store.clear();
  }
  private gc(key: string): FakeEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }
  async incr(key: string): Promise<number> {
    const live = this.gc(key);
    if (!live) {
      this.store.set(key, { value: 1, expiresAt: null });
      return 1;
    }
    live.value += 1;
    return live.value;
  }
  async pexpireNx(key: string, ttlMs: number): Promise<number> {
    const live = this.gc(key);
    if (!live) return 0;
    if (live.expiresAt !== null) return 0;
    live.expiresAt = Date.now() + ttlMs;
    return 1;
  }
  async pttl(key: string): Promise<number> {
    const live = this.gc(key);
    if (!live) return -2;
    if (live.expiresAt === null) return -1;
    return Math.max(0, live.expiresAt - Date.now());
  }
}

function makeEmailSpy(): jest.Mocked<EmailJobEnqueuer> {
  return {
    enqueuePasswordReset: jest.fn().mockResolvedValue(undefined),
    enqueueEmailVerification: jest.fn().mockResolvedValue(undefined),
  };
}

// -----------------------------------------------------------------------
// Test fixture
// -----------------------------------------------------------------------

const ALICE_ID = "0a000000-0000-7000-8000-00000000aa01";
const ALICE_EMAIL = "alice@example.com";
const ALICE_PASSWORD = "correct horse battery staple";

const SSO_ID = "0a000000-0000-7000-8000-00000000aa02";
const SSO_EMAIL = "sso-only@example.com";

const DELETED_ID = "0a000000-0000-7000-8000-00000000aa03";
const DELETED_EMAIL = "deleted@example.com";

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let fakeRedis: FakeRedis;
let emailSpy: jest.Mocked<EmailJobEnqueuer>;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });

    const aliceHash = await hashPassword(ALICE_PASSWORD);
    await pool.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [ALICE_ID, ALICE_EMAIL, aliceHash],
    );
    await pool.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, NULL)`,
      [SSO_ID, SSO_EMAIL],
    );
    const deletedHash = await hashPassword("any-password");
    await pool.query(
      `INSERT INTO users (id, email, password_hash, deleted_at)
       VALUES ($1, $2, $3, now())`,
      [DELETED_ID, DELETED_EMAIL, deletedHash],
    );

    fakeRedis = new FakeRedis();
    emailSpy = makeEmailSpy();

    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(REDIS_CLIENT)
      .useValue(fakeRedis)
      .overrideProvider(EMAIL_JOB_ENQUEUER)
      .useValue(emailSpy)
      .compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    const logger = createLogger({ service: "api-test", level: "silent" });
    app.useGlobalInterceptors(
      new RequestIdInterceptor(),
      new LoggingInterceptor(logger),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ZodValidationPipe());
    void ROOT_LOGGER;
    await app.init();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[auth.controller.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  if (dockerSkipped) return;
  fakeRedis.reset();
  emailSpy.enqueuePasswordReset.mockClear();
  emailSpy.enqueueEmailVerification.mockClear();
});

function http() {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[auth.controller.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

function extractSessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = list.find((c: string) => c.startsWith("dp2_session="));
  if (!cookie) {
    throw new Error(
      `No dp2_session cookie in Set-Cookie: ${JSON.stringify(list)}`,
    );
  }
  return cookie.split(";")[0]!;
}

function cookieValue(setCookie: string): string {
  const eq = setCookie.indexOf("=");
  return eq === -1 ? "" : setCookie.slice(eq + 1);
}

function expectErrorEnvelope(
  body: unknown,
  expectedCode: string,
): void {
  expect(body).toMatchObject({
    error: {
      code: expectedCode,
      message: expect.any(String),
      request_id: expect.any(String),
    },
  });
}

// -----------------------------------------------------------------------
// /signin
// -----------------------------------------------------------------------

describe("POST /api/v1/auth/signin", () => {
  it("returns 200 + Set-Cookie + body for valid credentials", async () => {
    if (maybeSkip()) return;

    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: ALICE_EMAIL, password: ALICE_PASSWORD });

    expect(res.status).toBe(200);
    const cookie = extractSessionCookie(res);
    expect(cookie).toMatch(/^dp2_session=/);

    expect(res.body).toEqual({
      user: {
        id: ALICE_ID,
        email: ALICE_EMAIL,
        display_name: null,
        is_platform_admin: false,
      },
      memberships: [],
    });

    // Cookie attributes — HttpOnly + SameSite=Lax — Secure only in prod.
    const setCookie = res.headers["set-cookie"];
    const headerList = Array.isArray(setCookie) ? setCookie : [setCookie];
    const headerStr = headerList[0] as string;
    expect(headerStr).toMatch(/HttpOnly/i);
    expect(headerStr).toMatch(/SameSite=Lax/i);
  });

  it.each([
    ["wrong password", { email: ALICE_EMAIL, password: "nope" }],
    ["unknown email", { email: "ghost@example.com", password: "x" }],
    ["SSO-only user", { email: SSO_EMAIL, password: "x" }],
    ["soft-deleted user", { email: DELETED_EMAIL, password: "any-password" }],
  ])(
    "returns 401 with the same envelope shape for: %s",
    async (_label, payload) => {
      if (maybeSkip()) return;
      const res = await http().post("/api/v1/auth/signin").send(payload);
      expect(res.status).toBe(401);
      expectErrorEnvelope(res.body, "unauthorized");
    },
  );

  it("returns 400 (validation_error) for malformed body", async () => {
    if (maybeSkip()) return;
    const res = await http().post("/api/v1/auth/signin").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  it("returns 429 after 5 failed sign-ins for the same account in the window", async () => {
    if (maybeSkip()) return;
    const target = "ratelimit-target@example.com";
    // five failures (account doesn't exist — still counts toward per-account bucket)
    for (let i = 0; i < 5; i++) {
      const r = await http()
        .post("/api/v1/auth/signin")
        .send({ email: target, password: "x" });
      expect(r.status).toBe(401);
    }
    const blocked = await http()
      .post("/api/v1/auth/signin")
      .send({ email: target, password: "x" });
    expect(blocked.status).toBe(429);
    expectErrorEnvelope(blocked.body, "rate_limited");
  });
});

// -----------------------------------------------------------------------
// /signout
// -----------------------------------------------------------------------

describe("POST /api/v1/auth/signout", () => {
  it("returns 204 and revokes the session for an authenticated caller", async () => {
    if (maybeSkip()) return;
    const signin = await http()
      .post("/api/v1/auth/signin")
      .send({ email: ALICE_EMAIL, password: ALICE_PASSWORD });
    const cookie = extractSessionCookie(signin);

    const out = await http().post("/api/v1/auth/signout").set("Cookie", cookie);
    expect(out.status).toBe(204);

    const rows = await pool!.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM sessions WHERE credential_hash = $1`,
      [hashToken(cookieValue(cookie))],
    );
    expect(rows.rows[0]?.revoked_at).not.toBeNull();

    // Re-using the same cookie now fails immediately (≤5 min revocation)
    const replay = await http().post("/api/v1/auth/signout").set("Cookie", cookie);
    expect(replay.status).toBe(401);
    expectErrorEnvelope(replay.body, "unauthorized");
  });

  it("returns 401 with no cookie", async () => {
    if (maybeSkip()) return;
    const res = await http().post("/api/v1/auth/signout");
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });
});

// -----------------------------------------------------------------------
// /refresh
// -----------------------------------------------------------------------

describe("POST /api/v1/auth/refresh", () => {
  it("returns 204 and re-issues the cookie for an active session", async () => {
    if (maybeSkip()) return;
    const signin = await http()
      .post("/api/v1/auth/signin")
      .send({ email: ALICE_EMAIL, password: ALICE_PASSWORD });
    const cookie = extractSessionCookie(signin);

    const before = await pool!.query<{ last_seen_at: Date }>(
      `SELECT last_seen_at FROM sessions WHERE credential_hash = $1`,
      [hashToken(cookieValue(cookie))],
    );

    // Sleep a tiny bit so last_seen_at can advance
    await new Promise((r) => setTimeout(r, 50));

    const refresh = await http()
      .post("/api/v1/auth/refresh")
      .set("Cookie", cookie);
    expect(refresh.status).toBe(204);
    expect(cookieValue(extractSessionCookie(refresh))).toBe(cookieValue(cookie));

    const after = await pool!.query<{ last_seen_at: Date }>(
      `SELECT last_seen_at FROM sessions WHERE credential_hash = $1`,
      [hashToken(cookieValue(cookie))],
    );
    expect(after.rows[0]!.last_seen_at.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]!.last_seen_at.getTime(),
    );
  });

  it("returns 401 with no cookie", async () => {
    if (maybeSkip()) return;
    const res = await http().post("/api/v1/auth/refresh");
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 401 after the session is revoked", async () => {
    if (maybeSkip()) return;
    const signin = await http()
      .post("/api/v1/auth/signin")
      .send({ email: ALICE_EMAIL, password: ALICE_PASSWORD });
    const cookie = extractSessionCookie(signin);
    await http().post("/api/v1/auth/signout").set("Cookie", cookie);

    const refresh = await http()
      .post("/api/v1/auth/refresh")
      .set("Cookie", cookie);
    expect(refresh.status).toBe(401);
  });
});

// -----------------------------------------------------------------------
// /password-reset/request
// -----------------------------------------------------------------------

describe("POST /api/v1/auth/password-reset/request", () => {
  it("returns 202 and enqueues an email job for a known email", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: ALICE_EMAIL });
    expect(res.status).toBe(202);

    expect(emailSpy.enqueuePasswordReset).toHaveBeenCalledTimes(1);
    expect(emailSpy.enqueuePasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({
        email: ALICE_EMAIL,
        userId: ALICE_ID,
        rawToken: expect.any(String),
      }),
    );

    const tokens = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM auth_tokens
        WHERE user_id = $1 AND scope = 'password_reset' AND revoked_at IS NULL`,
      [ALICE_ID],
    );
    expect(tokens.rows[0]!.count).toBe("1");
  });

  it("returns 202 for an unknown email and does NOT enqueue", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: "ghost@example.com" });
    expect(res.status).toBe(202);
    expect(emailSpy.enqueuePasswordReset).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// /password-reset/confirm
// -----------------------------------------------------------------------

describe("POST /api/v1/auth/password-reset/confirm", () => {
  it("returns 204, updates the password, revokes all sessions", async () => {
    if (maybeSkip()) return;

    // Seed a fresh user dedicated to this test so we don't disturb alice.
    const userId = newId();
    const oldPassword = "old-password-12345";
    const newPassword = "brand-new-password-99";
    const oldHash = await hashPassword(oldPassword);
    await pool!.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [userId, `pwreset-${userId}@example.com`, oldHash],
    );

    // Open two active sessions to prove they all get revoked on confirm.
    const a = await http()
      .post("/api/v1/auth/signin")
      .send({ email: `pwreset-${userId}@example.com`, password: oldPassword });
    expect(a.status).toBe(200);
    const b = await http()
      .post("/api/v1/auth/signin")
      .send({ email: `pwreset-${userId}@example.com`, password: oldPassword });
    expect(b.status).toBe(200);

    // Ask for a reset; capture the rawToken via the spy.
    await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: `pwreset-${userId}@example.com` });
    const lastCall = emailSpy.enqueuePasswordReset.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const rawToken = lastCall![0].rawToken;

    const confirm = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: rawToken, new_password: newPassword });
    expect(confirm.status).toBe(204);

    // Old password no longer works
    const oldFail = await http()
      .post("/api/v1/auth/signin")
      .send({ email: `pwreset-${userId}@example.com`, password: oldPassword });
    expect(oldFail.status).toBe(401);

    // New password works
    const newOk = await http()
      .post("/api/v1/auth/signin")
      .send({ email: `pwreset-${userId}@example.com`, password: newPassword });
    expect(newOk.status).toBe(200);

    // All previous sessions are revoked
    const r = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    // Only the new sign-in's session is active.
    expect(r.rows[0]!.count).toBe("1");
  });

  it("returns 400 for an unknown / malformed token", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "definitely-not-a-real-token", new_password: "twelve-chars-plus" });
    expect(res.status).toBe(400);
  });

  it("returns 400 (validation_error) for a too-short new_password", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "any", new_password: "short" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  it("rejects a token whose scope is email_verify (cross-scope replay)", async () => {
    if (maybeSkip()) return;
    // Sign in as alice and ask for an email-verify token, then try to use
    // it on the password-reset/confirm endpoint.
    const signin = await http()
      .post("/api/v1/auth/signin")
      .send({ email: ALICE_EMAIL, password: ALICE_PASSWORD });
    const cookie = extractSessionCookie(signin);
    await http()
      .post("/api/v1/auth/email/verify/request")
      .set("Cookie", cookie);
    const lastCall = emailSpy.enqueueEmailVerification.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const verifyToken = lastCall![0].rawToken;

    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: verifyToken, new_password: "twelve-chars-plus-x" });
    expect(res.status).toBe(400);
  });
});

// -----------------------------------------------------------------------
// /email/verify/request + /email/verify/confirm
// -----------------------------------------------------------------------

describe("POST /api/v1/auth/email/verify/request", () => {
  it("returns 202, issues a token, enqueues the email", async () => {
    if (maybeSkip()) return;

    // Fresh user so the active-token count is unaffected by earlier tests.
    const userId = newId();
    const password = "verify-req-password-1";
    const email = `verify-req-${userId}@example.com`;
    await pool!.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [userId, email, await hashPassword(password)],
    );

    const signin = await http()
      .post("/api/v1/auth/signin")
      .send({ email, password });
    const cookie = extractSessionCookie(signin);

    const res = await http()
      .post("/api/v1/auth/email/verify/request")
      .set("Cookie", cookie);
    expect(res.status).toBe(202);
    expect(emailSpy.enqueueEmailVerification).toHaveBeenCalledTimes(1);

    const r = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM auth_tokens
        WHERE user_id = $1 AND scope = 'email_verify' AND revoked_at IS NULL`,
      [userId],
    );
    expect(r.rows[0]!.count).toBe("1");
  });

  it("returns 401 without a cookie", async () => {
    if (maybeSkip()) return;
    const res = await http().post("/api/v1/auth/email/verify/request");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/auth/email/verify/confirm", () => {
  it("returns 204, sets users.email_verified_at, revokes the token", async () => {
    if (maybeSkip()) return;

    const userId = newId();
    const password = "verify-password-1";
    await pool!.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [userId, `verify-${userId}@example.com`, await hashPassword(password)],
    );
    const signin = await http()
      .post("/api/v1/auth/signin")
      .send({ email: `verify-${userId}@example.com`, password });
    const cookie = extractSessionCookie(signin);

    await http()
      .post("/api/v1/auth/email/verify/request")
      .set("Cookie", cookie);
    const lastCall = emailSpy.enqueueEmailVerification.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const rawToken = lastCall![0].rawToken;

    const confirm = await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({ token: rawToken });
    expect(confirm.status).toBe(204);

    const u = await pool!.query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE id = $1`,
      [userId],
    );
    expect(u.rows[0]!.email_verified_at).not.toBeNull();

    // Token can't be reused
    const replay = await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({ token: rawToken });
    expect(replay.status).toBe(400);
  });

  it("returns 400 for an unknown token", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({ token: "ghost-token" });
    expect(res.status).toBe(400);
  });

  it("rejects a token whose scope is password_reset (cross-scope replay)", async () => {
    if (maybeSkip()) return;
    await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: ALICE_EMAIL });
    const lastCall = emailSpy.enqueuePasswordReset.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const resetToken = lastCall![0].rawToken;

    const res = await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({ token: resetToken });
    expect(res.status).toBe(400);
  });
});

// -----------------------------------------------------------------------
// Token-scope hardening: single-use tokens must not authenticate via Bearer
// -----------------------------------------------------------------------

describe("Bearer token scope hardening", () => {
  it("returns 401 when a password_reset token is replayed as a Bearer credential", async () => {
    if (maybeSkip()) return;

    // Request a password-reset token for alice; capture rawToken via the spy.
    await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: ALICE_EMAIL });
    const lastCall = emailSpy.enqueuePasswordReset.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const rawToken = lastCall![0].rawToken;

    // Attempt to use that rawToken as a Bearer credential against a
    // protected endpoint (email/verify/request requires AuthGuard).
    const res = await http()
      .post("/api/v1/auth/email/verify/request")
      .set("Authorization", `Bearer ${rawToken}`);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 401 when an email_verify token is replayed as a Bearer credential", async () => {
    if (maybeSkip()) return;

    // Sign in as alice, request an email-verify token.
    const signin = await http()
      .post("/api/v1/auth/signin")
      .send({ email: ALICE_EMAIL, password: ALICE_PASSWORD });
    const cookie = extractSessionCookie(signin);

    await http()
      .post("/api/v1/auth/email/verify/request")
      .set("Cookie", cookie);
    const lastCall = emailSpy.enqueueEmailVerification.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const rawToken = lastCall![0].rawToken;

    // Replay the email_verify token as Bearer — must be rejected.
    const res = await http()
      .post("/api/v1/auth/email/verify/request")
      .set("Authorization", `Bearer ${rawToken}`);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });
});

// -----------------------------------------------------------------------
// FR-ISO-4: 401 envelope shape ≡ 404 envelope shape
// -----------------------------------------------------------------------

describe("FR-ISO-4 — uniform error envelope shape", () => {
  it("401 (unauthenticated) and 404 (unknown route) share the envelope shape", async () => {
    if (maybeSkip()) return;
    const a = await http().post("/api/v1/auth/signout");
    const b = await http().post("/api/v1/auth/this-route-does-not-exist");

    expect(a.status).toBe(401);
    expect(b.status).toBe(404);

    // Both bodies match the same shape: { error: { code, message, request_id } }
    for (const res of [a, b]) {
      expect(res.body).toMatchObject({
        error: {
          code: expect.any(String),
          message: expect.any(String),
          request_id: expect.any(String),
        },
      });
    }
    expect(Object.keys(a.body.error).sort()).toEqual(
      Object.keys(b.body.error).sort(),
    );
  });
});

// -----------------------------------------------------------------------
// T313 / C-5 — multi-tenant sign-in: no active tenant auto-set,
// subsequent tenant-guarded call returns 401 (spec §5.1)
// -----------------------------------------------------------------------

describe("T313 / C-5 — multi-tenant sign-in: no active tenant set, subsequent tenant-guarded call → 401", () => {
  // UUIDv4 pattern matching this file's convention.
  const C5_USER_ID = "c5000001-0000-4000-8000-000000000001";
  const C5_USER_EMAIL = "c5-multi@example.com";
  const C5_USER_PASSWORD = "c5-multi-password-99";

  const C5_TENANT_ONE_ID = "c5000001-0000-4000-8000-000000000010";
  const C5_TENANT_TWO_ID = "c5000001-0000-4000-8000-000000000011";

  const C5_ROLE_ONE_ID = "c5000001-0000-4000-8000-000000000020";
  const C5_ROLE_TWO_ID = "c5000001-0000-4000-8000-000000000021";

  const C5_MEMBERSHIP_ONE_ID = "c5000001-0000-4000-8000-000000000030";
  const C5_MEMBERSHIP_TWO_ID = "c5000001-0000-4000-8000-000000000031";

  let c5Env: PgTestEnv | null = null;
  let c5Pool: Pool | null = null;
  let c5App: INestApplication | null = null;
  let c5Skipped = false;

  beforeAll(async () => {
    try {
      c5Env = await startPgEnv();
      await applyAllUpAndCreateAppRole(c5Env);
      c5Pool = new Pool({ connectionString: c5Env.adminUri });

      // Seed: user → tenants → roles → memberships (FK order).
      const userHash = await hashPassword(C5_USER_PASSWORD);
      await c5Pool.query(
        `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
        [C5_USER_ID, C5_USER_EMAIL, userHash],
      );
      await c5Pool.query(
        `INSERT INTO tenants (id, slug, name) VALUES
           ($1, 'c5-tenant-one', 'C5 Tenant One'),
           ($2, 'c5-tenant-two', 'C5 Tenant Two')`,
        [C5_TENANT_ONE_ID, C5_TENANT_TWO_ID],
      );
      await c5Pool.query(
        `INSERT INTO roles (id, tenant_id, code, name) VALUES
           ($1, $2, 'member', 'Member'),
           ($3, $4, 'member', 'Member')`,
        [C5_ROLE_ONE_ID, C5_TENANT_ONE_ID, C5_ROLE_TWO_ID, C5_TENANT_TWO_ID],
      );
      await c5Pool.query(
        `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
         VALUES ($1, $2, $3, $4, 'all')`,
        [C5_MEMBERSHIP_ONE_ID, C5_TENANT_ONE_ID, C5_USER_ID, C5_ROLE_ONE_ID],
      );
      await c5Pool.query(
        `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
         VALUES ($1, $2, $3, $4, 'all')`,
        [C5_MEMBERSHIP_TWO_ID, C5_TENANT_TWO_ID, C5_USER_ID, C5_ROLE_TWO_ID],
      );

      const moduleRef = await Test.createTestingModule({
        imports: [AuthModule, ContextModule, StoresModule],
      })
        .overrideProvider(PG_POOL)
        .useValue(c5Pool)
        .overrideProvider(REDIS_CLIENT)
        .useValue(new FakeRedis())
        .overrideProvider(EMAIL_JOB_ENQUEUER)
        .useValue(new NoOpEmailJobEnqueuer())
        .compile();

      c5App = moduleRef.createNestApplication({ bufferLogs: true });
      c5App.use(cookieParser());
      const logger = createLogger({ service: "api-test", level: "silent" });
      c5App.useGlobalInterceptors(
        new RequestIdInterceptor(),
        new LoggingInterceptor(logger),
        new ContextInterceptor(),
      );
      c5App.useGlobalFilters(new GlobalExceptionFilter());
      c5App.useGlobalPipes(new ZodValidationPipe());
      void ROOT_LOGGER;
      await c5App.init();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
        // eslint-disable-next-line no-console
        console.warn(`\n[auth.controller.spec T313] Docker NOT AVAILABLE: ${msg}\n`);
        c5Skipped = true;
        return;
      }
      throw new Error(`T313 container start failed: ${msg}`);
    }
  }, 180_000);

  afterAll(async () => {
    if (c5App) await c5App.close().catch(() => undefined);
    if (c5Pool) await c5Pool.end().catch(() => undefined);
    if (c5Env) await stopPgEnv(c5Env);
  }, 60_000);

  it("sign-in for a user with 2 memberships returns 200 but GET /api/v1/stores returns 401", async () => {
    if (c5Skipped) {
      // eslint-disable-next-line no-console
      console.warn("[auth.controller.spec T313] skipping (Docker unavailable)");
      return;
    }

    const c5Http = () => {
      if (!c5App) throw new Error("c5App not initialized");
      return request(c5App.getHttpServer());
    };

    // Step 1: sign in — expect 200 (credentials are valid).
    const signinRes = await c5Http()
      .post("/api/v1/auth/signin")
      .send({ email: C5_USER_EMAIL, password: C5_USER_PASSWORD });
    expect(signinRes.status).toBe(200);

    // Step 2: extract the session cookie.
    const cookie = extractSessionCookie(signinRes);

    // Step 3: GET /api/v1/stores without setting an active tenant first.
    // TenantContextGuard must reject with 401 because active_tenant_id is NULL.
    const storesRes = await c5Http()
      .get("/api/v1/stores")
      .set("Cookie", cookie);
    expect(storesRes.status).toBe(401);
    expect(storesRes.body).toMatchObject({
      error: {
        code: "unauthorized",
        message: expect.any(String),
        request_id: expect.any(String),
      },
    });
  });
});
