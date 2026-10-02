/**
 * T175/T176 — POST /api/v1/memberships/invite spec.
 *
 * Real Postgres via Testcontainers.
 *
 * Scenarios:
 *   1.  Happy path: owner invites with store_access_kind=all → 201, enqueue called
 *   2.  Happy path: specific with valid store_ids → 201, invited_store_ids in response
 *   3.  Response body does NOT contain token or token_hash
 *   4.  DB row has token_hash set (BYTEA, non-null)
 *   5.  Stale pending invite auto-expired, new invite accepted → 201
 *   6.  Non-expired pending invite → 409
 *   7.  Unknown role_code → 400
 *   8.  platform_admin role_code → 400
 *   9.  store_access_kind=specific + store_ids omitted → 400 (Zod)
 *   10. store_access_kind=all + non-empty store_ids → 400 (Zod)
 *   11. Cross-tenant store_ids → 400
 *   12. store_staff caller → 403
 *   13. Unauthenticated → 401
 *   14. No active tenant → 401
 *   15. Invalid email format → 400
 *   16. email is normalised (trimmed + lowercased) before storage
 *   17. tenant_admin caller → 201 (spec SC-6 explicitly names tenant_admin as the actor)
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { hashPassword } from "@data-pulse-2/auth";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { Pool } from "pg";
import request from "supertest";

import { AuthModule, PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
import { EMAIL_JOB_ENQUEUER } from "../../src/auth/email-job.enqueuer";
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

/**
 * Test stub for the REDIS_CLIENT provider.
 *
 * Must satisfy three surfaces consumed by the production module graph:
 *   1. RateLimiter (`incr`, `pexpireNx`, `pttl`) — original surface.
 *   2. IdempotencyKeyStore (`get`, `set` with `{ px }`) — replay storage.
 *   3. InProgressMarker (`set` with `{ nx, ex }`, `del`) — in-flight marker.
 *
 * The marker calls `redis.set(...)` unconditionally; if `set` is missing the
 * interceptor throws `TypeError: this.redis.set is not a function` and the
 * GlobalExceptionFilter returns 500. Mirrors the production AlwaysAllowRedis
 * in `apps/api/src/auth/auth.module.ts` so the test exercises the same shape
 * the real stack would see in a no-Redis environment: `get` returns null
 * (no replay possible), `set` returns null (NX "fails" → marker.trySet
 * reports the slot as taken, false), `del` is a no-op.
 *
 * Returning null from `set` means `marker.trySet` returns false — i.e. every
 * request appears "in-flight to someone else" and the interceptor returns 425.
 * That would still break the spec, so for this test stub we return "OK" to
 * grant the marker slot to every caller (single-threaded request flow, no
 * actual concurrency to protect against). This matches the spec's intent:
 * exercise the route's domain behaviour, not the idempotency replay layer.
 */
class AlwaysAllowRedis implements RedisLike {
  async incr(): Promise<number> { return 1; }
  async pexpireNx(): Promise<number> { return 1; }
  async pttl(): Promise<number> { return -1; }
  async decr(): Promise<number> { return 0; }
  async get(_key: string): Promise<string | null> { return null; }
  async set(
    _key: string,
    _value: string,
    _opts: { px: number } | { nx: true; ex: number },
  ): Promise<"OK" | null> {
    return "OK";
  }
  async del(_key: string): Promise<number> { return 0; }
}

// ---- Fixture IDs -----------------------------------------------------------
// All UUIDv4, prefix "f" to avoid collision with other specs (patch uses "e").

const OWNER_ID       = "f1000000-1000-4000-8000-000000000001";
const OWNER_EMAIL    = "owner@memberships-invite.test";
const OWNER_PASS     = "Owner-Invite-1!";

const STAFF_ID       = "f2000000-2000-4000-8000-000000000002";
const STAFF_EMAIL    = "staff@memberships-invite.test";
const STAFF_PASS     = "Staff-Invite-1!";

const ADMIN_ID       = "fd000000-d000-4000-8000-00000000000d";
const ADMIN_EMAIL    = "admin@memberships-invite.test";
const ADMIN_PASS     = "Admin-Invite-1!";

// Tenants
const ALPHA_ID       = "f3000000-3000-4000-8000-000000000003";
const BETA_ID        = "f4000000-4000-4000-8000-000000000004";

// Stores in ALPHA
const STORE_A1       = "f5000000-5000-4000-8000-000000000005";
const STORE_A2       = "f6000000-6000-4000-8000-000000000006";

// Store in BETA (cross-tenant validation)
const STORE_B1       = "f7000000-7000-4000-8000-000000000007";

// Roles
const ROLE_OWNER_A   = "f8000000-8000-4000-8000-000000000008";
const ROLE_STAFF_A   = "f9000000-9000-4000-8000-000000000009";
const ROLE_ADMIN_A   = "fe000000-e000-4000-8000-00000000000e";

// Memberships
const MEM_OWNER      = "fa000000-a000-4000-8000-00000000000a";
const MEM_STAFF      = "fb000000-b000-4000-8000-00000000000b";
const MEM_ADMIN      = "ff000000-f000-4000-8000-00000000000f";

// ---- Bootstrap -------------------------------------------------------------

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

const enqueueInvitation = jest.fn<Promise<void>, [object]>().mockResolvedValue(undefined);
const mockEmailEnqueuer = { enqueueInvitation };

async function seedBase(): Promise<void> {
  const pg = pool!;
  const [ownerH, staffH, adminH] = await Promise.all([
    hashPassword(OWNER_PASS),
    hashPassword(STAFF_PASS),
    hashPassword(ADMIN_PASS),
  ]);

  await pg.query(
    `INSERT INTO users (id, email, password_hash) VALUES
       ($1, $2, $3),
       ($4, $5, $6),
       ($7, $8, $9)`,
    [OWNER_ID, OWNER_EMAIL, ownerH, STAFF_ID, STAFF_EMAIL, staffH, ADMIN_ID, ADMIN_EMAIL, adminH],
  );

  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'alpha-invite', 'Alpha Invite'),
       ($2, 'beta-invite',  'Beta Invite')`,
    [ALPHA_ID, BETA_ID],
  );

  await pg.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $4, 'A1', 'Store A1'),
       ($2, $4, 'A2', 'Store A2'),
       ($3, $5, 'B1', 'Store B1')`,
    [STORE_A1, STORE_A2, STORE_B1, ALPHA_ID, BETA_ID],
  );

  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $4, 'owner',        'Owner Alpha'),
       ($2, $4, 'store_staff',  'Staff Alpha'),
       ($3, $4, 'tenant_admin', 'Admin Alpha')`,
    [ROLE_OWNER_A, ROLE_STAFF_A, ROLE_ADMIN_A, ALPHA_ID],
  );

  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $4, $5, $6, 'all'),
       ($2, $4, $7, $8, 'all'),
       ($3, $4, $9, $10, 'all')`,
    [MEM_OWNER, MEM_STAFF, MEM_ADMIN, ALPHA_ID,
     OWNER_ID, ROLE_OWNER_A, STAFF_ID, ROLE_STAFF_A, ADMIN_ID, ROLE_ADMIN_A],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });
    await seedBase();

    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, MembershipsModule],
    })
      .overrideProvider(PG_POOL).useValue(pool)
      .overrideProvider(REDIS_CLIENT).useValue(new AlwaysAllowRedis())
      .overrideProvider(EMAIL_JOB_ENQUEUER).useValue(mockEmailEnqueuer)
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
      console.warn(`\n[invitations.create.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
  enqueueInvitation.mockClear();
});

function http() {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}

/**
 * Generate a unique per-call Idempotency-Key satisfying the
 * IdempotencyInterceptor regex (16–128 printable ASCII, no whitespace).
 * A UUIDv4 is 36 characters and fits cleanly. Each call returns a new value
 * so tests that issue multiple POSTs (e.g. the 409 duplicate-pending test)
 * do not accidentally trigger replay semantics.
 */
function idemKey(): string {
  return randomUUID();
}

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[invitations.create.spec] skipping (Docker unavailable)");
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

async function getInvitationRow(id: string): Promise<Record<string, unknown> | null> {
  const res = await pool!.query(
    `SELECT id, tenant_id, email, role_id, store_access_kind, invited_store_ids,
            token_hash, status, expires_at
     FROM invitations WHERE id = $1`,
    [id],
  );
  return (res.rows[0] as Record<string, unknown>) ?? null;
}

async function cleanInvitations(): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM invitations WHERE tenant_id = $1`, [ALPHA_ID]);
}

// ===== 1. Happy path: all access ============================================

describe("POST /api/v1/memberships/invite — happy path (all)", () => {
  afterEach(cleanInvitations);

  it("returns 201 with correct shape for store_access_kind=all", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "invitee@example.com", role_code: "owner", store_access_kind: "all" })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.tenant_id).toBe(ALPHA_ID);
    expect(res.body.email).toBe("invitee@example.com");
    expect(res.body.store_access_kind).toBe("all");
    expect(res.body.status).toBe("pending");
    expect(res.body.expires_at).toBeDefined();
  });

  it("calls enqueueInvitation once after commit with correct email and tenantId", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "enqueue@example.com", role_code: "owner", store_access_kind: "all" })
      .expect(201);

    expect(enqueueInvitation).toHaveBeenCalledTimes(1);
    const job = enqueueInvitation.mock.calls[0]![0] as Record<string, unknown>;
    expect(job["email"]).toBe("enqueue@example.com");
    expect(job["tenantId"]).toBe(ALPHA_ID);
    expect(job["rawToken"]).toBeDefined();
    expect(typeof job["rawToken"]).toBe("string");
  });
});

// ===== 2. Happy path: specific store access =================================

describe("POST /api/v1/memberships/invite — happy path (specific)", () => {
  afterEach(cleanInvitations);

  it("returns 201 with invited_store_ids when store_access_kind=specific", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({
        email: "specific@example.com",
        role_code: "owner",
        store_access_kind: "specific",
        store_ids: [STORE_A1, STORE_A2],
      })
      .expect(201);

    expect(res.body.store_access_kind).toBe("specific");
    const stored = (res.body.invited_store_ids as string[]).sort();
    expect(stored).toEqual([STORE_A1, STORE_A2].sort());
  });
});

// ===== 3. Token security: not in response ===================================

describe("POST /api/v1/memberships/invite — token security", () => {
  afterEach(cleanInvitations);

  it("response body does NOT contain 'token' or 'token_hash' properties", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "notoken@example.com", role_code: "owner", store_access_kind: "all" })
      .expect(201);

    expect(res.body).not.toHaveProperty("token");
    expect(res.body).not.toHaveProperty("token_hash");
    expect(res.body).not.toHaveProperty("rawToken");
  });

  it("DB row has token_hash set to a non-null Buffer", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "dbtoken@example.com", role_code: "owner", store_access_kind: "all" })
      .expect(201);

    const row = await getInvitationRow(res.body.id as string);
    expect(row).not.toBeNull();
    expect(row!["token_hash"]).not.toBeNull();
    // token_hash should be a non-empty Buffer (BYTEA → Buffer in pg driver)
    expect(Buffer.isBuffer(row!["token_hash"])).toBe(true);
    expect((row!["token_hash"] as Buffer).length).toBeGreaterThan(0);
  });
});

// ===== 4. Email normalisation ===============================================

describe("POST /api/v1/memberships/invite — email normalisation", () => {
  afterEach(cleanInvitations);

  it("trims and lowercases email before storage", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "  Normalized@Example.COM  ", role_code: "owner", store_access_kind: "all" })
      .expect(201);

    expect(res.body.email).toBe("normalized@example.com");
    const row = await getInvitationRow(res.body.id as string);
    expect(row!["email"]).toBe("normalized@example.com");
  });
});

// ===== 5. Stale invite auto-expiry ==========================================

describe("POST /api/v1/memberships/invite — stale invite auto-expiry", () => {
  afterEach(cleanInvitations);

  it("auto-expires a stale pending invite and allows a new one", async () => {
    if (maybeSkip()) return;
    // Insert a stale pending invite (expires_at in the past)
    await pool!.query(
      `INSERT INTO invitations (id, tenant_id, email, role_id, store_access_kind,
         invited_store_ids, invited_by_user_id, token_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, 'all', '{}', $5, $6, 'pending', now() - interval '1 second')`,
      [
        "fc000000-c000-4000-8000-00000000000c",
        ALPHA_ID,
        "stale@example.com",
        ROLE_OWNER_A,
        OWNER_ID,
        Buffer.alloc(32, 0xab),
      ],
    );

    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "stale@example.com", role_code: "owner", store_access_kind: "all" })
      .expect(201);

    expect(res.body.email).toBe("stale@example.com");

    // Original stale invite should now be 'expired'
    const staleRow = await pool!.query(
      `SELECT status FROM invitations WHERE id = $1`,
      ["fc000000-c000-4000-8000-00000000000c"],
    );
    expect(staleRow.rows[0]?.status).toBe("expired");
  });
});

// ===== 6. Duplicate pending invite → 409 ====================================

describe("POST /api/v1/memberships/invite — duplicate pending invite", () => {
  afterEach(cleanInvitations);

  it("returns 409 when a non-expired pending invite already exists", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    // First invite succeeds. Use a fresh key per request so the second
    // call exercises the domain-level duplicate-pending path (409 from
    // InvitationsService), not the idempotency replay/conflict path.
    await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "duplicate@example.com", role_code: "owner", store_access_kind: "all" })
      .expect(201);

    // Second invite for same email → 409
    await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "duplicate@example.com", role_code: "owner", store_access_kind: "all" })
      .expect(409);
  });
});

// ===== 7–8. Role validation =================================================

describe("POST /api/v1/memberships/invite — role validation", () => {
  it("unknown role_code → 400", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "x@example.com", role_code: "no_such_role", store_access_kind: "all" })
      .expect(400);
  });

  it("platform_admin role_code → 400", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "x@example.com", role_code: "platform_admin", store_access_kind: "all" })
      .expect(400);
  });
});

// ===== 9–10. Zod cross-field validation =====================================

describe("POST /api/v1/memberships/invite — Zod validation", () => {
  it("store_access_kind=specific + store_ids omitted → 400", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "x@example.com", role_code: "owner", store_access_kind: "specific" })
      .expect(400);
  });

  it("store_access_kind=all + non-empty store_ids → 400", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({
        email: "x@example.com",
        role_code: "owner",
        store_access_kind: "all",
        store_ids: [STORE_A1],
      })
      .expect(400);
  });

  it("invalid email format → 400", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "not-an-email", role_code: "owner", store_access_kind: "all" })
      .expect(400);
  });
});

// ===== 11. Cross-tenant store_ids → 400 =====================================

describe("POST /api/v1/memberships/invite — cross-tenant store_ids", () => {
  it("store_ids from another tenant → 400", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({
        email: "x@example.com",
        role_code: "owner",
        store_access_kind: "specific",
        store_ids: [STORE_B1],
      })
      .expect(400);
  });
});

// ===== 12. RolesGuard (denyAs: 403) =========================================

describe("POST /api/v1/memberships/invite — RolesGuard", () => {
  it("store_staff caller → 403", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(STAFF_EMAIL, STAFF_PASS, ALPHA_ID);
    await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .send({ email: "x@example.com", role_code: "owner", store_access_kind: "all" })
      .expect(403);
  });
});

// ===== 13. AuthGuard =========================================================

describe("POST /api/v1/memberships/invite — AuthGuard", () => {
  it("unauthenticated → 401", async () => {
    if (maybeSkip()) return;
    await http()
      .post("/api/v1/memberships/invite")
      .send({ email: "x@example.com", role_code: "owner", store_access_kind: "all" })
      .expect(401);
  });
});

// ===== 14. TenantContextGuard ================================================

describe("POST /api/v1/memberships/invite — TenantContextGuard", () => {
  it("authenticated but no active tenant → 401", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(OWNER_EMAIL, OWNER_PASS);
    await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .send({ email: "x@example.com", role_code: "owner", store_access_kind: "all" })
      .expect(401);
  });
});

// ===== 17. tenant_admin caller (spec SC-6) ===================================
// spec.md SC-6: "A new tenant admin can invite a user" — the controller allows
// both owner and tenant_admin; this test proves tenant_admin is not blocked.

describe("POST /api/v1/memberships/invite — tenant_admin caller", () => {
  afterEach(cleanInvitations);

  it("tenant_admin caller → 201 (spec SC-6)", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(ADMIN_EMAIL, ADMIN_PASS, ALPHA_ID);
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Cookie", cookie)
      .set("Idempotency-Key", idemKey())
      .send({ email: "invited-by-admin@example.com", role_code: "store_staff", store_access_kind: "all" })
      .expect(201);

    expect(res.body.tenant_id).toBe(ALPHA_ID);
    expect(res.body.email).toBe("invited-by-admin@example.com");
    expect(res.body.status).toBe("pending");
  });
});
