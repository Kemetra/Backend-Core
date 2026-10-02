/**
 * T173/T174 — PATCH /api/v1/memberships/:membership_id spec.
 *
 * Real Postgres via Testcontainers. Covers the update endpoint:
 *
 *   PATCH /api/v1/memberships/:membership_id
 *
 * Scenarios:
 *   1.  all → specific: replaces with submitted store_ids
 *   2.  specific → specific: replaces old list, removes omitted stores
 *   3.  specific → all: deletes all store_access rows
 *   4.  store_ids with store from another tenant → 400
 *   5.  store_access_kind="specific" + store_ids omitted → 400 (Zod)
 *   6.  store_ids provided while existing kind is "all" (no explicit kind) → 400
 *   7.  store_ids=[] while existing kind is "specific" (no explicit kind) → 400
 *   8.  invalid role_code → 400
 *   9.  update role only: leaves store access unchanged
 *   10. update store access only: leaves role unchanged
 *   11. store_staff caller → 403
 *   12. cross-tenant membership_id → 404
 *   13. already-revoked membership → 404
 *   14. empty body → 400
 *   15. unauthenticated → 401
 *   16. no active tenant → 401
 *   17. non-UUID membership_id → 400
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
import { MembershipsModule } from "../../src/memberships/memberships.module";
import type { RedisLike } from "../../src/auth/rate-limit";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

class AlwaysAllowRedis implements RedisLike {
  async incr(): Promise<number> { return 1; }
  async pexpireNx(): Promise<number> { return 1; }
  async pttl(): Promise<number> { return -1; }
  async decr(): Promise<number> { return 0; }
  async del(): Promise<number> { return 0; }
}

// ---- Fixture IDs -----------------------------------------------------------
// All UUIDv4, prefix "e" to avoid collision with other specs.

const OWNER_ID       = "e1000000-1000-4000-8000-000000000001";
const OWNER_EMAIL    = "owner@memberships-patch.test";
const OWNER_PASS     = "Owner-Patch-1!";

const STAFF_ID       = "e2000000-2000-4000-8000-000000000002";
const STAFF_EMAIL    = "staff@memberships-patch.test";
const STAFF_PASS     = "Staff-Patch-1!";

const TARGET_ID      = "e3000000-3000-4000-8000-000000000003";
const TARGET_EMAIL   = "target@memberships-patch.test";
const TARGET_PASS    = "Target-Patch-1!";

// Tenants
const ALPHA_ID       = "e4000000-4000-4000-8000-000000000004";
const BETA_ID        = "e5000000-5000-4000-8000-000000000005";

// Stores in ALPHA
const STORE_A1       = "e6000000-6000-4000-8000-000000000006";
const STORE_A2       = "e7000000-7000-4000-8000-000000000007";
const STORE_A3       = "e8000000-8000-4000-8000-000000000008";

// Store in BETA (cross-tenant validation)
const STORE_B1       = "e9000000-9000-4000-8000-000000000009";

// Roles
const ROLE_OWNER_A   = "ea000000-a000-4000-8000-00000000000a";
const ROLE_ADMIN_A   = "eb000000-b000-4000-8000-00000000000b";
const ROLE_MANAGER_A = "ec000000-c000-4000-8000-00000000000c";
const ROLE_STAFF_A   = "ed000000-d000-4000-8000-00000000000d";
const ROLE_ADMIN_B   = "ee000000-e000-4000-8000-00000000000e";

// Memberships
const MEM_OWNER      = "ef000000-f000-4000-8000-00000000000f";
const MEM_STAFF      = "e0100000-0100-4000-8000-000000000100";

// The "target" membership is re-created between test groups via reseeding helpers.
// We use a stable ID but reset it to known state before each group.
const MEM_TARGET     = "e0200000-0200-4000-8000-000000000200";

// Membership in BETA for cross-tenant test
const MEM_BETA_TARGET = "e0300000-0300-4000-8000-000000000300";

// ---- Bootstrap -------------------------------------------------------------

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

async function seedBase(): Promise<void> {
  const pg = pool!;
  const [ownerH, staffH, targetH] = await Promise.all([
    hashPassword(OWNER_PASS),
    hashPassword(STAFF_PASS),
    hashPassword(TARGET_PASS),
  ]);

  await pg.query(
    `INSERT INTO users (id, email, password_hash) VALUES
       ($1, $2, $3),
       ($4, $5, $6),
       ($7, $8, $9)`,
    [OWNER_ID, OWNER_EMAIL, ownerH, STAFF_ID, STAFF_EMAIL, staffH, TARGET_ID, TARGET_EMAIL, targetH],
  );

  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'alpha-patch', 'Alpha Patch'),
       ($2, 'beta-patch',  'Beta Patch')`,
    [ALPHA_ID, BETA_ID],
  );

  await pg.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $5, 'A1', 'Store A1'),
       ($2, $5, 'A2', 'Store A2'),
       ($3, $5, 'A3', 'Store A3'),
       ($4, $6, 'B1', 'Store B1')`,
    [STORE_A1, STORE_A2, STORE_A3, STORE_B1, ALPHA_ID, BETA_ID],
  );

  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $6, 'owner',         'Owner Alpha'),
       ($2, $6, 'tenant_admin',  'Admin Alpha'),
       ($3, $6, 'store_manager', 'Manager Alpha'),
       ($4, $6, 'store_staff',   'Staff Alpha'),
       ($5, $7, 'tenant_admin',  'Admin Beta')`,
    [ROLE_OWNER_A, ROLE_ADMIN_A, ROLE_MANAGER_A, ROLE_STAFF_A, ROLE_ADMIN_B, ALPHA_ID, BETA_ID],
  );

  // Fixed memberships: OWNER (owner/all) and STAFF (store_staff/all) — never mutated.
  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $3, $4, $5, 'all'),
       ($2, $3, $6, $7, 'all')`,
    [MEM_OWNER, MEM_STAFF, ALPHA_ID, OWNER_ID, ROLE_OWNER_A, STAFF_ID, ROLE_STAFF_A],
  );
}

/** Reset MEM_TARGET to a known state (tenant_admin, store_access_kind=all, no store_access rows). */
async function resetTargetAll(): Promise<void> {
  const pg = pool!;
  await pg.query(`DELETE FROM store_access WHERE membership_id = $1`, [MEM_TARGET]);
  await pg.query(`DELETE FROM memberships WHERE id = $1`, [MEM_TARGET]);
  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1, $2, $3, $4, 'all')`,
    [MEM_TARGET, ALPHA_ID, TARGET_ID, ROLE_ADMIN_A],
  );
}

/** Reset MEM_TARGET to specific with STORE_A1 and STORE_A2. */
async function resetTargetSpecific(storeIds: string[]): Promise<void> {
  const pg = pool!;
  await pg.query(`DELETE FROM store_access WHERE membership_id = $1`, [MEM_TARGET]);
  await pg.query(`DELETE FROM memberships WHERE id = $1`, [MEM_TARGET]);
  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1, $2, $3, $4, 'specific')`,
    [MEM_TARGET, ALPHA_ID, TARGET_ID, ROLE_ADMIN_A],
  );
  for (const storeId of storeIds) {
    await pg.query(
      `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`,
      [MEM_TARGET, storeId, ALPHA_ID],
    );
  }
}

/** Ensure the BETA cross-tenant membership exists for cross-tenant test. */
async function ensureBetaTarget(): Promise<void> {
  const pg = pool!;
  await pg.query(`DELETE FROM memberships WHERE id = $1`, [MEM_BETA_TARGET]);
  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1, $2, $3, $4, 'all')`,
    [MEM_BETA_TARGET, BETA_ID, TARGET_ID, ROLE_ADMIN_B],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });
    await seedBase();
    await ensureBetaTarget();

    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, MembershipsModule],
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
      console.warn(`\n[memberships.patch.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[memberships.patch.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await http()
    .post("/api/v1/auth/signin")
    .send({ email, password })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = list.find((c: string) => c.startsWith("dp2_session="));
  if (!cookie) throw new Error("signIn: no session cookie returned");
  return cookie.split(";")[0]!;
}

async function signInWithTenant(email: string, password: string, tenantId: string): Promise<string> {
  const sessionCookie = await signIn(email, password);
  await http()
    .post("/api/v1/context/tenant")
    .set("Cookie", sessionCookie)
    .send({ tenant_id: tenantId })
    .expect(200);
  return sessionCookie;
}

async function getStoreAccessRows(membershipId: string): Promise<string[]> {
  const res = await pool!.query(
    `SELECT store_id FROM store_access WHERE membership_id = $1 ORDER BY store_id`,
    [membershipId],
  );
  return res.rows.map((r: { store_id: string }) => r.store_id);
}

async function getMembershipRole(membershipId: string): Promise<string> {
  const res = await pool!.query(
    `SELECT r.code FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.id = $1`,
    [membershipId],
  );
  return res.rows[0]?.code as string;
}

async function getMembershipKind(membershipId: string): Promise<string> {
  const res = await pool!.query(
    `SELECT store_access_kind FROM memberships WHERE id = $1`,
    [membershipId],
  );
  return res.rows[0]?.store_access_kind as string;
}

// ===== Layer 1: AuthGuard ===================================================

describe("PATCH /api/v1/memberships/:membership_id — AuthGuard", () => {
  it("unauthenticated → 401", async () => {
    if (maybeSkip()) return;
    await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .send({ role_code: "tenant_admin" })
      .expect(401);
  });
});

// ===== Layer 2: TenantContextGuard ==========================================

describe("PATCH /api/v1/memberships/:membership_id — TenantContextGuard", () => {
  it("authenticated but no active tenant → 401", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(OWNER_EMAIL, OWNER_PASS);
    await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ role_code: "tenant_admin" })
      .expect(401);
  });
});

// ===== Layer 3: RolesGuard (denyAs: 403) ===================================

describe("PATCH /api/v1/memberships/:membership_id — RolesGuard", () => {
  it("store_staff role → 403", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(STAFF_EMAIL, STAFF_PASS, ALPHA_ID);
    await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ role_code: "tenant_admin" })
      .expect(403);
  });
});

// ===== Input validation =====================================================

describe("PATCH /api/v1/memberships/:membership_id — input validation", () => {
  it("non-UUID membership_id → 400", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .patch("/api/v1/memberships/not-a-uuid")
      .set("Cookie", cookie)
      .send({ role_code: "tenant_admin" })
      .expect(400);
  });

  it("empty body → 400", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({})
      .expect(400);
  });

  it("store_access_kind='specific' without store_ids → 400", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ store_access_kind: "specific" })
      .expect(400);
  });

  it("store_access_kind='all' with non-empty store_ids → 400", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ store_access_kind: "all", store_ids: [STORE_A1] })
      .expect(400);
  });

  it("invalid role_code → 400", async () => {
    if (maybeSkip()) return;
    await resetTargetAll();
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ role_code: "does_not_exist" })
      .expect(400);
  });

  it("platform_admin role_code → 400", async () => {
    if (maybeSkip()) return;
    await resetTargetAll();
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ role_code: "platform_admin" })
      .expect(400);
  });

  it("store_ids containing store from another tenant → 400", async () => {
    if (maybeSkip()) return;
    await resetTargetAll();
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ store_access_kind: "specific", store_ids: [STORE_B1] })
      .expect(400);
  });

  it("store_ids provided while existing kind is 'all' and no explicit kind change → 400", async () => {
    if (maybeSkip()) return;
    await resetTargetAll();
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ store_ids: [STORE_A1] })
      .expect(400);
  });

  it("store_ids=[] while existing kind is 'specific' and no explicit kind change → 400", async () => {
    if (maybeSkip()) return;
    await resetTargetSpecific([STORE_A1, STORE_A2]);
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ store_ids: [] })
      .expect(400);

    const dbStores = await getStoreAccessRows(MEM_TARGET);
    expect(dbStores.sort()).toEqual([STORE_A1, STORE_A2].sort());
  });
});

// ===== 404 scenarios ========================================================

describe("PATCH /api/v1/memberships/:membership_id — 404 scenarios", () => {
  it("unknown membership_id → 404", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .patch(`/api/v1/memberships/00000000-0000-4000-8000-000000000000`)
      .set("Cookie", cookie)
      .send({ role_code: "tenant_admin" })
      .expect(404);
  });

  it("cross-tenant membership_id → 404", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .patch(`/api/v1/memberships/${MEM_BETA_TARGET}`)
      .set("Cookie", cookie)
      .send({ role_code: "tenant_admin" })
      .expect(404);
  });

  it("already-revoked membership → 404", async () => {
    if (maybeSkip()) return;
    // Revoke MEM_TARGET first, then try to PATCH it
    await resetTargetAll();
    await pool!.query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [MEM_TARGET]);
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ role_code: "tenant_admin" })
      .expect(404);
    // Restore for subsequent tests
    await resetTargetAll();
  });
});

// ===== Happy path ===========================================================

describe("PATCH /api/v1/memberships/:membership_id — happy path", () => {
  it("all → specific: replaces with submitted store_ids", async () => {
    if (maybeSkip()) return;
    await resetTargetAll();
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);

    const res = await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ store_access_kind: "specific", store_ids: [STORE_A1, STORE_A2] })
      .expect(200);

    expect(res.body.store_access_kind).toBe("specific");
    expect(res.body.accessible_store_ids.sort()).toEqual([STORE_A1, STORE_A2].sort());

    const dbStores = await getStoreAccessRows(MEM_TARGET);
    expect(dbStores.sort()).toEqual([STORE_A1, STORE_A2].sort());
    expect(await getMembershipKind(MEM_TARGET)).toBe("specific");
  });

  it("specific → specific: replaces old list, removes omitted stores", async () => {
    if (maybeSkip()) return;
    await resetTargetSpecific([STORE_A1, STORE_A2]);
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);

    const res = await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ store_access_kind: "specific", store_ids: [STORE_A3] })
      .expect(200);

    expect(res.body.accessible_store_ids).toEqual([STORE_A3]);
    const dbStores = await getStoreAccessRows(MEM_TARGET);
    expect(dbStores).toEqual([STORE_A3]);
  });

  it("specific → all: deletes all store_access rows", async () => {
    if (maybeSkip()) return;
    await resetTargetSpecific([STORE_A1, STORE_A2]);
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);

    const res = await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ store_access_kind: "all" })
      .expect(200);

    expect(res.body.store_access_kind).toBe("all");
    expect(res.body.accessible_store_ids).toEqual([]);
    const dbStores = await getStoreAccessRows(MEM_TARGET);
    expect(dbStores).toEqual([]);
  });

  it("update role only: leaves store access unchanged", async () => {
    if (maybeSkip()) return;
    await resetTargetSpecific([STORE_A1, STORE_A2]);
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);

    const res = await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ role_code: "store_manager" })
      .expect(200);

    expect(res.body.role_code).toBe("store_manager");
    expect(res.body.store_access_kind).toBe("specific");
    expect(res.body.accessible_store_ids.sort()).toEqual([STORE_A1, STORE_A2].sort());

    expect(await getMembershipRole(MEM_TARGET)).toBe("store_manager");
    const dbStores = await getStoreAccessRows(MEM_TARGET);
    expect(dbStores.sort()).toEqual([STORE_A1, STORE_A2].sort());
  });

  it("update store access only: leaves role unchanged", async () => {
    if (maybeSkip()) return;
    await resetTargetAll();
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);

    const res = await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ store_access_kind: "specific", store_ids: [STORE_A1] })
      .expect(200);

    expect(res.body.store_access_kind).toBe("specific");
    expect(res.body.role_code).toBe("tenant_admin");
    expect(await getMembershipRole(MEM_TARGET)).toBe("tenant_admin");
  });

  it("store_ids only while existing kind is 'specific': replaces list", async () => {
    if (maybeSkip()) return;
    await resetTargetSpecific([STORE_A1, STORE_A2]);
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);

    const res = await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ store_ids: [STORE_A3] })
      .expect(200);

    expect(res.body.store_access_kind).toBe("specific");
    expect(res.body.accessible_store_ids).toEqual([STORE_A3]);
    const dbStores = await getStoreAccessRows(MEM_TARGET);
    expect(dbStores).toEqual([STORE_A3]);
  });

  it("response shape is correct", async () => {
    if (maybeSkip()) return;
    await resetTargetAll();
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);

    const res = await http()
      .patch(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .send({ role_code: "tenant_admin" })
      .expect(200);

    expect(res.body).toMatchObject({
      id: MEM_TARGET,
      tenant_id: ALPHA_ID,
      user_id: TARGET_ID,
      role_code: expect.any(String),
      store_access_kind: expect.stringMatching(/^(all|specific)$/),
      accessible_store_ids: expect.any(Array),
    });
  });
});
