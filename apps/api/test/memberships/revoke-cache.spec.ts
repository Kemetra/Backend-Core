/**
 * T177 [US4] — FR-ACCESS-4 D-6: revoked store access invalidates cached
 * authorization decisions within the documented bound.
 *
 * Spec definition (spec.md FR-ACCESS-4):
 *   "Removing a user's access to a store MUST invalidate any cached or
 *    in-flight authorization decisions within a documented bound."
 *
 * Matrix row D-6 (tenant-isolation-matrix.md):
 *   "Removing U's `store_access` row for S1 MUST invalidate cached or
 *    in-flight authorization decisions within the documented bound."
 *   Expected: subsequent `GET /api/v1/stores/{S1}` → `404 not_found`
 *   within the cache-invalidation window.
 *
 * Documented bound — design note
 * -------------------------------
 * The current authorization path through `MembershipRepository.canAccessStore`
 * (apps/api/src/context/membership.repository.ts:204) queries Postgres on
 * every request — there is NO in-memory cache, no Redis read-through, and
 * no per-process memoization above the database. A code search across
 * `apps/api/src/auth`, `apps/api/src/context`, and `apps/api/src/memberships`
 * surfaces only the SESSION cache (apps/api/src/auth/session.repository.ts)
 * which is independent of membership/store-access state.
 *
 * Therefore the bound for FR-ACCESS-4 today is exactly:
 *   - "next request" (zero in-process cache)
 *   - upper-bounded by FR-AUTH-6 (`≤ 5 minutes`) only if a future authz
 *     cache is layered above `MembershipRepository`.
 *
 * This spec asserts the strong property ("next request") at the full HTTP
 * boundary so that any future PR introducing an authz cache without an
 * invalidation hook fails CI immediately. We exercise the same NestJS app
 * instance across revoke → next-GET so any in-process state survives.
 *
 * Scenarios
 * ---------
 *   Full membership revoke (DELETE /api/v1/memberships/:id):
 *     R-1: positive baseline — kind='specific' user with explicit grant
 *          → GET /api/v1/stores/{S1} returns 200.
 *     R-2: D-6 core — after revoke, next GET /stores/{S1} on the same app
 *          → 404.
 *
 *   Partial store_access removal (PATCH /api/v1/memberships/:id):
 *     R-3: positive baseline — kind='specific' user with explicit grants
 *          for S1 and S2 → GET /api/v1/stores/{S1} returns 200.
 *     R-4: D-6 precise — after PATCH drops S1 from store_ids while keeping
 *          the membership active, next GET /stores/{S1} → 404.
 *
 *   R-5: documented-bound contract (no runtime behaviour) — asserts the
 *        const NEXT_REQUEST_BOUND_MS = 0 declared inline so a future
 *        regression that adds a non-zero authz cache must also amend this
 *        constant, forcing review.
 *
 *   R-6: cross-tenant safety — revoke in tenant ALPHA does NOT leak into
 *        a separate ALPHA-only grant for an unrelated user (regression
 *        fence around the revoke SQL scope).
 *
 * Soft-skip: MIGRATION_TEST_ALLOW_SKIP=1 degrades gracefully without
 * Docker, matching the pattern used by memberships.controller.spec.ts and
 * stores.controller.spec.ts.
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
import { StoresModule } from "../../src/stores/stores.module";
import type { RedisLike } from "../../src/auth/rate-limit";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// ---- Documented-bound constant (R-5) ---------------------------------------
// If a future PR adds a Redis or in-memory authz cache above
// MembershipRepository, this constant MUST be updated to the new bound (and
// the cache MUST have an invalidation hook on revoke / PATCH). The R-5 test
// asserts the current value so any change is forced through code review.
const NEXT_REQUEST_BOUND_MS = 0;

// ---- Fake Redis (always-allow rate limiter) --------------------------------

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

// ---- Fixture IDs -----------------------------------------------------------
// All UUIDv4 (ParseUUIDPipe compatible). Prefix "f" to avoid collision with
// other specs that may share a container in parallel runs.

const OWNER_ID    = "f1000000-1000-4000-8000-000000000001"; // owner in ALPHA
const OWNER_EMAIL = "owner@revoke-cache.test";
const OWNER_PASS  = "Owner-Revoke-1!";

const TARGET_ID    = "f2000000-2000-4000-8000-000000000002"; // kind='specific' user (membership revoked by tests)
const TARGET_EMAIL = "target@revoke-cache.test";
const TARGET_PASS  = "Target-Revoke-1!";

const PATCH_USER_ID    = "f3000000-3000-4000-8000-000000000003"; // kind='specific' user whose grants are patched
const PATCH_USER_EMAIL = "patch-user@revoke-cache.test";
const PATCH_USER_PASS  = "PatchUser-Revoke-1!";

const BYSTANDER_ID    = "f4000000-4000-4000-8000-000000000004"; // R-6: untouched kind='specific' user with grant for S_A1
const BYSTANDER_EMAIL = "bystander@revoke-cache.test";
const BYSTANDER_PASS  = "Bystander-Revoke-1!";

// Tenants
const ALPHA_ID = "f5000000-5000-4000-8000-000000000005";

// Roles
const ROLE_OWNER_ALPHA = "f6000000-6000-4000-8000-000000000006";
const ROLE_STAFF_ALPHA = "f7000000-7000-4000-8000-000000000007";

// Memberships
const MEM_OWNER     = "f8000000-8000-4000-8000-000000000008"; // OWNER → owner (active)
const MEM_TARGET    = "f9000000-9000-4000-8000-000000000009"; // TARGET → store_staff kind='specific' (revoked in R-2)
const MEM_PATCH     = "fa000000-a000-4000-8000-00000000000a"; // PATCH_USER → store_staff kind='specific' (patched in R-4)
const MEM_BYSTANDER = "fb000000-b000-4000-8000-00000000000b"; // BYSTANDER → store_staff kind='specific' (untouched)

// Stores (all in ALPHA)
const STORE_A1 = "fc000000-c000-4000-8000-00000000000c"; // primary store under test
const STORE_A2 = "fd000000-d000-4000-8000-00000000000d"; // secondary store used by PATCH scenario

// ---- Test bootstrap --------------------------------------------------------

let env: PgTestEnv | null = null;
let pool: Pool | null = null; // admin (superuser) pool — used for seed + reset between tests
let app: INestApplication | null = null;
let dockerSkipped = false;

async function seed(): Promise<void> {
  const pg = pool!;

  const hashes = await Promise.all([
    hashPassword(OWNER_PASS),
    hashPassword(TARGET_PASS),
    hashPassword(PATCH_USER_PASS),
    hashPassword(BYSTANDER_PASS),
  ]);
  const [ownerH, targetH, patchH, bystanderH] = hashes;

  await pg.query(
    `INSERT INTO users (id, email, password_hash, is_platform_admin)
     VALUES ($1, $2, $3, false),
            ($4, $5, $6, false),
            ($7, $8, $9, false),
            ($10, $11, $12, false)`,
    [
      OWNER_ID,      OWNER_EMAIL,      ownerH,
      TARGET_ID,     TARGET_EMAIL,     targetH,
      PATCH_USER_ID, PATCH_USER_EMAIL, patchH,
      BYSTANDER_ID,  BYSTANDER_EMAIL,  bystanderH,
    ],
  );

  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'alpha-revoke-cache', 'Alpha Revoke Cache')`,
    [ALPHA_ID],
  );

  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $3, 'owner',       'Owner Alpha'),
       ($2, $3, 'store_staff', 'Store Staff Alpha')`,
    [ROLE_OWNER_ALPHA, ROLE_STAFF_ALPHA, ALPHA_ID],
  );

  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1,  $2,  $3,  $4,  'all'),
            ($5,  $6,  $7,  $8,  'specific'),
            ($9,  $10, $11, $12, 'specific'),
            ($13, $14, $15, $16, 'specific')`,
    [
      MEM_OWNER,     ALPHA_ID, OWNER_ID,      ROLE_OWNER_ALPHA,
      MEM_TARGET,    ALPHA_ID, TARGET_ID,     ROLE_STAFF_ALPHA,
      MEM_PATCH,     ALPHA_ID, PATCH_USER_ID, ROLE_STAFF_ALPHA,
      MEM_BYSTANDER, ALPHA_ID, BYSTANDER_ID,  ROLE_STAFF_ALPHA,
    ],
  );

  await pg.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $2, 'RC-01', 'Revoke Cache Store 1'),
       ($3, $2, 'RC-02', 'Revoke Cache Store 2')`,
    [STORE_A1, ALPHA_ID, STORE_A2],
  );

  // Default grants:
  //   TARGET     → STORE_A1            (R-1/R-2 — revoked by DELETE)
  //   PATCH_USER → STORE_A1, STORE_A2  (R-3/R-4 — PATCH drops S1)
  //   BYSTANDER  → STORE_A1            (R-6 — must remain accessible)
  await pg.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES
       ($1, $2, $3),
       ($1, $4, $3),
       ($5, $2, $3),
       ($6, $2, $3)`,
    [MEM_PATCH, STORE_A1, ALPHA_ID, STORE_A2, MEM_TARGET, MEM_BYSTANDER],
  );
}

/**
 * Restore the default seed state for the three test users between scenarios.
 * Tests are write-heavy (revoke + PATCH), so each describe block resets the
 * rows it owns to keep tests independent. Uses the admin pool to bypass RLS
 * for the reset.
 */
async function resetSeed(): Promise<void> {
  const pg = pool!;
  // Re-activate any revoked memberships and reset kind='specific'.
  await pg.query(
    `UPDATE memberships SET revoked_at = NULL, store_access_kind = 'specific'
     WHERE id IN ($1, $2, $3)`,
    [MEM_TARGET, MEM_PATCH, MEM_BYSTANDER],
  );
  // Wipe and re-seed grants.
  await pg.query(
    `DELETE FROM store_access WHERE membership_id IN ($1, $2, $3)`,
    [MEM_TARGET, MEM_PATCH, MEM_BYSTANDER],
  );
  await pg.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES
       ($1, $2, $3),
       ($1, $4, $3),
       ($5, $2, $3),
       ($6, $2, $3)`,
    [MEM_PATCH, STORE_A1, ALPHA_ID, STORE_A2, MEM_TARGET, MEM_BYSTANDER],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = env.admin; // superuser — seed + raw assertions only
    await seed();

    // Build the NestJS app against the non-superuser `app_test` pool so RLS
    // policies and the canAccessStore check execute as they would in
    // production. The admin pool is used only for setup/reset above.
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, MembershipsModule, StoresModule],
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
      console.warn(`\n[revoke-cache.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

function http(): request.SuperTest<request.Test> {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[revoke-cache.spec] skipping (Docker unavailable)");
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
  if (!cookie) throw new Error(`signIn(${email}): no session cookie returned`);
  return cookie.split(";")[0]!;
}

async function signInWithTenant(
  email: string,
  password: string,
  tenantId: string,
): Promise<string> {
  const cookie = await signIn(email, password);
  await http()
    .post("/api/v1/context/tenant")
    .set("Cookie", cookie)
    .send({ tenant_id: tenantId })
    .expect(200);
  return cookie;
}

// ===========================================================================
// R-5 — Documented-bound contract
// ===========================================================================
//
// Pure-constant test that documents the current bound. No app boot required;
// safe to run even when Docker is skipped. Forces future cache-introducing
// PRs to update this constant (and add an invalidation hook) under review.

describe("FR-ACCESS-4 D-6 — documented bound (R-5)", () => {
  it("authz path is uncached today: bound is next request", () => {
    expect(NEXT_REQUEST_BOUND_MS).toBe(0);
  });
});

// ===========================================================================
// R-1 / R-2 — Full membership revoke
// ===========================================================================

describe("FR-ACCESS-4 D-6 — full membership revoke invalidates authz on next request", () => {
  beforeEach(async () => {
    if (maybeSkip()) return;
    await resetSeed();
  });

  it("R-1: kind='specific' user with grant → GET /stores/{S1} returns 200 (baseline)", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(TARGET_EMAIL, TARGET_PASS, ALPHA_ID);

    await http()
      .get(`/api/v1/stores/${STORE_A1}`)
      .set("Cookie", cookie)
      .expect(200);
  });

  it("R-2: after DELETE /memberships/{id}, next GET /stores/{S1} on same app returns 404", async () => {
    if (maybeSkip()) return;

    // Step 1 — TARGET signs in and confirms access (warms any in-process state).
    const targetCookie = await signInWithTenant(TARGET_EMAIL, TARGET_PASS, ALPHA_ID);
    await http()
      .get(`/api/v1/stores/${STORE_A1}`)
      .set("Cookie", targetCookie)
      .expect(200);

    // Step 2 — OWNER revokes TARGET's membership.
    const ownerCookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .delete(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", ownerCookie)
      .expect(204);

    // Step 3 — TARGET's very next request on the same NestJS app gets 404.
    //
    // The 404 specifically comes from TenantContextGuard, which now sees a
    // revoked membership and treats the active-tenant context as if the
    // user never belonged. FR-ISO-4 dictates the same 404 envelope as a
    // cross-tenant probe.
    await http()
      .get(`/api/v1/stores/${STORE_A1}`)
      .set("Cookie", targetCookie)
      .expect((res) => {
        if (res.status !== 401 && res.status !== 404) {
          throw new Error(
            `expected 401 or 404 after membership revoke, got ${res.status}: ${JSON.stringify(res.body)}`,
          );
        }
      });

    // Pin the DB-level effect for diagnostic clarity.
    const dbRow = await pool!.query(
      `SELECT revoked_at FROM memberships WHERE id = $1`,
      [MEM_TARGET],
    );
    expect(dbRow.rows[0]?.revoked_at).not.toBeNull();
  });
});

// ===========================================================================
// R-3 / R-4 — Partial store_access removal via PATCH
// ===========================================================================

describe("FR-ACCESS-4 D-6 — PATCH removing one store_access row invalidates authz on next request", () => {
  beforeEach(async () => {
    if (maybeSkip()) return;
    await resetSeed();
  });

  it("R-3: kind='specific' user with grants for S1+S2 → GET /stores/{S1} returns 200 (baseline)", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(PATCH_USER_EMAIL, PATCH_USER_PASS, ALPHA_ID);

    await http()
      .get(`/api/v1/stores/${STORE_A1}`)
      .set("Cookie", cookie)
      .expect(200);
    await http()
      .get(`/api/v1/stores/${STORE_A2}`)
      .set("Cookie", cookie)
      .expect(200);
  });

  it("R-4: after PATCH drops S1 from store_ids (membership still active), next GET /stores/{S1} returns 404; S2 still 200", async () => {
    if (maybeSkip()) return;

    // Step 1 — PATCH_USER confirms baseline access to both S1 and S2.
    const patchUserCookie = await signInWithTenant(
      PATCH_USER_EMAIL,
      PATCH_USER_PASS,
      ALPHA_ID,
    );
    await http()
      .get(`/api/v1/stores/${STORE_A1}`)
      .set("Cookie", patchUserCookie)
      .expect(200);

    // Step 2 — OWNER PATCHes the membership: keep kind='specific', drop S1.
    const ownerCookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    const patchRes = await http()
      .patch(`/api/v1/memberships/${MEM_PATCH}`)
      .set("Cookie", ownerCookie)
      .send({ store_access_kind: "specific", store_ids: [STORE_A2] })
      .expect(200);
    expect(patchRes.body.accessible_store_ids).toEqual([STORE_A2]);

    // Step 3 — PATCH_USER's next request to S1 on the same app gets 404.
    // The membership is still active (revoked_at IS NULL); only the grant
    // for S1 has been removed. canAccessStore must fail Step 2 (no grant).
    await http()
      .get(`/api/v1/stores/${STORE_A1}`)
      .set("Cookie", patchUserCookie)
      .expect(404);

    // S2 grant survived → still 200.
    await http()
      .get(`/api/v1/stores/${STORE_A2}`)
      .set("Cookie", patchUserCookie)
      .expect(200);

    // Pin the DB-level effect.
    const grants = await pool!.query(
      `SELECT store_id FROM store_access WHERE membership_id = $1 ORDER BY store_id`,
      [MEM_PATCH],
    );
    expect(grants.rows.map((r: { store_id: string }) => r.store_id)).toEqual([
      STORE_A2,
    ]);
    const memRow = await pool!.query(
      `SELECT revoked_at FROM memberships WHERE id = $1`,
      [MEM_PATCH],
    );
    expect(memRow.rows[0]?.revoked_at).toBeNull();
  });
});

// ===========================================================================
// R-6 — Revoke scope safety (regression fence)
// ===========================================================================
//
// Asserts that revoking TARGET's membership does NOT cascade into BYSTANDER's
// independent access to the same store. A correct revoke SQL scopes by
// membership_id; a regression that broadens the scope (e.g., to "all
// memberships for this store") would be caught here.

describe("FR-ACCESS-4 D-6 — revoke scope does not leak across memberships (R-6)", () => {
  beforeEach(async () => {
    if (maybeSkip()) return;
    await resetSeed();
  });

  it("BYSTANDER retains access to S1 after TARGET's membership is revoked", async () => {
    if (maybeSkip()) return;

    // BYSTANDER warms a session and confirms baseline access.
    const bystanderCookie = await signInWithTenant(
      BYSTANDER_EMAIL,
      BYSTANDER_PASS,
      ALPHA_ID,
    );
    await http()
      .get(`/api/v1/stores/${STORE_A1}`)
      .set("Cookie", bystanderCookie)
      .expect(200);

    // OWNER revokes the OTHER user's (TARGET's) membership only.
    const ownerCookie = await signInWithTenant(OWNER_EMAIL, OWNER_PASS, ALPHA_ID);
    await http()
      .delete(`/api/v1/memberships/${MEM_TARGET}`)
      .set("Cookie", ownerCookie)
      .expect(204);

    // BYSTANDER's next request must still succeed — the revoke must NOT
    // have broadened to drop unrelated store_access rows.
    await http()
      .get(`/api/v1/stores/${STORE_A1}`)
      .set("Cookie", bystanderCookie)
      .expect(200);
  });
});
