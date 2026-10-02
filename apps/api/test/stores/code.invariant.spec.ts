/**
 * T135 — Store-code uniqueness invariant spec.
 *
 * Real Postgres via Testcontainers. Exercises the partial unique index:
 *
 *     CREATE UNIQUE INDEX stores_tenant_code_uidx
 *       ON stores (tenant_id, lower(code))
 *       WHERE deleted_at IS NULL;
 *
 * Invariants pinned here that are NOT in stores.controller.spec.ts:
 *
 *   1. Duplicate code in same tenant → 409 (baseline)
 *   2. Case-insensitive duplicate in same tenant → 409
 *      (exercises the `lower(code)` column in the partial index)
 *   3. Same code in a different tenant → 201
 *      (uniqueness is per-tenant, not global)
 *   4. Code can be reused in same tenant after the first store is
 *      soft-deleted → 201 (exercises the `WHERE deleted_at IS NULL`
 *      clause — soft-deleted rows are excluded from the index)
 *
 * Soft-skip pattern: set MIGRATION_TEST_ALLOW_SKIP=1 when Docker is
 * unavailable so CI/local runs without Docker degrade gracefully.
 */
import "reflect-metadata";

import { hashPassword } from "@data-pulse-2/auth";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { Pool } from "pg";
import request from "supertest";

import { AuthModule, PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
import {
  EMAIL_JOB_ENQUEUER,
  NoOpEmailJobEnqueuer,
} from "../../src/auth/email-job.enqueuer";
import { ContextInterceptor } from "../../src/context/context.interceptor";
import { ContextModule } from "../../src/context/context.module";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import {
  LoggingInterceptor,
  ROOT_LOGGER,
} from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { createLogger } from "@data-pulse-2/shared";
import { StoresModule } from "../../src/stores/stores.module";
import type { RedisLike } from "../../src/auth/rate-limit";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// ---- Fake Redis (always-allow rate limiter) ----------------------------

class AlwaysAllowRedis implements RedisLike {
  async incr(): Promise<number> { return 1; }
  async pexpireNx(): Promise<number> { return 1; }
  async pttl(): Promise<number> { return -1; }
  async decr(): Promise<number> { return 0; }
  async del(): Promise<number> { return 0; }
}

// ---- Minimal fixture IDs -----------------------------------------------
// Two tenants; one user who is tenant_admin in both.

const ADMIN_ID    = "a1000000-0000-4000-8000-000000000001";
const ADMIN_EMAIL = "admin@invariant-code.test";
const ADMIN_PASS  = "Inv-Code-Test-1!";

const TENANT_A    = "a2000000-0000-4000-8000-000000000002";
const TENANT_B    = "a3000000-0000-4000-8000-000000000003";

const ROLE_ADMIN_A = "a4000000-0000-4000-8000-000000000004";
const ROLE_ADMIN_B = "a5000000-0000-4000-8000-000000000005";

const MEMBERSHIP_A = "a6000000-0000-4000-8000-000000000006";
const MEMBERSHIP_B = "a7000000-0000-4000-8000-000000000007";

// ---- Test bootstrap ----------------------------------------------------

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

async function seed(): Promise<void> {
  const pg = pool!;
  const hash = await hashPassword(ADMIN_PASS);

  await pg.query(
    `INSERT INTO users (id, email, password_hash, is_platform_admin)
     VALUES ($1, $2, $3, false)`,
    [ADMIN_ID, ADMIN_EMAIL, hash],
  );

  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'tenant-a-code', 'Tenant A'),
       ($2, 'tenant-b-code', 'Tenant B')`,
    [TENANT_A, TENANT_B],
  );

  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $2, 'tenant_admin', 'Tenant Admin A'),
       ($3, $4, 'tenant_admin', 'Tenant Admin B')`,
    [ROLE_ADMIN_A, TENANT_A, ROLE_ADMIN_B, TENANT_B],
  );

  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1, $2, $3, $4, 'all'),
            ($5, $6, $7, $8, 'all')`,
    [
      MEMBERSHIP_A, TENANT_A, ADMIN_ID, ROLE_ADMIN_A,
      MEMBERSHIP_B, TENANT_B, ADMIN_ID, ROLE_ADMIN_B,
    ],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });
    await seed();

    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, StoresModule],
    })
      .overrideProvider(PG_POOL).useValue(pool)
      .overrideProvider(REDIS_CLIENT).useValue(new AlwaysAllowRedis())
      .overrideProvider(EMAIL_JOB_ENQUEUER).useValue(new NoOpEmailJobEnqueuer())
      .compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    const logger = createLogger({ service: "api-test", level: "silent" });
    app.useGlobalInterceptors(
      new RequestIdInterceptor(),
      new LoggingInterceptor(logger),
      new ContextInterceptor(),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ZodValidationPipe());
    void ROOT_LOGGER;
    await app.init();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[code.invariant.spec] Docker NOT AVAILABLE: ${msg}\n`);
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

function http() {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[code.invariant.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

async function signInWithTenant(tenantId: string): Promise<string> {
  const res = await http()
    .post("/api/v1/auth/signin")
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASS })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = list.find((c: string) => c.startsWith("dp2_session="));
  if (!cookie) throw new Error("signIn: no session cookie returned");
  const sessionCookie = cookie.split(";")[0]!;

  await http()
    .post("/api/v1/context/tenant")
    .set("Cookie", sessionCookie)
    .send({ tenant_id: tenantId })
    .expect(200);

  return sessionCookie;
}

// ===== Invariant 1: duplicate code in same tenant → 409 =================

describe("T135-1: duplicate store code in same tenant → 409", () => {
  it("second POST with the same code returns 409", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(TENANT_A);

    await http()
      .post("/api/v1/stores")
      .set("Cookie", cookie)
      .send({ code: "DUP-01", name: "First" })
      .expect(201);

    await http()
      .post("/api/v1/stores")
      .set("Cookie", cookie)
      .send({ code: "DUP-01", name: "Duplicate" })
      .expect(409);
  });
});

// ===== Invariant 2: case-insensitive duplicate in same tenant → 409 =====

describe("T135-2: case-insensitive store code uniqueness", () => {
  it("lowercase version of an existing code returns 409", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(TENANT_A);

    await http()
      .post("/api/v1/stores")
      .set("Cookie", cookie)
      .send({ code: "CASE-01", name: "Upper" })
      .expect(201);

    // The partial index uses lower(code), so 'case-01' collides with 'CASE-01'.
    await http()
      .post("/api/v1/stores")
      .set("Cookie", cookie)
      .send({ code: "case-01", name: "Lower — should conflict" })
      .expect(409);
  });

  it("mixed-case variation also returns 409", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(TENANT_A);

    await http()
      .post("/api/v1/stores")
      .set("Cookie", cookie)
      .send({ code: "MiXeD-01", name: "Original" })
      .expect(201);

    await http()
      .post("/api/v1/stores")
      .set("Cookie", cookie)
      .send({ code: "mixed-01", name: "Collision" })
      .expect(409);
  });
});

// ===== Invariant 3: same code in a different tenant → 201 ===============

describe("T135-3: same store code in different tenant is allowed", () => {
  it("code used in tenant A can be created in tenant B", async () => {
    if (maybeSkip()) return;

    const cookieA = await signInWithTenant(TENANT_A);
    await http()
      .post("/api/v1/stores")
      .set("Cookie", cookieA)
      .send({ code: "SHARED-CODE", name: "Tenant A store" })
      .expect(201);

    // The partial unique index is scoped to (tenant_id, lower(code)), so
    // the same code in a different tenant must NOT conflict.
    const cookieB = await signInWithTenant(TENANT_B);
    const res = await http()
      .post("/api/v1/stores")
      .set("Cookie", cookieB)
      .send({ code: "SHARED-CODE", name: "Tenant B store" })
      .expect(201);

    expect(res.body.tenant_id).toBe(TENANT_B);
    expect(res.body.code).toBe("SHARED-CODE");
  });
});

// ===== Invariant 4: code reuse after soft-delete in same tenant → 201 ===

describe("T135-4: store code can be reused after soft-delete", () => {
  it("deleted store's code is no longer occupied (partial index WHERE deleted_at IS NULL)", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(TENANT_B);

    // Create and immediately soft-delete a store.
    const created = await http()
      .post("/api/v1/stores")
      .set("Cookie", cookie)
      .send({ code: "RECYCLE-01", name: "Soon deleted" })
      .expect(201);

    await http()
      .delete(`/api/v1/stores/${created.body.id}`)
      .set("Cookie", cookie)
      .expect(204);

    // The partial index excludes deleted rows, so the code is now free.
    const reused = await http()
      .post("/api/v1/stores")
      .set("Cookie", cookie)
      .send({ code: "RECYCLE-01", name: "Reused" })
      .expect(201);

    expect(reused.body.code).toBe("RECYCLE-01");
    expect(reused.body.tenant_id).toBe(TENANT_B);
    expect(reused.body.id).not.toBe(created.body.id);
  });
});
