/**
 * T173/T174 — DELETE /api/v1/memberships/:membership_id spec.
 *
 * Real Postgres via Testcontainers. Pins the `revoke` endpoint added to
 * `MembershipsController`:
 *
 *   DELETE /api/v1/memberships/:membership_id
 *
 * Authorization layers tested
 * ---------------------------
 *   Layer 1 — AuthGuard (class-level):
 *     Unauthenticated requests → 401.
 *
 *   Layer 2 — TenantContextGuard (class-level):
 *     No active tenant (not switched) → 401.
 *
 *   Layer 3 — RolesGuard + @Roles("owner","tenant_admin",{denyAs:403}):
 *     store_staff role → 403.
 *     Insufficient role with valid membership → 403.
 *
 * Happy path
 * ----------
 *   - tenant_admin revokes a membership → 204.
 *   - platform admin (via active-tenant context) revokes → 204.
 *   - Revoked membership: `revoked_at` is set in DB.
 *
 * 404 scenarios (service-level)
 * -----------------------------
 *   - Unknown membership_id → 404.
 *   - Already-revoked membership → 404.
 *   - Cross-tenant membership_id (visible in tenant B, caller in tenant A) → 404.
 *
 * Input validation
 * ----------------
 *   - Non-UUID membership_id → 400 (ParseUUIDPipe).
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
import { MembershipsModule } from "../../src/memberships/memberships.module";
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

// ---- Fixture IDs -------------------------------------------------------
// All UUIDv4 (ParseUUIDPipe compatible). Prefix "d" to avoid collision
// with other specs in the same container.

const ADMIN_ID       = "d1000000-1000-4000-8000-000000000001"; // platform admin
const ADMIN_EMAIL    = "admin@memberships-ctrl.test";
const ADMIN_PASS     = "Admin-Mem-Ctrl-1!";

const OWNER_ID       = "d2000000-2000-4000-8000-000000000002"; // owner in ALPHA
const OWNER_EMAIL    = "owner@memberships-ctrl.test";
const OWNER_PASS     = "Owner-Mem-Ctrl-1!";

const STAFF_ID       = "d3000000-3000-4000-8000-000000000003"; // store_staff in ALPHA
const STAFF_EMAIL    = "staff@memberships-ctrl.test";
const STAFF_PASS     = "Staff-Mem-Ctrl-1!";

const TARGET_ID      = "d4000000-4000-4000-8000-000000000004"; // user whose membership will be revoked
const TARGET_EMAIL   = "target@memberships-ctrl.test";
const TARGET_PASS    = "Target-Mem-Ctrl-1!";

const OTHER_ID       = "d5000000-5000-4000-8000-000000000005"; // user in BETA only
const OTHER_EMAIL    = "other@memberships-ctrl.test";
const OTHER_PASS     = "Other-Mem-Ctrl-1!";

// Tenants
const ALPHA_ID       = "d6000000-6000-4000-8000-000000000006";
const BETA_ID        = "d7000000-7000-4000-8000-000000000007";

// Roles
const ROLE_OWNER     = "d8000000-8000-4000-8000-000000000008"; // owner in ALPHA
const ROLE_ADMIN_A   = "d9000000-9000-4000-8000-000000000009"; // tenant_admin in ALPHA
const ROLE_STAFF_A   = "da000000-a000-4000-8000-00000000000a"; // store_staff in ALPHA
const ROLE_ADMIN_B   = "db000000-b000-4000-8000-00000000000b"; // tenant_admin in BETA

// Memberships
const MEM_OWNER      = "dc000000-c000-4000-8000-00000000000c"; // owner in ALPHA
const MEM_STAFF      = "dd000000-d000-4000-8000-00000000000d"; // store_staff in ALPHA
const MEM_TARGET     = "de000000-e000-4000-8000-00000000000e"; // tenant_admin in ALPHA (will be revoked)
const MEM_REVOKED    = "df000000-f000-4000-8000-00000000000f"; // pre-revoked membership in ALPHA
const MEM_OTHER_BETA = "d0100000-0100-4000-8000-000000000100"; // OTHER's membership in BETA
const MEM_ADMIN_BETA = "d0200000-0200-4000-8000-000000000200"; // ADMIN's membership in BETA (for platform-admin test)

// ---- Test bootstrap ----------------------------------------------------

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

async function seed(): Promise<void> {
  const pg = pool!;

  const hashes = await Promise.all([
    hashPassword(ADMIN_PASS),
    hashPassword(OWNER_PASS),
    hashPassword(STAFF_PASS),
    hashPassword(TARGET_PASS),
    hashPassword(OTHER_PASS),
  ]);
  const [adminH, ownerH, staffH, targetH, otherH] = hashes;

  await pg.query(
    `INSERT INTO users (id, email, password_hash, is_platform_admin)
     VALUES ($1,  $2,  $3,  true),
            ($4,  $5,  $6,  false),
            ($7,  $8,  $9,  false),
            ($10, $11, $12, false),
            ($13, $14, $15, false)`,
    [
      ADMIN_ID,  ADMIN_EMAIL,  adminH,
      OWNER_ID,  OWNER_EMAIL,  ownerH,
      STAFF_ID,  STAFF_EMAIL,  staffH,
      TARGET_ID, TARGET_EMAIL, targetH,
      OTHER_ID,  OTHER_EMAIL,  otherH,
    ],
  );

  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'alpha-memberships', 'Alpha'),
       ($2, 'beta-memberships',  'Beta')`,
    [ALPHA_ID, BETA_ID],
  );

  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $5, 'owner',        'Owner Alpha'),
       ($2, $5, 'tenant_admin', 'Tenant Admin Alpha'),
       ($3, $5, 'store_staff',  'Store Staff Alpha'),
       ($4, $6, 'tenant_admin', 'Tenant Admin Beta')`,
    [ROLE_OWNER, ROLE_ADMIN_A, ROLE_STAFF_A, ROLE_ADMIN_B, ALPHA_ID, BETA_ID],
  );

  // Memberships in ALPHA:
  //   OWNER         → owner (active)
  //   STAFF         → store_staff (active)
  //   TARGET        → tenant_admin (active — will be revoked by tests)
  //   MEM_REVOKED   → tenant_admin (pre-revoked)
  //   ADMIN in BETA → tenant_admin (for platform-admin active-tenant test)
  //   OTHER in BETA → tenant_admin (cross-tenant test fixture)
  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1,  $2,  $3,  $4,  'all'),
            ($5,  $6,  $7,  $8,  'all'),
            ($9,  $10, $11, $12, 'all'),
            ($13, $14, $15, $16, 'all'),
            ($17, $18, $19, $20, 'all'),
            ($21, $22, $23, $24, 'all')`,
    [
      MEM_OWNER,      ALPHA_ID, OWNER_ID,  ROLE_OWNER,
      MEM_STAFF,      ALPHA_ID, STAFF_ID,  ROLE_STAFF_A,
      MEM_TARGET,     ALPHA_ID, TARGET_ID, ROLE_ADMIN_A,
      MEM_REVOKED,    ALPHA_ID, OTHER_ID,  ROLE_ADMIN_A,
      MEM_ADMIN_BETA, BETA_ID,  ADMIN_ID,  ROLE_ADMIN_B,
      MEM_OTHER_BETA, BETA_ID,  OTHER_ID,  ROLE_ADMIN_B,
    ],
  );

  // Pre-revoke MEM_REVOKED
  await pg.query(
    `UPDATE memberships SET revoked_at = now() WHERE id = $1`,
    [MEM_REVOKED],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });
    await seed();

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
      console.warn(`\n[memberships.controller.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[memberships.controller.spec] skipping (Docker unavailable)");
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

// ===== Layer 1: AuthGuard ===============================================

describe("DELETE /api/v1/memberships/:membership_id — AuthGuard", () => {
  it("unauthenticated → 401", async () => {
    if (maybeSkip()) return;
    await http()
      .delete(`/api/v1/memberships/${MEM_TARGET}`)
      .expect(401);
  });
});

// ===== Layer 2: TenantContextGuard ======================================

describe("DELETE /api/v1/memberships/:membership_id — TenantContextGuard", () => {
  it("authenticated but no active tenant → 401", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(OWNER_EMAIL, OWNER_PASS);
    await http()
      .delete(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .expect(401);
  });
});

// ===== Layer 3: RolesGuard (denyAs: 403) =================================

describe("DELETE /api/v1/memberships/:membership_id — RolesGuard", () => {
  it("store_staff role → 403", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(STAFF_EMAIL, STAFF_PASS, ALPHA_ID);
    await http()
      .delete(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .expect(403);
  });
});

// ===== Input validation ==================================================

describe("DELETE /api/v1/memberships/:membership_id — input validation", () => {
  it("non-UUID membership_id → 400", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .delete("/api/v1/memberships/not-a-uuid")
      .set("Cookie", cookie)
      .expect(400);
  });
});

// ===== 404 scenarios ====================================================

describe("DELETE /api/v1/memberships/:membership_id — 404 scenarios", () => {
  it("unknown membership_id → 404", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    const unknownId = "00000000-0000-4000-8000-000000000000";
    await http()
      .delete(`/api/v1/memberships/${unknownId}`)
      .set("Cookie", cookie)
      .expect(404);
  });

  it("already-revoked membership → 404", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .delete(`/api/v1/memberships/${MEM_REVOKED}`)
      .set("Cookie", cookie)
      .expect(404);
  });

  it("cross-tenant membership_id (belongs to BETA, caller active in ALPHA) → 404", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    // MEM_OTHER_BETA belongs to BETA — RLS filters it, service sees 0 rows → 404
    await http()
      .delete(`/api/v1/memberships/${MEM_OTHER_BETA}`)
      .set("Cookie", cookie)
      .expect(404);
  });
});

// ===== Happy path ========================================================

describe("DELETE /api/v1/memberships/:membership_id — happy path", () => {
  it("owner revokes a tenant_admin membership → 204", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .delete(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .expect(204);
  });

  it("revoked membership has revoked_at set in DB", async () => {
    if (maybeSkip()) return;
    const row = await pool!.query(
      "SELECT revoked_at FROM memberships WHERE id = $1",
      [MEM_TARGET],
    );
    expect(row.rows[0]?.revoked_at).not.toBeNull();
  });

  it("second DELETE on already-revoked membership → 404", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .delete(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", cookie)
      .expect(404);
  });

  it("platform admin with active BETA tenant revokes a BETA membership → 204", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(ADMIN_EMAIL, ADMIN_PASS, BETA_ID);
    await http()
      .delete(`/api/v1/memberships/${MEM_OTHER_BETA}`)
      .set("Cookie", cookie)
      .expect(204);
  });
});
