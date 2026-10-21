/**
 * PosShiftsController — integration spec (Wave 4.1b).
 *
 * Real Postgres via Testcontainers (all migrations applied). The Clerk
 * verifier is overridden with a deterministic stub. The stuck-shift
 * threshold is set to 0 minutes so tests do not need to sleep.
 *
 * Coverage:
 *   - 200 happy path: manager with an open stuck shift sees it returned;
 *     a shift with an active pos_operator session is NOT returned.
 *   - 200 empty: no stuck shifts when all open shifts have active sessions.
 *   - 401 when Authorization header is absent.
 *   - 401 when Authorization header is not Bearer form.
 *   - 401 when JWT verifier throws (unknown token — verifier error path).
 *   - 401 when JWT subject resolves but no matching users row exists (user-lookup path).
 *   - 401 when user has store_staff role (ineligible).
 *   - 401 when specific-access member requests a branch they lack access to.
 *   - 400 when branch_id query param is missing.
 *   - 400 when branch_id is not a UUID.
 *   - Response shape: no internal IDs (users.id, devices.id, Clerk subjects).
 *   - 200 allowed for owner role (positive authorization coverage).
 *   - 200 allowed for tenant_admin role (positive authorization coverage).
 */
import { linkClerkUsers } from "../_helpers/identity-links";
import "reflect-metadata";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import cookieParser from "cookie-parser";
import { Pool } from "pg";
import request from "supertest";

import {
  OPERATOR_TOKEN_VERIFIER,
  type OperatorTokenVerifier,
} from "../../src/auth/operator-token-verifier";
import { PosShiftsModule } from "../../src/pos-shifts/pos-shifts.module";
import { PosShiftsService } from "../../src/pos-shifts/pos-shifts.service";
import { PG_POOL } from "../../src/auth/auth.module";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { LoggingInterceptor, ROOT_LOGGER } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// -----------------------------------------------------------------------
// Fixture identifiers — UUIDv4-shape with distinct prefixes per entity.
// -----------------------------------------------------------------------

const TENANT_ID         = "0c000000-0000-4000-8000-000000000001";
const STORE_ID          = "0c000000-0000-4000-8000-00000000aa01";
const STORE_ID_B        = "0c000000-0000-4000-8000-00000000aa02";

const MANAGER_ROLE_ID      = "0c000000-0000-4000-8000-00000000bb01";
const STAFF_ROLE_ID        = "0c000000-0000-4000-8000-00000000bb02";
const OWNER_ROLE_ID        = "0c000000-0000-4000-8000-00000000bb03";
const TENANT_ADMIN_ROLE_ID = "0c000000-0000-4000-8000-00000000bb04";

const MANAGER_USER_ID      = "0c000000-0000-4000-8000-00000000cc01";
const MANAGER_CLERK_SUB    = "user_clerk_mgr_shifts";
const STAFF_USER_ID        = "0c000000-0000-4000-8000-00000000cc02";
const STAFF_CLERK_SUB      = "user_clerk_staff_shifts";
const CASHIER_USER_ID      = "0c000000-0000-4000-8000-00000000cc03";
const SPECIFIC_USER_ID     = "0c000000-0000-4000-8000-00000000cc04";
const SPECIFIC_CLERK_SUB   = "user_clerk_specific_shifts";
// Orphan: Clerk sub exists in the verifier map but has NO matching users row.
const ORPHAN_CLERK_SUB     = "user_clerk_orphan_no_row";
// Owner and tenant_admin positive-authz fixtures.
const OWNER_USER_ID        = "0c000000-0000-4000-8000-00000000cc05";
const OWNER_CLERK_SUB      = "user_clerk_owner_shifts";
const TADMIN_USER_ID       = "0c000000-0000-4000-8000-00000000cc06";
const TADMIN_CLERK_SUB     = "user_clerk_tadmin_shifts";

const MANAGER_MEMBERSHIP_ID  = "0c000000-0000-4000-8000-00000000dd01";
const STAFF_MEMBERSHIP_ID    = "0c000000-0000-4000-8000-00000000dd02";
const SPECIFIC_MEMBERSHIP_ID = "0c000000-0000-4000-8000-00000000dd03";
const OWNER_MEMBERSHIP_ID    = "0c000000-0000-4000-8000-00000000dd04";
const TADMIN_MEMBERSHIP_ID   = "0c000000-0000-4000-8000-00000000dd05";

const DEVICE_ID         = "0c000000-0000-4000-8000-00000000ee01";
const DEVICE_ATTESTATION = "device-att-shifts-spec";

// Shift IDs
const STUCK_SHIFT_ID    = "0c000000-0000-4000-8000-00000000ff01";
const ACTIVE_SHIFT_ID   = "0c000000-0000-4000-8000-00000000ff02";

class StubClerkVerifier implements OperatorTokenVerifier {
  constructor(private readonly map: Map<string, string>) {}
  async verify(rawJwt: string): Promise<{ providerKey: string; sub: string }> {
    const sub = this.map.get(rawJwt);
    if (!sub) throw new Error("StubClerkVerifier: unknown jwt");
    return { providerKey: "clerk", sub };
  }
}

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[pos-shifts.controller.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
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

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });

    // ---- tenant, stores ----
    await pool.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'shifts-spec-tenant', 'Shifts Spec Tenant')`,
      [TENANT_ID],
    );
    await pool.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $2, 'SFA', 'Store A'),
         ($3, $2, 'SFB', 'Store B')`,
      [STORE_ID, TENANT_ID, STORE_ID_B],
    );

    // ---- roles ----
    await pool.query(
      `INSERT INTO roles (id, tenant_id, code, name) VALUES
         ($1, $2, 'store_manager', 'Manager'),
         ($3, $2, 'store_staff',   'Staff'),
         ($4, $2, 'owner',         'Owner'),
         ($5, $2, 'tenant_admin',  'Tenant Admin')`,
      [MANAGER_ROLE_ID, TENANT_ID, STAFF_ROLE_ID, OWNER_ROLE_ID, TENANT_ADMIN_ROLE_ID],
    );

    // ---- users ----
    // NOTE: No users row for ORPHAN_CLERK_SUB — that is intentional; it tests the
    // service path where Clerk verify() succeeds but the DB lookup returns no match.
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
         ($1, 'manager@shifts.example',  'Shift Manager',  $2),
         ($3, 'staff@shifts.example',    'Shift Staff',    $4),
         ($5, 'cashier@shifts.example',  'Jane Cashier',   NULL),
         ($6, 'specific@shifts.example', 'Specific Mgr',   $7),
         ($8, 'owner@shifts.example',    'Store Owner',    $9),
         ($10,'tadmin@shifts.example',   'Tenant Admin',   $11)`,
      [
        MANAGER_USER_ID, MANAGER_CLERK_SUB,
        STAFF_USER_ID,   STAFF_CLERK_SUB,
        CASHIER_USER_ID,
        SPECIFIC_USER_ID, SPECIFIC_CLERK_SUB,
        OWNER_USER_ID,    OWNER_CLERK_SUB,
        TADMIN_USER_ID,   TADMIN_CLERK_SUB,
      ],
    );
    await linkClerkUsers(pool);
    // Give the cashier a clerk_user_id so shift display_name is not null
    await pool.query(
      `UPDATE users SET clerk_user_id = 'user_clerk_cashier_shifts' WHERE id = $1`,
      [CASHIER_USER_ID],
    );
    await linkClerkUsers(pool);

    // ---- memberships ----
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
         ($1, $2, $3, $4,  'all'),
         ($5, $2, $6, $7,  'all'),
         ($8, $2, $9, $4,  'specific'),
         ($10,$2, $11,$12, 'all'),
         ($13,$2, $14,$15, 'all')`,
      [
        MANAGER_MEMBERSHIP_ID, TENANT_ID, MANAGER_USER_ID, MANAGER_ROLE_ID,
        STAFF_MEMBERSHIP_ID,             STAFF_USER_ID,   STAFF_ROLE_ID,
        SPECIFIC_MEMBERSHIP_ID,          SPECIFIC_USER_ID,
        OWNER_MEMBERSHIP_ID,             OWNER_USER_ID,   OWNER_ROLE_ID,
        TADMIN_MEMBERSHIP_ID,            TADMIN_USER_ID,  TENANT_ADMIN_ROLE_ID,
      ],
    );
    // specific user gets access to STORE_ID_B only
    await pool.query(
      `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`,
      [SPECIFIC_MEMBERSHIP_ID, STORE_ID_B, TENANT_ID],
    );

    // ---- device ----
    const deviceHash = hashToken(DEVICE_ATTESTATION);
    await pool.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'till-F', $4)`,
      [DEVICE_ID, TENANT_ID, STORE_ID, deviceHash],
    );

    // ---- shifts ----
    // STUCK_SHIFT: open, opened 1 hour ago, cashier has NO active session
    await pool.query(
      `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
         VALUES ($1, $2, $3, $4, $5, now() - INTERVAL '1 hour')`,
      [STUCK_SHIFT_ID, TENANT_ID, STORE_ID, CASHIER_USER_ID, DEVICE_ID],
    );
    // ACTIVE_SHIFT: open, opened 1 hour ago, BUT cashier HAS an active pos_operator session
    await pool.query(
      `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
         VALUES ($1, $2, $3, $4, $5, now() - INTERVAL '1 hour')`,
      [ACTIVE_SHIFT_ID, TENANT_ID, STORE_ID, MANAGER_USER_ID, DEVICE_ID],
    );
    // Insert active pos_operator token for MANAGER_USER_ID on STORE_ID.
    // tenant_id is required so the row is visible under auth_tokens RLS when
    // the stuck-shift query runs inside runWithTenantContext.
    const activeTokenHash = hashToken("active-session-token-shifts-spec");
    await pool.query(
      `INSERT INTO auth_tokens (id, tenant_id, user_id, device_id, store_id, scope, token_hash, expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'pos_operator', $5, now() + INTERVAL '8 hours')`,
      [TENANT_ID, MANAGER_USER_ID, DEVICE_ID, STORE_ID, activeTokenHash],
    );

    // ---- Nest app ----
    const verifierMap = new Map<string, string>([
      ["jwt-manager",  MANAGER_CLERK_SUB],
      ["jwt-staff",    STAFF_CLERK_SUB],
      ["jwt-specific", SPECIFIC_CLERK_SUB],
      // jwt-orphan: verifier maps to a sub that has NO matching users row.
      // This exercises service.ts line where userRow.rows[0] is undefined.
      ["jwt-orphan",   ORPHAN_CLERK_SUB],
      ["jwt-owner",    OWNER_CLERK_SUB],
      ["jwt-tadmin",   TADMIN_CLERK_SUB],
    ]);

    const moduleRef = await Test.createTestingModule({
      imports: [PosShiftsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(OPERATOR_TOKEN_VERIFIER)
      .useValue(new StubClerkVerifier(verifierMap))
      // Override service to use threshold=0 so all open shifts qualify
      .overrideProvider(PosShiftsService)
      .useValue(
        new PosShiftsService(
          pool,
          new StubClerkVerifier(verifierMap),
          createLogger({ service: "api-test", level: "silent" }),
          0, // threshold = 0 minutes — every open shift is "stuck"
        ),
      )
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
      console.warn(`\n[pos-shifts.controller.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
    } else {
      throw err;
    }
  }
}, 90_000);
// ^ The Jest default of 30s is too tight for this hook on the busier
// self-hosted CI runner: the Testcontainers Postgres boot
// (`startPgEnv` -> `applyAllUpAndCreateAppRole`) plus ~160 lines of
// seed inserts has tipped over 30s during contention windows, while
// completing in ~15s on developer hardware. 90s matches the
// convention used by other heavy Testcontainers-backed specs in the
// repo (e.g. `packages/db/__tests__/outbox/retention.spec.ts` uses
// 180_000 for the same shape of work). Bumping only the `beforeAll`
// timeout -- the per-test timeouts inside this suite are unchanged,
// so a hung individual test still fails fast.

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe("GET /api/pos/v1/shifts/stuck", () => {
  it("returns 401 when Authorization header is absent", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${STORE_ID}`)
      .expect(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it.each([
    ["Authorization is not Bearer form", "Basic dXNlcjpwYXNz"],
    // Token not in the stub map → StubClerkVerifier throws → service try/catch path.
    ["JWT is not recognized by the verifier (verifier throws)", "Bearer jwt-unknown-not-in-map"],
    // jwt-orphan is accepted by the verifier (sub = ORPHAN_CLERK_SUB) but
    // no users row with that clerk_user_id was inserted — exercises the
    // service path at userRow.rows[0] being undefined.
    ["JWT subject resolves to no local user (user-lookup miss)", "Bearer jwt-orphan"],
    ["user is store_staff (ineligible role)", "Bearer jwt-staff"],
    // SPECIFIC_USER has access to STORE_ID_B only, not STORE_ID
    ["specific-access manager requests a branch they lack access to", "Bearer jwt-specific"],
  ])("returns 401 when %s", async (_label, authorization) => {
    if (maybeSkip()) return;
    const res = await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${STORE_ID}`)
      .set("Authorization", authorization)
      .expect(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 when branch_id query param is missing", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get("/api/pos/v1/shifts/stuck")
      .set("Authorization", "Bearer jwt-manager")
      .expect(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  it("returns 400 when branch_id is not a valid UUID", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get("/api/pos/v1/shifts/stuck?branch_id=not-a-uuid")
      .set("Authorization", "Bearer jwt-manager")
      .expect(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  it("returns 200 with only the stuck shift (not the shift with active session)", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${STORE_ID}`)
      .set("Authorization", "Bearer jwt-manager")
      .expect(200);

    expect(res.body).toMatchObject({ kind: "ok" });
    const shifts: unknown[] = res.body.shifts;
    expect(Array.isArray(shifts)).toBe(true);

    const shiftIds = shifts.map((s: unknown) => (s as { shift_id: string }).shift_id);
    expect(shiftIds).toContain(STUCK_SHIFT_ID);
    expect(shiftIds).not.toContain(ACTIVE_SHIFT_ID);
  });

  it("response shape contains required fields and no internal IDs", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${STORE_ID}`)
      .set("Authorization", "Bearer jwt-manager")
      .expect(200);

    const shifts: unknown[] = res.body.shifts;
    expect(shifts.length).toBeGreaterThanOrEqual(1);

    const stuckShift = shifts.find(
      (s: unknown) => (s as { shift_id: string }).shift_id === STUCK_SHIFT_ID,
    ) as Record<string, unknown>;
    expect(stuckShift).toBeDefined();

    expect(stuckShift).toHaveProperty("shift_id");
    expect(stuckShift).toHaveProperty("cashier_display_name");
    expect(stuckShift).toHaveProperty("terminal_label");
    expect(stuckShift).toHaveProperty("opened_at");
    expect(stuckShift).toHaveProperty("duration_minutes");
    expect(typeof stuckShift["duration_minutes"]).toBe("number");
    expect(stuckShift["duration_minutes"]).toBeGreaterThanOrEqual(0);

    // No internal IDs
    expect(stuckShift).not.toHaveProperty("opening_cashier_user_id");
    expect(stuckShift).not.toHaveProperty("opening_device_id");
    expect(stuckShift).not.toHaveProperty("tenant_id");
    expect(stuckShift).not.toHaveProperty("store_id");

    // cashier_display_name is a human name, not a UUID or email
    const name = stuckShift["cashier_display_name"] as string;
    expect(typeof name).toBe("string");
    expect(name).not.toMatch(/^[0-9a-f-]{36}$/i);
    expect(name).not.toContain("@");
  });

  it("returns 200 with empty shifts array when no open shifts exist on a different store", async () => {
    if (maybeSkip()) return;
    // STORE_ID_B has no shifts seeded
    // But specific user only has access to STORE_ID_B; use manager (has 'all' access)
    // We need to seed manager membership for STORE_ID_B tenant first — but manager
    // already has 'all' store_access_kind so they can query STORE_ID_B.
    const res = await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${STORE_ID_B}`)
      .set("Authorization", "Bearer jwt-manager")
      .expect(200);

    expect(res.body).toMatchObject({ kind: "ok", shifts: [] });
  });

  it.each([
    // SPECIFIC_USER has access to STORE_ID_B; no shifts there → empty is fine
    ["specific-access manager sees stuck shifts on their allowed branch", "Bearer jwt-specific", expect.any(Array)],
    // STORE_ID_B has no shifts seeded → expect empty ok response. These confirm
    // the role code is in ELIGIBLE_INTERNAL_ROLES and the request is not
    // refused for role reasons.
    ["owner role is allowed (positive authorization coverage)", "Bearer jwt-owner", []],
    ["tenant_admin role is allowed (positive authorization coverage)", "Bearer jwt-tadmin", []],
  ])("%s", async (_label, authorization, expectedShifts) => {
    if (maybeSkip()) return;
    const res = await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${STORE_ID_B}`)
      .set("Authorization", authorization)
      .expect(200);

    expect(res.body).toMatchObject({ kind: "ok", shifts: expectedShifts });
  });
});
