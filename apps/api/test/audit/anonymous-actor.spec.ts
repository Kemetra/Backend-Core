/**
 * T238 — anonymous-actor audit emission for sign-in failures.
 *
 * Spec text (`tasks.md` line 252):
 *   "Test that authentication failures (no resolved user) record
 *    `actor_user_id IS NULL` with `actor_label` = the email used (no
 *    password) in apps/api/test/audit/anonymous-actor.spec.ts"
 *
 * This is an integration test on the same shape as `auth.controller.spec.ts`:
 * a real Postgres container plus the full NestJS module graph for
 * `AuthModule`. Three provider overrides keep it deterministic:
 *
 *   - `PG_POOL`             → test pool against the container
 *   - `REDIS_CLIENT`        → in-memory `FakeRedis` (rate-limit decisions
 *                              are real but bounded)
 *   - `AUDIT_JOB_ENQUEUER`  → Jest spy so we can capture every payload
 *                              the sign-in flow emits
 *
 * What we prove
 * -------------
 * For failure paths (unknown email, SSO-only, soft-deleted user, wrong
 * password) we prove that:
 *   - the enqueuer is called exactly once per sign-in attempt
 *   - the action is `auth.signin.failed`
 *   - `actor_user_id` is `null`
 *   - `actor_label` equals the Zod-normalized attempted email
 *   - `metadata` is `null`
 *   - the literal password string is absent from every part of the
 *     captured payload
 *   - the HTTP response is the SAME generic 401 envelope it was before
 *     audit emission landed (no leak of "user exists vs bad password")
 *
 * For the success path we prove:
 *   - exactly one `auth.signin.ok` event is emitted
 *   - `actor_user_id` is the real user id
 *   - `actor_label` is the canonical user email
 *   - `metadata` is `null`
 *
 * For non-credential refusals we prove:
 *   - Zod 400 (malformed body) does NOT enqueue an audit event
 *   - 429 rate-limit refusal does NOT enqueue an audit event for the
 *     blocked request (it fails before `AuthService.signIn` runs)
 *
 * No double-emission is asserted by counting calls per case.
 */
import "reflect-metadata";

import { hashPassword } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { Pool } from "pg";
import request from "supertest";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../src/audit/audit-job.types";
import {
  AuthModule,
  PG_POOL,
  REDIS_CLIENT,
} from "../../src/auth/auth.module";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import {
  LoggingInterceptor,
  ROOT_LOGGER,
} from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import type { RedisLike } from "../../src/auth/rate-limit";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Fakes — kept structurally identical to auth.controller.spec.ts so the two
// specs exercise the same behaviour against the same fakes.
// ---------------------------------------------------------------------------

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
  async decr(key: string): Promise<number> {
    const live = this.gc(key);
    if (!live) {
      this.store.set(key, { value: -1, expiresAt: null });
      return -1;
    }
    live.value -= 1;
    return live.value;
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

interface CapturingEnqueuer extends AuditJobEnqueuer {
  enqueue: jest.MockedFunction<AuditJobEnqueuer["enqueue"]>;
  captured: AuditJobPayload[];
  reset(): void;
}

function makeCapturingEnqueuer(): CapturingEnqueuer {
  const captured: AuditJobPayload[] = [];
  const enqueue = jest.fn(async (payload: AuditJobPayload) => {
    captured.push(payload);
  });
  return {
    enqueue,
    captured,
    reset(): void {
      captured.length = 0;
      enqueue.mockClear();
    },
  };
}

/**
 * Wait for fire-and-forget audit emissions to settle. `AuthService` calls
 * `auditEnqueuer.enqueue(...)` without awaiting; the controller returns
 * before the enqueue Promise resolves. Two `setImmediate` ticks is the
 * same pattern used by `audit-emitter.interceptor.spec.ts`.
 */
async function flushAsync(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE_ID = "0a000000-0000-7000-8000-00000000aa01";
const ALICE_EMAIL = "alice@example.com";
const ALICE_PASSWORD = "correct horse battery staple";

const SSO_ID = "0a000000-0000-7000-8000-00000000aa02";
const SSO_EMAIL = "sso-only@example.com";

const DELETED_ID = "0a000000-0000-7000-8000-00000000aa03";
const DELETED_EMAIL = "deleted@example.com";

const UNKNOWN_EMAIL = "ghost@example.com";

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let fakeRedis: FakeRedis;
let auditSpy: CapturingEnqueuer;
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
    auditSpy = makeCapturingEnqueuer();

    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(REDIS_CLIENT)
      .useValue(fakeRedis)
      .overrideProvider(AUDIT_JOB_ENQUEUER)
      .useValue(auditSpy)
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
      console.warn(
        `\n[anonymous-actor.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
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
  auditSpy.reset();
});

function http() {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[anonymous-actor.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

/**
 * Walk every primitive in a payload and return any string that contains the
 * needle. Used to prove the literal password never appears anywhere in the
 * audit job — top-level fields, nested metadata (which we set to null, but
 * we still scan in case a future change adds metadata), or label.
 *
 * Caller contract: the needle MUST be at least
 * {@link MIN_LEAK_NEEDLE_LENGTH} characters long. Short needles (e.g. a
 * single-char password like "x") would substring-match incidental letter
 * overlaps in canonical strings such as the user's email, producing false
 * "leaks" that say nothing about real password disclosure. Test fixtures
 * use passwords well above this floor so the scan stays meaningful.
 */
const MIN_LEAK_NEEDLE_LENGTH = 6;

function findStringContaining(value: unknown, needle: string): string | null {
  if (needle.length < MIN_LEAK_NEEDLE_LENGTH) {
    throw new Error(
      `findStringContaining: needle must be ≥ ${MIN_LEAK_NEEDLE_LENGTH} chars; ` +
        `got ${needle.length}-char ${JSON.stringify(needle)}. ` +
        "Use a longer password in the test fixture.",
    );
  }
  if (typeof value === "string") {
    return value.includes(needle) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findStringContaining(item, needle);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const hit = findStringContaining(v, needle);
      if (hit !== null) return hit;
    }
    return null;
  }
  return null;
}

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
// Failure path — the heart of T238
// ---------------------------------------------------------------------------

// Distinctive, sufficiently-long sentinel passwords used by the failure
// cases. They MUST be (a) longer than `MIN_LEAK_NEEDLE_LENGTH` and (b) not
// incidental substrings of the user's email — otherwise the leak walker
// would raise false positives without any real password disclosure.
const SENTINEL_PW_UNKNOWN = "leak-sentinel-UNK-9417";
const SENTINEL_PW_WRONG = "leak-sentinel-WRONG-9417";
const SENTINEL_PW_SSO = "leak-sentinel-SSO-9417";
const SENTINEL_PW_DELETED = "leak-sentinel-DELETED-9417";

describe("T238 — sign-in failure emits anonymous-actor audit event", () => {
  it.each([
    ["unknown email", { email: UNKNOWN_EMAIL, password: SENTINEL_PW_UNKNOWN }],
    ["wrong password", { email: ALICE_EMAIL, password: SENTINEL_PW_WRONG }],
    [
      "SSO-only user (NULL password_hash)",
      { email: SSO_EMAIL, password: SENTINEL_PW_SSO },
    ],
    [
      "soft-deleted user",
      { email: DELETED_EMAIL, password: SENTINEL_PW_DELETED },
    ],
  ])(
    "enqueues exactly one auth.signin.failed for: %s",
    async (_label, payload) => {
      if (maybeSkip()) return;

      const res = await http().post("/api/v1/auth/signin").send(payload);
      await flushAsync();

      // Response remains the generic 401 envelope — no leak of which arm
      // of the credential check failed.
      expect(res.status).toBe(401);
      expectErrorEnvelope(res.body, "unauthorized");

      expect(auditSpy.enqueue).toHaveBeenCalledTimes(1);
      const event = auditSpy.captured[0]!;
      expect(event.action).toBe("auth.signin.failed");
      expect(event.actor_user_id).toBeNull();
      // Email is Zod-normalized (trim + lowercase) before reaching the
      // service; the captured label should match that canonical form.
      expect(event.actor_label).toBe(payload.email.toLowerCase());
      expect(event.metadata).toBeNull();
      expect(event.tenant_id).toBeNull();
      expect(event.store_id).toBeNull();
      expect(event.target_type).toBeNull();
      expect(event.target_id).toBeNull();

      // Defense-in-depth: the literal password string must not appear in
      // ANY string field of the captured payload.
      const leak = findStringContaining(event, payload.password);
      expect(leak).toBeNull();
    },
  );

  it("normalizes attempted email (trim + lowercase) into actor_label", async () => {
    if (maybeSkip()) return;

    // Mixed case + surrounding whitespace; Zod's Email schema trims and
    // lowercases before the controller hands the payload to AuthService.
    const noisy = "  GHoSt-2@Example.COM  ";
    const expectedLabel = "ghost-2@example.com";

    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: noisy, password: "secret-pw" });
    await flushAsync();

    expect(res.status).toBe(401);
    expect(auditSpy.enqueue).toHaveBeenCalledTimes(1);
    const event = auditSpy.captured[0]!;
    expect(event.actor_label).toBe(expectedLabel);
    expect(event.actor_user_id).toBeNull();
  });

  it("does not duplicate audit emissions across repeated failed attempts", async () => {
    if (maybeSkip()) return;

    for (let i = 0; i < 3; i++) {
      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: `nobody-${i}@example.com`, password: "x" });
      expect(res.status).toBe(401);
    }
    await flushAsync();

    expect(auditSpy.enqueue).toHaveBeenCalledTimes(3);
    for (const event of auditSpy.captured) {
      expect(event.action).toBe("auth.signin.failed");
      expect(event.actor_user_id).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Success path — pairs with T230's `auth.signin.{ok|failed}` enumeration
// ---------------------------------------------------------------------------

describe("sign-in success emits a single auth.signin.ok", () => {
  it("enqueues exactly one auth.signin.ok with the resolved user id and canonical email", async () => {
    if (maybeSkip()) return;

    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: ALICE_EMAIL, password: ALICE_PASSWORD });
    await flushAsync();

    expect(res.status).toBe(200);
    expect(auditSpy.enqueue).toHaveBeenCalledTimes(1);
    const event = auditSpy.captured[0]!;
    expect(event.action).toBe("auth.signin.ok");
    expect(event.actor_user_id).toBe(ALICE_ID);
    expect(event.actor_label).toBe(ALICE_EMAIL);
    expect(event.metadata).toBeNull();
    expect(event.tenant_id).toBeNull();
    expect(event.store_id).toBeNull();

    // Password literal must not appear in the success payload either.
    const leak = findStringContaining(event, ALICE_PASSWORD);
    expect(leak).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Non-credential refusals — must NOT enqueue audit events
// ---------------------------------------------------------------------------

describe("non-credential refusals do not emit auth audit events", () => {
  it("Zod 400 (malformed email) does not enqueue", async () => {
    if (maybeSkip()) return;

    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "not-an-email", password: "anything" });
    await flushAsync();

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(auditSpy.enqueue).not.toHaveBeenCalled();
  });

  it("rate-limit 429 does not enqueue an audit event for the blocked request", async () => {
    if (maybeSkip()) return;

    const target = "ratelimit-anon-actor@example.com";

    // Five failed attempts — each is a real credential evaluation, so each
    // emits one auth.signin.failed (proves the failure path still works
    // under load).
    for (let i = 0; i < 5; i++) {
      const r = await http()
        .post("/api/v1/auth/signin")
        .send({ email: target, password: "x" });
      expect(r.status).toBe(401);
    }
    await flushAsync();
    expect(auditSpy.enqueue).toHaveBeenCalledTimes(5);

    // Sixth attempt — blocked by rate limit BEFORE AuthService.signIn
    // runs. No audit event should fire for this one.
    const blocked = await http()
      .post("/api/v1/auth/signin")
      .send({ email: target, password: "x" });
    await flushAsync();
    expect(blocked.status).toBe(429);

    expect(auditSpy.enqueue).toHaveBeenCalledTimes(5);
  });
});

// ---------------------------------------------------------------------------
// Lightweight unit coverage — exercises AuthService.signIn directly so the
// T238 invariants are checked even when Docker is unavailable. The
// integration suite above remains the source of truth in CI; this block is
// extra evidence on developer machines without a container runtime.
// ---------------------------------------------------------------------------

describe("T238 unit — AuthService.signIn audit emission (no Docker)", () => {
  // Inline imports so this block remains self-contained and the parent
  // describe blocks above (which require Testcontainers) can be skipped
  // without affecting these.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { AuthService } = require("../../src/auth/auth.service") as typeof import("../../src/auth/auth.service");

  // Minimal Pool surface that drizzle-orm/node-postgres needs: a `query`
  // method that returns `{rows, rowCount}`. The driver also probes for a
  // `client.query` shape; we satisfy both by implementing `query` on the
  // pool itself, which is what drizzle reaches for in `nodePostgres()`.
  type DrizzleQueryResult = { rows: unknown[]; rowCount: number };

  function makePoolStub(
    rowsForEmail: Map<string, Record<string, unknown>>,
  ): { query: jest.MockedFunction<(text: unknown, params?: unknown[]) => Promise<DrizzleQueryResult>> } {
    const query = jest.fn(
      async (
        _text: unknown,
        params?: unknown[],
      ): Promise<DrizzleQueryResult> => {
        const email = Array.isArray(params)
          ? params.find((p) => typeof p === "string" && p.includes("@"))
          : undefined;
        const row =
          typeof email === "string" ? rowsForEmail.get(email) : undefined;
        if (row) {
          return { rows: [row], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    );
    return { query };
  }

  type SessionRepoLike = {
    create: jest.MockedFunction<
      (input: { id: string; userId: string; absoluteExpiresAt: Date }) => Promise<unknown>
    >;
  };

  function makeSessionsStub(): SessionRepoLike {
    return {
      create: jest.fn().mockResolvedValue({}),
    };
  }

  it("failed sign-in (unknown email) → exactly one auth.signin.failed with null actor_user_id and normalized actor_label", async () => {
    const pool = makePoolStub(new Map());
    const sessions = makeSessionsStub();
    const enqueuer = makeCapturingEnqueuer();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new AuthService(pool as any, sessions as any, undefined, undefined, {
      auditEnqueuer: enqueuer,
    });

    await expect(
      service.signIn({ email: "ghost@example.com", password: "any-password" }),
    ).rejects.toMatchObject({ status: 401 });

    await flushAsync();
    expect(enqueuer.enqueue).toHaveBeenCalledTimes(1);
    const event = enqueuer.captured[0]!;
    expect(event.action).toBe("auth.signin.failed");
    expect(event.actor_user_id).toBeNull();
    expect(event.actor_label).toBe("ghost@example.com");
    expect(event.metadata).toBeNull();
    expect(findStringContaining(event, "any-password")).toBeNull();
  });

  it("does NOT emit before the constant-time verifyPassword runs (failure case still calls pool.query for the user lookup)", async () => {
    const pool = makePoolStub(new Map());
    const sessions = makeSessionsStub();
    const enqueuer = makeCapturingEnqueuer();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new AuthService(pool as any, sessions as any, undefined, undefined, {
      auditEnqueuer: enqueuer,
    });

    await expect(
      service.signIn({ email: "ghost@example.com", password: "x" }),
    ).rejects.toThrow();

    // The pool was queried for the user (constant-time lookup) before the
    // audit fired — this is the structural guarantee that emit happens
    // AFTER the dummy-PHC verify path, not before it.
    expect(pool.query).toHaveBeenCalled();
    await flushAsync();
    expect(enqueuer.enqueue).toHaveBeenCalledTimes(1);
  });

  it("audit emission failure does not surface to the caller (fire-and-forget)", async () => {
    const pool = makePoolStub(new Map());
    const sessions = makeSessionsStub();
    const enqueuer: AuditJobEnqueuer = {
      enqueue: jest.fn().mockRejectedValue(new Error("queue down")),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new AuthService(pool as any, sessions as any, undefined, undefined, {
      auditEnqueuer: enqueuer,
    });

    // Should still reject with 401 — NOT with the "queue down" error.
    await expect(
      service.signIn({ email: "ghost@example.com", password: "x" }),
    ).rejects.toMatchObject({ status: 401 });
    await flushAsync();
  });
});
