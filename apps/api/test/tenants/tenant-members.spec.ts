/**
 * T131 (extension) — GET /api/v1/tenants/:id/members spec.
 *
 * Real Postgres via Testcontainers. Pins the `listMembers` endpoint
 * added to `TenantsController`:
 *
 *   GET /api/v1/tenants/:id/members
 *
 * Authorization layers tested
 * ---------------------------
 *   Layer 1 — AuthGuard (class-level):
 *     Unauthenticated requests → 401.
 *
 *   Layer 2 — RolesGuard + @RolesFromParam("id", "owner", "tenant_admin"):
 *     store_staff in tenant → 404 (denyAs: 404, FR-ISO-4).
 *     no membership in tenant → 404.
 *     cross-tenant caller → 404.
 *     platform admin → bypassed → 200.
 *
 * Response shape tested
 * --------------------
 *   - Non-deleted, non-revoked memberships returned.
 *   - Revoked memberships excluded.
 *   - Soft-deleted memberships excluded.
 *   - store_access_kind="all"      → accessible_store_ids: [].
 *   - store_access_kind="specific" → accessible_store_ids: [storeId].
 *   - Each entry has: membership_id, user.{id,email,display_name},
 *     role_code, store_access_kind, accessible_store_ids, revoked_at.
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
import { TenantsModule } from "../../src/tenants/tenants.module";
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
// All UUIDv4 (ParseUUIDPipe compatible). Prefix "c" to avoid collision
// with other specs in the same container if they ever share a DB.

const ALICE_ID       = "c1000000-1000-4000-8000-000000000001"; // platform admin
const ALICE_EMAIL    = "alice@tenant-members.test";
const ALICE_PASS     = "Alice-Members-1!";

const BOB_ID         = "c2000000-2000-4000-8000-000000000002"; // tenant_admin in ACME
const BOB_EMAIL      = "bob@tenant-members.test";
const BOB_PASS       = "Bob-Members-1!";
const BOB_DISPLAY    = "Bob Admin";

const CAROL_ID       = "c3000000-3000-4000-8000-000000000003"; // store_staff in ACME
const CAROL_EMAIL    = "carol@tenant-members.test";
const CAROL_PASS     = "Carol-Members-1!";

const DAVE_ID        = "c4000000-4000-4000-8000-000000000004"; // no membership anywhere
const DAVE_EMAIL     = "dave@tenant-members.test";
const DAVE_PASS      = "Dave-Members-1!";

const EVE_ID         = "c5000000-5000-4000-8000-000000000005"; // tenant_admin in ACME, will be revoked
const EVE_EMAIL      = "eve@tenant-members.test";
const EVE_PASS       = "Eve-Members-1!";

const FRANK_ID       = "c6000000-6000-4000-8000-000000000006"; // tenant_admin in ACME, will be soft-deleted
const FRANK_EMAIL    = "frank@tenant-members.test";
const FRANK_PASS     = "Frank-Members-1!";

const GRACE_ID       = "c7000000-7000-4000-8000-000000000007"; // store_staff in ACME with specific access
const GRACE_EMAIL    = "grace@tenant-members.test";
const GRACE_PASS     = "Grace-Members-1!";

// Tenants
const ACME_ID        = "c8000000-8000-4000-8000-000000000008";
const GLOBEX_ID      = "c9000000-9000-4000-8000-000000000009";

// Roles in ACME
const ROLE_TENANT_ADMIN = "ca000000-a000-4000-8000-00000000000a";
const ROLE_STORE_STAFF  = "cb000000-b000-4000-8000-00000000000b";

// Memberships in ACME
const MEM_BOB        = "cc000000-c000-4000-8000-00000000000c"; // tenant_admin, all stores
const MEM_CAROL      = "cd000000-d000-4000-8000-00000000000d"; // store_staff, all stores
const MEM_EVE        = "ce000000-e000-4000-8000-00000000000e"; // tenant_admin, will be revoked
const MEM_FRANK      = "cf000000-f000-4000-8000-00000000000f"; // tenant_admin, will be soft-deleted
const MEM_GRACE      = "c0100000-0100-4000-8000-000000000100"; // store_staff, specific access

// Store in ACME
const STORE_ID       = "c0200000-0200-4000-8000-000000000200";

// ---- Test bootstrap ----------------------------------------------------

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

async function seed(): Promise<void> {
  const pg = pool!;

  const hashes = await Promise.all([
    hashPassword(ALICE_PASS),
    hashPassword(BOB_PASS),
    hashPassword(CAROL_PASS),
    hashPassword(DAVE_PASS),
    hashPassword(EVE_PASS),
    hashPassword(FRANK_PASS),
    hashPassword(GRACE_PASS),
  ]);
  const [aliceH, bobH, carolH, daveH, eveH, frankH, graceH] = hashes;

  await pg.query(
    `INSERT INTO users (id, email, password_hash, display_name, is_platform_admin)
     VALUES ($1,  $2,  $3,  $4,  true),
            ($5,  $6,  $7,  $8,  false),
            ($9,  $10, $11, $12, false),
            ($13, $14, $15, $16, false),
            ($17, $18, $19, $20, false),
            ($21, $22, $23, $24, false),
            ($25, $26, $27, $28, false)`,
    [
      ALICE_ID, ALICE_EMAIL, aliceH, null,
      BOB_ID,   BOB_EMAIL,   bobH,   BOB_DISPLAY,
      CAROL_ID, CAROL_EMAIL, carolH, null,
      DAVE_ID,  DAVE_EMAIL,  daveH,  null,
      EVE_ID,   EVE_EMAIL,   eveH,   null,
      FRANK_ID, FRANK_EMAIL, frankH, null,
      GRACE_ID, GRACE_EMAIL, graceH, null,
    ],
  );

  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'acme-members', 'Acme'),
       ($2, 'globex-members', 'Globex')`,
    [ACME_ID, GLOBEX_ID],
  );

  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $3, 'tenant_admin', 'Tenant Admin'),
       ($2, $3, 'store_staff',  'Store Staff')`,
    [ROLE_TENANT_ADMIN, ROLE_STORE_STAFF, ACME_ID],
  );

  await pg.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $2, 'STORE-01', 'Store One')`,
    [STORE_ID, ACME_ID],
  );

  // Bob — tenant_admin, all stores (active)
  // Carol — store_staff, all stores (active)
  // Eve — tenant_admin, all stores (will be revoked below)
  // Frank — tenant_admin, all stores (will be soft-deleted below)
  // Grace — store_staff, specific access (active)
  // Each row: (id, tenant_id, user_id, role_id, kind)
  // $1–$4 = BOB row; $5–$8 = CAROL row; $9–$12 = EVE row;
  // $13–$16 = FRANK row; $17–$20 = GRACE row
  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1,  $2,  $3,  $4,  'all'),
            ($5,  $6,  $7,  $8,  'all'),
            ($9,  $10, $11, $12, 'all'),
            ($13, $14, $15, $16, 'all'),
            ($17, $18, $19, $20, 'specific')`,
    [
      MEM_BOB,   ACME_ID, BOB_ID,   ROLE_TENANT_ADMIN,
      MEM_CAROL, ACME_ID, CAROL_ID, ROLE_STORE_STAFF,
      MEM_EVE,   ACME_ID, EVE_ID,   ROLE_TENANT_ADMIN,
      MEM_FRANK, ACME_ID, FRANK_ID, ROLE_TENANT_ADMIN,
      MEM_GRACE, ACME_ID, GRACE_ID, ROLE_STORE_STAFF,
    ],
  );

  // Grant Grace specific access to STORE_ID
  await pg.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id)
     VALUES ($1, $2, $3)`,
    [MEM_GRACE, STORE_ID, ACME_ID],
  );

  // Revoke Eve's membership
  await pg.query(
    `UPDATE memberships SET revoked_at = now() WHERE id = $1`,
    [MEM_EVE],
  );

  // Soft-delete Frank's membership
  await pg.query(
    `UPDATE memberships SET deleted_at = now() WHERE id = $1`,
    [MEM_FRANK],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });
    await seed();

    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, TenantsModule],
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
      console.warn(`\n[tenant-members.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[tenant-members.spec] skipping (Docker unavailable)");
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

// ===== Unauthenticated → 401 ============================================

describe("GET /tenants/:id/members — unauthenticated → 401", () => {
  it("no cookie → 401", async () => {
    if (maybeSkip()) return;
    await http()
      .get(`/api/v1/tenants/${ACME_ID}/members`)
      .expect(401);
  });
});

// ===== store_staff denied → 404 =========================================

describe("GET /tenants/:id/members — store_staff → 404 (FR-ISO-4)", () => {
  it("store_staff role in tenant → 404", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(CAROL_EMAIL, CAROL_PASS);
    await http()
      .get(`/api/v1/tenants/${ACME_ID}/members`)
      .set("Cookie", cookie)
      .expect(404);
  });
});

// ===== non-member denied → 404 ==========================================

describe("GET /tenants/:id/members — non-member → 404", () => {
  it("user with no membership in tenant → 404", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(DAVE_EMAIL, DAVE_PASS);
    await http()
      .get(`/api/v1/tenants/${ACME_ID}/members`)
      .set("Cookie", cookie)
      .expect(404);
  });
});

// ===== cross-tenant → 404 ===============================================

describe("GET /tenants/:id/members — cross-tenant → 404", () => {
  it("tenant_admin of ACME calling members of GLOBEX → 404", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASS);
    await http()
      .get(`/api/v1/tenants/${GLOBEX_ID}/members`)
      .set("Cookie", cookie)
      .expect(404);
  });
});

// ===== tenant_admin happy path ==========================================

describe("GET /tenants/:id/members — tenant_admin → 200", () => {
  it("returns 200 with MembershipDetail array", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASS);
    const res = await http()
      .get(`/api/v1/tenants/${ACME_ID}/members`)
      .set("Cookie", cookie)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    const first = res.body[0];
    expect(first).toHaveProperty("membership_id");
    expect(first).toHaveProperty("user");
    expect(first.user).toHaveProperty("id");
    expect(first.user).toHaveProperty("email");
    expect(first.user).toHaveProperty("display_name");
    expect(first).toHaveProperty("role_code");
    expect(first).toHaveProperty("store_access_kind");
    expect(first).toHaveProperty("accessible_store_ids");
    expect(first).toHaveProperty("revoked_at");
  });

  it("Bob (tenant_admin) appears in the list with display_name", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASS);
    const res = await http()
      .get(`/api/v1/tenants/${ACME_ID}/members`)
      .set("Cookie", cookie)
      .expect(200);

    const bob = res.body.find((m: { membership_id: string }) => m.membership_id === MEM_BOB);
    expect(bob).toBeDefined();
    expect(bob.user.id).toBe(BOB_ID);
    expect(bob.user.email).toBe(BOB_EMAIL);
    expect(bob.user.display_name).toBe(BOB_DISPLAY);
    expect(bob.role_code).toBe("tenant_admin");
    expect(bob.store_access_kind).toBe("all");
    expect(bob.accessible_store_ids).toEqual([]);
    expect(bob.revoked_at).toBeNull();
  });

  it("user with null display_name has display_name: null in response", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASS);
    const res = await http()
      .get(`/api/v1/tenants/${ACME_ID}/members`)
      .set("Cookie", cookie)
      .expect(200);

    const carol = res.body.find((m: { membership_id: string }) => m.membership_id === MEM_CAROL);
    expect(carol).toBeDefined();
    expect(carol.user.display_name).toBeNull();
  });
});

// ===== revoked membership excluded ======================================

describe("GET /tenants/:id/members — revoked excluded", () => {
  it("Eve's revoked membership is not in the list", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASS);
    const res = await http()
      .get(`/api/v1/tenants/${ACME_ID}/members`)
      .set("Cookie", cookie)
      .expect(200);

    const eve = res.body.find((m: { membership_id: string }) => m.membership_id === MEM_EVE);
    expect(eve).toBeUndefined();
  });
});

// ===== soft-deleted membership excluded =================================

describe("GET /tenants/:id/members — soft-deleted excluded", () => {
  it("Frank's soft-deleted membership is not in the list", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASS);
    const res = await http()
      .get(`/api/v1/tenants/${ACME_ID}/members`)
      .set("Cookie", cookie)
      .expect(200);

    const frank = res.body.find((m: { membership_id: string }) => m.membership_id === MEM_FRANK);
    expect(frank).toBeUndefined();
  });
});

// ===== specific access includes store ids ===============================

describe("GET /tenants/:id/members — specific access → accessible_store_ids", () => {
  it("Grace's membership has store_access_kind=specific and includes STORE_ID", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASS);
    const res = await http()
      .get(`/api/v1/tenants/${ACME_ID}/members`)
      .set("Cookie", cookie)
      .expect(200);

    const grace = res.body.find((m: { membership_id: string }) => m.membership_id === MEM_GRACE);
    expect(grace).toBeDefined();
    expect(grace.store_access_kind).toBe("specific");
    expect(grace.accessible_store_ids).toContain(STORE_ID);
  });
});

// ===== all access returns empty array ===================================

describe("GET /tenants/:id/members — all access → accessible_store_ids: []", () => {
  it("Bob's all-access membership returns empty accessible_store_ids", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASS);
    const res = await http()
      .get(`/api/v1/tenants/${ACME_ID}/members`)
      .set("Cookie", cookie)
      .expect(200);

    const bob = res.body.find((m: { membership_id: string }) => m.membership_id === MEM_BOB);
    expect(bob).toBeDefined();
    expect(bob.accessible_store_ids).toEqual([]);
  });
});

// ===== platform admin bypass ============================================

describe("GET /tenants/:id/members — platform admin → 200", () => {
  it("platform admin can list members of any tenant", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(ALICE_EMAIL, ALICE_PASS);
    const res = await http()
      .get(`/api/v1/tenants/${ACME_ID}/members`)
      .set("Cookie", cookie)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("platform admin can list members of GLOBEX (which has no memberships)", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(ALICE_EMAIL, ALICE_PASS);
    const res = await http()
      .get(`/api/v1/tenants/${GLOBEX_ID}/members`)
      .set("Cookie", cookie)
      .expect(200);

    expect(res.body).toEqual([]);
  });
});
