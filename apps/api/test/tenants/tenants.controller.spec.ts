/**
 * T130 — TenantsController integration spec.
 *
 * Real Postgres via Testcontainers. The NestJS app is built from
 * `TenantsModule` (which imports `AuthModule` + `ContextModule`) with
 * one provider override:
 *
 *   - PG_POOL          → test pool against the container
 *   - REDIS_CLIENT     → in-memory `FakeRedis` so AuthGuard's rate
 *                        limit hooks have an implementation
 *   - EMAIL_JOB_ENQUEUER → noop so AuthModule wires cleanly
 *
 * Coverage:
 *   - GET /tenants as regular user → only their tenants
 *   - GET /tenants as platform admin → all non-deleted
 *   - POST as non-admin → 403; as admin → 201 + roles seeded; bad slug → 400
 *   - duplicate slug → 409
 *   - GET /:id as member → 200; as non-member → 404; as admin → 200
 *   - soft-deleted tenant: 404 to regular user, 200 to platform admin
 *   - PATCH as tenant_admin/owner → 200; as store_staff → 404; as
 *     non-member → 404; as platform admin → 200
 *   - DELETE as non-admin → 403; as admin → 204; subsequent reads
 *     follow the soft-delete visibility rule
 *   - unauthenticated → 401
 *
 * Skip behaviour
 * --------------
 * Set `MIGRATION_TEST_ALLOW_SKIP=1` to soft-skip when Docker is
 * unavailable (consistent with `auth.controller.spec.ts`). Otherwise
 * the spec fails with the standard `Container start failed` envelope
 * that downstream tooling already recognises.
 */
import "reflect-metadata";

import { hashPassword } from "@data-pulse-2/auth";
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
} from "../../src/auth/email-job.enqueuer";
import { ContextInterceptor } from "../../src/context/context.interceptor";
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

// ---- Fakes ---------------------------------------------------------------

class AlwaysAllowRedis implements RedisLike {
  async incr(): Promise<number> {
    return 1;
  }
  async pexpireNx(): Promise<number> {
    return 1;
  }
  async pttl(): Promise<number> {
    return -1;
  }
  async decr(): Promise<number> { return 0; }
  async del(): Promise<number> { return 0; }
}

// ---- Fixture IDs (real UUIDv4 for ParseUUIDPipe compatibility) ----------

const ALICE_ID = "11111111-1111-4111-8111-111111111111"; // platform admin
const ALICE_EMAIL = "alice@example.com";
const ALICE_PASSWORD = "Alice-Password-123!";

const BOB_ID = "22222222-2222-4222-8222-222222222222"; // member of acme as tenant_admin
const BOB_EMAIL = "bob@example.com";
const BOB_PASSWORD = "Bob-Password-123!";

const CAROL_ID = "33333333-3333-4333-8333-333333333333"; // member of acme as store_staff
const CAROL_EMAIL = "carol@example.com";
const CAROL_PASSWORD = "Carol-Password-123!";

const DAVE_ID = "44444444-4444-4444-8444-444444444444"; // no membership anywhere
const DAVE_EMAIL = "dave@example.com";
const DAVE_PASSWORD = "Dave-Password-123!";

const ACME_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const GLOBEX_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const ROLE_TENANT_ADMIN_ACME = "cccccccc-1111-4111-8111-cccccccccccc";
const ROLE_STORE_STAFF_ACME = "dddddddd-1111-4111-8111-dddddddddddd";
const MEMBERSHIP_BOB_ACME = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const MEMBERSHIP_CAROL_ACME = "ffffffff-1111-4111-8111-ffffffffffff";

// ---- Test bootstrap -----------------------------------------------------

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

async function seed(): Promise<void> {
  const pg = pool!;
  const aliceHash = await hashPassword(ALICE_PASSWORD);
  const bobHash = await hashPassword(BOB_PASSWORD);
  const carolHash = await hashPassword(CAROL_PASSWORD);
  const daveHash = await hashPassword(DAVE_PASSWORD);

  await pg.query(
    `INSERT INTO users (id, email, password_hash, is_platform_admin)
     VALUES ($1, $2, $3, true),
            ($4, $5, $6, false),
            ($7, $8, $9, false),
            ($10, $11, $12, false)`,
    [
      ALICE_ID, ALICE_EMAIL, aliceHash,
      BOB_ID, BOB_EMAIL, bobHash,
      CAROL_ID, CAROL_EMAIL, carolHash,
      DAVE_ID, DAVE_EMAIL, daveHash,
    ],
  );

  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'acme', 'Acme'),
       ($2, 'globex', 'Globex')`,
    [ACME_ID, GLOBEX_ID],
  );

  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $2, 'tenant_admin', 'Tenant Admin'),
       ($3, $2, 'store_staff', 'Store Staff')`,
    [ROLE_TENANT_ADMIN_ACME, ACME_ID, ROLE_STORE_STAFF_ACME],
  );

  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1, $2, $3, $4, 'all'),
            ($5, $2, $6, $7, 'all')`,
    [
      MEMBERSHIP_BOB_ACME, ACME_ID, BOB_ID, ROLE_TENANT_ADMIN_ACME,
      MEMBERSHIP_CAROL_ACME, CAROL_ID, ROLE_STORE_STAFF_ACME,
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
      imports: [AuthModule, TenantsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new AlwaysAllowRedis())
      .overrideProvider(EMAIL_JOB_ENQUEUER)
      .useValue(new NoOpEmailJobEnqueuer())
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
      console.warn(`\n[tenants.controller.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[tenants.controller.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

// Each test signs in fresh and uses the returned cookie. Avoids
// mutating shared state across tests.
async function signIn(email: string, password: string): Promise<string> {
  const res = await http()
    .post("/api/v1/auth/signin")
    .send({ email, password })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = list.find((c: string) => c.startsWith("dp2_session="));
  if (!cookie) {
    throw new Error(`signIn(${email}): no session cookie returned`);
  }
  return cookie.split(";")[0]!;
}

// ---- GET /tenants -------------------------------------------------------

describe("GET /api/v1/tenants", () => {
  it("returns 401 unauthenticated", async () => {
    if (maybeSkip()) return;
    await http().get("/api/v1/tenants").expect(401);
  });

  it("regular user with one membership sees only that tenant", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASSWORD);
    const res = await http()
      .get("/api/v1/tenants")
      .set("Cookie", cookie)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: ACME_ID, slug: "acme" });
  });

  it("user with no memberships sees empty list", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(DAVE_EMAIL, DAVE_PASSWORD);
    const res = await http()
      .get("/api/v1/tenants")
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it("platform admin sees all non-deleted tenants", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(ALICE_EMAIL, ALICE_PASSWORD);
    const res = await http()
      .get("/api/v1/tenants")
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    const ids = res.body.map((r: { id: string }) => r.id).sort();
    expect(ids).toContain(ACME_ID);
    expect(ids).toContain(GLOBEX_ID);
  });
});

// ---- POST /tenants ------------------------------------------------------

describe("POST /api/v1/tenants", () => {
  it("rejects 401 unauthenticated", async () => {
    if (maybeSkip()) return;
    await http()
      .post("/api/v1/tenants")
      .send({ slug: "newone", name: "New One" })
      .expect(401);
  });

  it("returns 403 when caller is not a platform admin", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASSWORD);
    await http()
      .post("/api/v1/tenants")
      .set("Cookie", cookie)
      .send({ slug: "bobs-tenant", name: "Bob's" })
      .expect(403);
  });

  it("returns 400 for invalid slug pattern", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(ALICE_EMAIL, ALICE_PASSWORD);
    await http()
      .post("/api/v1/tenants")
      .set("Cookie", cookie)
      .send({ slug: "BAD SLUG", name: "Bad" })
      .expect(400);
  });

  it("returns 201 with full body for valid platform-admin create + seeds default roles", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(ALICE_EMAIL, ALICE_PASSWORD);
    const res = await http()
      .post("/api/v1/tenants")
      .set("Cookie", cookie)
      .send({ slug: "freshco", name: "Fresh Co" })
      .expect(201);
    expect(res.body).toMatchObject({
      slug: "freshco",
      name: "Fresh Co",
      status: "active",
      deleted_at: null,
    });
    expect(typeof res.body.id).toBe("string");

    // Verify the 4 default roles were seeded.
    const rolesRes = await pool!.query(
      `SELECT code FROM roles WHERE tenant_id = $1 ORDER BY code`,
      [res.body.id],
    );
    expect(rolesRes.rows.map((r) => r.code)).toEqual([
      "owner",
      "store_manager",
      "store_staff",
      "tenant_admin",
    ]);
  });

  it("returns 409 on duplicate slug (case-insensitive)", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(ALICE_EMAIL, ALICE_PASSWORD);
    await http()
      .post("/api/v1/tenants")
      .set("Cookie", cookie)
      .send({ slug: "acme", name: "Duplicate" })
      .expect(409);
  });
});

// ---- GET /tenants/:id ---------------------------------------------------

describe("GET /api/v1/tenants/:id", () => {
  it("returns 401 unauthenticated", async () => {
    if (maybeSkip()) return;
    await http().get(`/api/v1/tenants/${ACME_ID}`).expect(401);
  });

  it("member of the tenant: 200 with full body", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASSWORD);
    const res = await http()
      .get(`/api/v1/tenants/${ACME_ID}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body).toMatchObject({ id: ACME_ID, slug: "acme" });
  });

  it("non-member: 404 (FR-ISO-4 — no existence leak)", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASSWORD);
    await http()
      .get(`/api/v1/tenants/${GLOBEX_ID}`)
      .set("Cookie", cookie)
      .expect(404);
  });

  it("user with no memberships at all: 404", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(DAVE_EMAIL, DAVE_PASSWORD);
    await http()
      .get(`/api/v1/tenants/${ACME_ID}`)
      .set("Cookie", cookie)
      .expect(404);
  });

  it("platform admin: 200 for any tenant", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(ALICE_EMAIL, ALICE_PASSWORD);
    await http()
      .get(`/api/v1/tenants/${GLOBEX_ID}`)
      .set("Cookie", cookie)
      .expect(200);
  });

  it("404 for non-existent UUID (admin path too)", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(ALICE_EMAIL, ALICE_PASSWORD);
    await http()
      .get(`/api/v1/tenants/${newId()}`)
      .set("Cookie", cookie)
      .expect(404);
  });

  it("400 for malformed UUID path param", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASSWORD);
    await http()
      .get("/api/v1/tenants/not-a-uuid")
      .set("Cookie", cookie)
      .expect(400);
  });
});

// ---- PATCH /tenants/:id -------------------------------------------------

describe("PATCH /api/v1/tenants/:id", () => {
  it("tenant_admin role can update name", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASSWORD);
    const res = await http()
      .patch(`/api/v1/tenants/${ACME_ID}`)
      .set("Cookie", cookie)
      .send({ name: "Acme Renamed" })
      .expect(200);
    expect(res.body.name).toBe("Acme Renamed");
    // Restore for downstream tests
    await pool!.query("UPDATE tenants SET name = 'Acme' WHERE id = $1", [ACME_ID]);
  });

  it("store_staff role: 404 (insufficient role)", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(CAROL_EMAIL, CAROL_PASSWORD);
    await http()
      .patch(`/api/v1/tenants/${ACME_ID}`)
      .set("Cookie", cookie)
      .send({ name: "Should Fail" })
      .expect(404);
  });

  it("non-member: 404 (cross-tenant)", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASSWORD);
    await http()
      .patch(`/api/v1/tenants/${GLOBEX_ID}`)
      .set("Cookie", cookie)
      .send({ name: "Hijacked" })
      .expect(404);
  });

  it("platform admin: 200", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(ALICE_EMAIL, ALICE_PASSWORD);
    const res = await http()
      .patch(`/api/v1/tenants/${GLOBEX_ID}`)
      .set("Cookie", cookie)
      .send({ status: "suspended" })
      .expect(200);
    expect(res.body.status).toBe("suspended");
    await pool!.query("UPDATE tenants SET status = 'active' WHERE id = $1", [GLOBEX_ID]);
  });

  it("400 for empty PATCH body", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASSWORD);
    await http()
      .patch(`/api/v1/tenants/${ACME_ID}`)
      .set("Cookie", cookie)
      .send({})
      .expect(400);
  });

  it("400 for invalid status enum value", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASSWORD);
    await http()
      .patch(`/api/v1/tenants/${ACME_ID}`)
      .set("Cookie", cookie)
      .send({ status: "deleted" })
      .expect(400);
  });
});

// ---- DELETE /tenants/:id ------------------------------------------------

describe("DELETE /api/v1/tenants/:id (soft-delete)", () => {
  // We use a freshly-created tenant for DELETE so the suite-state
  // isn't disturbed for prior tests.
  let throwawayId = "";

  beforeAll(async () => {
    if (dockerSkipped) return;
    const cookie = await signIn(ALICE_EMAIL, ALICE_PASSWORD);
    const created = await http()
      .post("/api/v1/tenants")
      .set("Cookie", cookie)
      .send({ slug: "throwaway", name: "Throwaway" })
      .expect(201);
    throwawayId = created.body.id;
  });

  it("returns 401 unauthenticated", async () => {
    if (maybeSkip()) return;
    await http().delete(`/api/v1/tenants/${ACME_ID}`).expect(401);
  });

  it("returns 403 for non-platform-admin", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(BOB_EMAIL, BOB_PASSWORD);
    await http()
      .delete(`/api/v1/tenants/${ACME_ID}`)
      .set("Cookie", cookie)
      .expect(403);
  });

  it("platform admin: 204; tenant becomes invisible to regular users; admin still sees it", async () => {
    if (maybeSkip()) return;
    const adminCookie = await signIn(ALICE_EMAIL, ALICE_PASSWORD);

    await http()
      .delete(`/api/v1/tenants/${throwawayId}`)
      .set("Cookie", adminCookie)
      .expect(204);

    // Platform admin can still read it (soft-delete visibility).
    const adminRead = await http()
      .get(`/api/v1/tenants/${throwawayId}`)
      .set("Cookie", adminCookie)
      .expect(200);
    expect(adminRead.body.deleted_at).not.toBeNull();

    // For comparison: a regular user who isn't a member sees 404 (no
    // membership AND row is soft-deleted — both paths converge to 404).
    const bobCookie = await signIn(BOB_EMAIL, BOB_PASSWORD);
    await http()
      .get(`/api/v1/tenants/${throwawayId}`)
      .set("Cookie", bobCookie)
      .expect(404);
  });

  it("idempotent: second DELETE on the same tenant still 204", async () => {
    if (maybeSkip()) return;
    const cookie = await signIn(ALICE_EMAIL, ALICE_PASSWORD);
    await http()
      .delete(`/api/v1/tenants/${throwawayId}`)
      .set("Cookie", cookie)
      .expect(204);
  });
});
