/**
 * T137 — FR-STORE-4: no cross-tenant store reassignment spec.
 *
 * Real Postgres via Testcontainers. Pins the enforcement of
 * FR-STORE-4: "A store cannot be reassigned to a different tenant."
 *
 * Enforcement layers (both tested here):
 *
 *   Layer 1 — Zod `.strict()` on `StoreUpdateSchema`:
 *     PATCH with `tenant_id` in the body is rejected at the validation
 *     boundary before any service or DB code runs (→ 400).
 *
 *   Layer 2 — Unknown-key rejection (same `.strict()` guard):
 *     PATCH with any key not in the schema (e.g., `code`) also → 400.
 *
 *   Layer 3 — Cross-tenant id remains 404 (RLS):
 *     Even if a caller holds a valid tenant context for tenant A and
 *     targets a store that belongs to tenant B, the RLS policy makes
 *     the store invisible → 404 (indistinguishable from not-found,
 *     per FR-ISO-4).
 *
 * Invariants pinned
 * -----------------
 *   - PATCH with `tenant_id` field → 400 (FR-STORE-4, layer 1)
 *   - PATCH with `code` field → 400 (no code mutation; `.strict()`)
 *   - PATCH with any other unknown key → 400 (`.strict()`)
 *   - PATCH body with only `tenant_id` and no valid field → 400
 *   - Cross-tenant store id with valid body → 404 (RLS, layer 3)
 *
 * Soft-skip: MIGRATION_TEST_ALLOW_SKIP=1 degrades gracefully without
 * Docker, same pattern as other integration specs.
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
// Two tenants, one user who is tenant_admin in both.
// One pre-seeded store per tenant.

const ADMIN_ID     = "b1000000-0000-4000-8000-000000000001";
const ADMIN_EMAIL  = "admin@no-reassign.test";
const ADMIN_PASS   = "No-Reassign-Test-1!";

const TENANT_A     = "b2000000-0000-4000-8000-000000000002";
const TENANT_B     = "b3000000-0000-4000-8000-000000000003";

const ROLE_A       = "b4000000-0000-4000-8000-000000000004";
const ROLE_B       = "b5000000-0000-4000-8000-000000000005";

const MEMBERSHIP_A = "b6000000-0000-4000-8000-000000000006";
const MEMBERSHIP_B = "b7000000-0000-4000-8000-000000000007";

// Store owned by tenant A — visible to the tenant_admin in tenant A context.
const STORE_A      = "b8000000-0000-4000-8000-000000000008";
// Store owned by tenant B — invisible to tenant A context (cross-tenant).
const STORE_B      = "b9000000-0000-4000-8000-000000000009";

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
       ($1, 'tenant-a-reassign', 'Tenant A'),
       ($2, 'tenant-b-reassign', 'Tenant B')`,
    [TENANT_A, TENANT_B],
  );

  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $2, 'tenant_admin', 'Tenant Admin A'),
       ($3, $4, 'tenant_admin', 'Tenant Admin B')`,
    [ROLE_A, TENANT_A, ROLE_B, TENANT_B],
  );

  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1, $2, $3, $4, 'all'),
            ($5, $6, $7, $8, 'all')`,
    [
      MEMBERSHIP_A, TENANT_A, ADMIN_ID, ROLE_A,
      MEMBERSHIP_B, TENANT_B, ADMIN_ID, ROLE_B,
    ],
  );

  await pg.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $2, 'STA-01', 'Store A1'),
       ($3, $4, 'STB-01', 'Store B1')`,
    [STORE_A, TENANT_A, STORE_B, TENANT_B],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });
    await seed();

    // The API must connect through the non-superuser `app_test` role so
    // RLS policies actually apply on its queries (Layer 3 of FR-STORE-4
    // depends on RLS hiding cross-tenant rows). The admin pool above is
    // reserved for setup + RLS-bypassing post-PATCH verification reads.
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, StoresModule],
    })
      .overrideProvider(PG_POOL).useValue(env.app)
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
      console.warn(`\n[no-reassign.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[no-reassign.spec] skipping (Docker unavailable)");
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

// ===== Layer 1: Zod .strict() rejects tenant_id on PATCH ================

describe("T137: FR-STORE-4 — PATCH with tenant_id in body → 400", () => {
  it("tenant_id alone in body → 400 (unknown key)", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(TENANT_A);

    await http()
      .patch(`/api/v1/stores/${STORE_A}`)
      .set("Cookie", cookie)
      .send({ tenant_id: TENANT_B })
      .expect(400);
  });

  it("tenant_id combined with a valid field → 400 (unknown key wins)", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(TENANT_A);

    // Even a well-formed `name` cannot rescue a body that also carries
    // `tenant_id` — Zod .strict() rejects the whole object.
    await http()
      .patch(`/api/v1/stores/${STORE_A}`)
      .set("Cookie", cookie)
      .send({ name: "New Name", tenant_id: TENANT_B })
      .expect(400);
  });
});

// ===== Zod .strict() rejects other unknown keys =========================

describe("T137: .strict() rejects other unknown keys on PATCH", () => {
  it("code field on PATCH → 400 (code is immutable after creation)", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(TENANT_A);

    // `code` is intentionally absent from StoreUpdateSchema — store codes
    // are stable identifiers and cannot be renamed via PATCH.
    await http()
      .patch(`/api/v1/stores/${STORE_A}`)
      .set("Cookie", cookie)
      .send({ code: "NEW-CODE" })
      .expect(400);
  });

  it("arbitrary unknown field → 400", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(TENANT_A);

    await http()
      .patch(`/api/v1/stores/${STORE_A}`)
      .set("Cookie", cookie)
      .send({ foo: "bar" })
      .expect(400);
  });

  it("empty body → 400 (at least one field required)", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(TENANT_A);

    await http()
      .patch(`/api/v1/stores/${STORE_A}`)
      .set("Cookie", cookie)
      .send({})
      .expect(400);
  });
});

// ===== Layer 3: cross-tenant store id is invisible (RLS → 404) ==========

describe("T137: cross-tenant PATCH → 404 (RLS makes store invisible)", () => {
  it("PATCH on a store owned by tenant B while active in tenant A → 404", async () => {
    if (maybeSkip()) return;
    // Authenticated in tenant A context; STORE_B belongs to tenant B.
    // RLS filters out the row, so the update touches 0 rows and the
    // service maps that to 404 — indistinguishable from not-found
    // (FR-ISO-4).
    const cookie = await signInWithTenant(TENANT_A);

    await http()
      .patch(`/api/v1/stores/${STORE_B}`)
      .set("Cookie", cookie)
      .send({ name: "Attempted hijack" })
      .expect(404);
  });

  it("store row in tenant B is unchanged after the failed cross-tenant attempt", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(TENANT_A);

    await http()
      .patch(`/api/v1/stores/${STORE_B}`)
      .set("Cookie", cookie)
      .send({ name: "Attempted hijack" })
      .expect(404);

    // Verify via admin pool (bypasses RLS) that STORE_B was not mutated.
    const row = await pool!.query(
      "SELECT name FROM stores WHERE id = $1",
      [STORE_B],
    );
    expect(row.rows[0]?.name).toBe("Store B1");
  });
});
