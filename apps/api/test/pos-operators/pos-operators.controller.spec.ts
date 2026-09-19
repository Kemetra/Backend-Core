/**
 * PosOperatorsController — integration spec.
 *
 * Real Postgres via Testcontainers (with both 0000 and 0001 migrations
 * applied). The Clerk verifier is overridden with a deterministic fake
 * (raw JWT string → Clerk subject) so no test traffic reaches Clerk's
 * JWKS endpoint.
 *
 * Coverage:
 *   - Happy paths: tenant_admin / store_manager sign in successfully;
 *     `operator.id` is the Clerk subject, `branch_id` is the device's
 *     `store_id`, and a row is written to `auth_tokens`
 *     (`scope = 'pos_operator'`).
 *   - Refusal taxonomy → uniform 401 envelope: missing Authorization,
 *     malformed bearer, unmapped Clerk subject, soft-deleted user,
 *     unknown / revoked device, role_ineligible (store_staff),
 *     specific-access without grant, takeover_required (returned as 200
 *     with `{ kind: "takeover_required" }`).
 *   - Body shape rejection (Zod): `branch_id`, `password`, `pin`,
 *     `cashier`, `clerk_session_token`, `identifier` in the body all
 *     produce 400 (validation_error) — they are forbidden additional
 *     properties.
 *   - Response does not contain `clerk_session_token` or any internal
 *     bearer token material.
 */
import "reflect-metadata";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import cookieParser from "cookie-parser";
import { Pool } from "pg";
import request from "supertest";

import {
  CLERK_VERIFIER,
  type ClerkVerifier,
} from "../../src/pos-operators/clerk-verifier";
import { PosOperatorsModule } from "../../src/pos-operators/pos-operators.module";
import { AUTH_LOOKUP_POOL, PG_POOL } from "../../src/auth/auth.module";
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
// Fixture identifiers — UUIDv4-shape strings, distinct prefix per object.
// -----------------------------------------------------------------------

const TENANT_ID = "0b000000-0000-4000-8000-000000000001";
const STORE_ID_A = "0b000000-0000-4000-8000-00000000aa01";
const STORE_ID_B = "0b000000-0000-4000-8000-00000000aa02";

const ADMIN_ROLE_ID = "0b000000-0000-4000-8000-00000000bb01";
const MANAGER_ROLE_ID = "0b000000-0000-4000-8000-00000000bb02";
const STAFF_ROLE_ID = "0b000000-0000-4000-8000-00000000bb03";

const ADMIN_USER_ID = "0b000000-0000-4000-8000-00000000cc01";
const ADMIN_CLERK_SUB = "user_clerk_admin_pr5";
const MANAGER_USER_ID = "0b000000-0000-4000-8000-00000000cc02";
const MANAGER_CLERK_SUB = "user_clerk_mgr_pr5";
const STAFF_USER_ID = "0b000000-0000-4000-8000-00000000cc03";
const STAFF_CLERK_SUB = "user_clerk_staff_pr5";
const SPECIFIC_USER_ID = "0b000000-0000-4000-8000-00000000cc04";
const SPECIFIC_CLERK_SUB = "user_clerk_specific_pr5";
const DELETED_USER_ID = "0b000000-0000-4000-8000-00000000cc05";
const DELETED_CLERK_SUB = "user_clerk_deleted_pr5";

const ADMIN_MEMBERSHIP_ID = "0b000000-0000-4000-8000-00000000dd01";
const MANAGER_MEMBERSHIP_ID = "0b000000-0000-4000-8000-00000000dd02";
const STAFF_MEMBERSHIP_ID = "0b000000-0000-4000-8000-00000000dd03";
const SPECIFIC_MEMBERSHIP_ID = "0b000000-0000-4000-8000-00000000dd04";
const DELETED_MEMBERSHIP_ID = "0b000000-0000-4000-8000-00000000dd05";

// Roster negative-test fixtures
const TENANT_ID_B = "0b000000-0000-4000-8000-000000000002";
const TENANT_B_ROLE_ID = "0b000000-0000-4000-8000-00000000bb04";
const TENANT_B_USER_ID = "0b000000-0000-4000-8000-00000000cc06";
const TENANT_B_CLERK_SUB = "user_clerk_tenant_b_roster";
const TENANT_B_MEMBERSHIP_ID = "0b000000-0000-4000-8000-00000000dd06";
const REVOKED_MBR_USER_ID = "0b000000-0000-4000-8000-00000000cc07";
const REVOKED_MBR_CLERK_SUB = "user_clerk_revoked_mbr_roster";
const REVOKED_MBR_MEMBERSHIP_ID = "0b000000-0000-4000-8000-00000000dd07";

const DEVICE_A_ID = "0b000000-0000-4000-8000-00000000ee01";
const DEVICE_B_ID = "0b000000-0000-4000-8000-00000000ee02";
const DEVICE_REVOKED_ID = "0b000000-0000-4000-8000-00000000ee03";

const DEVICE_A_ATTESTATION = "device-a-attestation-token-pr5";
const DEVICE_B_ATTESTATION = "device-b-attestation-token-pr5";
const DEVICE_REVOKED_ATTESTATION = "device-revoked-attestation-pr5";

// Map raw JWT strings the test sends → Clerk subject the verifier returns.
class StubClerkVerifier implements ClerkVerifier {
  constructor(private readonly map: Map<string, string>) {}
  async verify(rawJwt: string): Promise<{ sub: string }> {
    const sub = this.map.get(rawJwt);
    if (!sub) throw new Error("StubClerkVerifier: unknown jwt");
    return { sub };
  }
}

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[pos-operators.controller.spec] skipping (Docker unavailable)");
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

    // ---- tenant + roles ----
    await pool.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'pr5-tenant', 'PR5 Tenant')`,
      [TENANT_ID],
    );
    await pool.query(
      `INSERT INTO roles (id, tenant_id, code, name) VALUES
         ($1, $2, 'tenant_admin',  'Admin'),
         ($3, $2, 'store_manager', 'Manager'),
         ($4, $2, 'store_staff',   'Staff')`,
      [ADMIN_ROLE_ID, TENANT_ID, MANAGER_ROLE_ID, STAFF_ROLE_ID],
    );

    // ---- stores ----
    await pool.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $2, 'STA', 'Store A'),
         ($3, $2, 'STB', 'Store B')`,
      [STORE_ID_A, TENANT_ID, STORE_ID_B],
    );

    // ---- users with Clerk mapping ----
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
         ($1, 'admin@pr5.example',    'Admin User',    $2),
         ($3, 'manager@pr5.example',  'Manager User',  $4),
         ($5, 'staff@pr5.example',    'Staff User',    $6),
         ($7, 'specific@pr5.example', 'Specific User', $8)`,
      [
        ADMIN_USER_ID, ADMIN_CLERK_SUB,
        MANAGER_USER_ID, MANAGER_CLERK_SUB,
        STAFF_USER_ID, STAFF_CLERK_SUB,
        SPECIFIC_USER_ID, SPECIFIC_CLERK_SUB,
      ],
    );
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id, deleted_at)
         VALUES ($1, 'deleted@pr5.example', 'Deleted', $2, now())`,
      [DELETED_USER_ID, DELETED_CLERK_SUB],
    );

    // ---- memberships ----
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
         ($1, $2, $3, $4, 'all'),
         ($5, $2, $6, $7, 'all'),
         ($8, $2, $9, $10, 'all'),
         ($11, $2, $12, $13, 'specific'),
         ($14, $2, $15, $4, 'all')`,
      [
        ADMIN_MEMBERSHIP_ID, TENANT_ID, ADMIN_USER_ID, ADMIN_ROLE_ID,
        MANAGER_MEMBERSHIP_ID, MANAGER_USER_ID, MANAGER_ROLE_ID,
        STAFF_MEMBERSHIP_ID, STAFF_USER_ID, STAFF_ROLE_ID,
        SPECIFIC_MEMBERSHIP_ID, SPECIFIC_USER_ID, MANAGER_ROLE_ID,
        DELETED_MEMBERSHIP_ID, DELETED_USER_ID,
      ],
    );

    // The "specific" user is granted access to STORE_ID_B only
    await pool.query(
      `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`,
      [SPECIFIC_MEMBERSHIP_ID, STORE_ID_B, TENANT_ID],
    );

    // ---- tenant B (cross-tenant isolation) ----
    await pool.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'tenant-b-roster', 'Tenant B Roster')`,
      [TENANT_ID_B],
    );
    await pool.query(
      `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'store_manager', 'Manager B')`,
      [TENANT_B_ROLE_ID, TENANT_ID_B],
    );
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES ($1, 'mgr-b@tenantb.example', 'Manager B', $2)`,
      [TENANT_B_USER_ID, TENANT_B_CLERK_SUB],
    );
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, 'all')`,
      [TENANT_B_MEMBERSHIP_ID, TENANT_ID_B, TENANT_B_USER_ID, TENANT_B_ROLE_ID],
    );

    // ---- revoked membership ----
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES ($1, 'revoked@pr5.example', 'Revoked User', $2)`,
      [REVOKED_MBR_USER_ID, REVOKED_MBR_CLERK_SUB],
    );
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind, revoked_at)
         VALUES ($1, $2, $3, $4, 'all', now())`,
      [REVOKED_MBR_MEMBERSHIP_ID, TENANT_ID, REVOKED_MBR_USER_ID, MANAGER_ROLE_ID],
    );

    // ---- devices ----
    const hashA = hashToken(DEVICE_A_ATTESTATION);
    const hashB = hashToken(DEVICE_B_ATTESTATION);
    const hashRev = hashToken(DEVICE_REVOKED_ATTESTATION);
    await pool.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES
         ($1, $2, $3, 'till-A', $4),
         ($5, $2, $6, 'till-B', $7)`,
      [DEVICE_A_ID, TENANT_ID, STORE_ID_A, hashA, DEVICE_B_ID, STORE_ID_B, hashB],
    );
    await pool.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, revoked_at)
         VALUES ($1, $2, $3, 'till-revoked', $4, now())`,
      [DEVICE_REVOKED_ID, TENANT_ID, STORE_ID_A, hashRev],
    );

    // ---- Nest app + verifier override ----
    const verifierMap = new Map<string, string>([
      ["jwt-admin",    ADMIN_CLERK_SUB],
      ["jwt-manager",  MANAGER_CLERK_SUB],
      ["jwt-staff",    STAFF_CLERK_SUB],
      ["jwt-specific", SPECIFIC_CLERK_SUB],
      ["jwt-deleted",  DELETED_CLERK_SUB],
      ["jwt-unmapped", "user_clerk_unmapped_pr5"],
      ["jwt-tenant-b-mgr", TENANT_B_CLERK_SUB],
      ["jwt-revoked-mbr", REVOKED_MBR_CLERK_SUB],
    ]);

    const moduleRef = await Test.createTestingModule({
      imports: [PosOperatorsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(env.app)
      .overrideProvider(AUTH_LOOKUP_POOL)
      .useValue(pool)
      .overrideProvider(CLERK_VERIFIER)
      .useValue(new StubClerkVerifier(verifierMap))
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
      console.warn(`\n[pos-operators.controller.spec] Docker NOT AVAILABLE: ${msg}\n`);
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

afterEach(async () => {
  // Tear down any operator-session rows created during a test so the
  // next test does not see a "takeover_required" from leftover state.
  if (pool) {
    await pool
      .query(`DELETE FROM auth_tokens WHERE scope = 'pos_operator'`)
      .catch(() => undefined);
  }
});

// -----------------------------------------------------------------------
// Happy paths
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/operators/sign-in (happy paths)", () => {
  it("tenant_admin signs in → 200 signed_in, operator.id = Clerk subject, branch_id = device.store_id", async () => {
    if (maybeSkip()) return;

    const res = await http()
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bearer jwt-admin")
      .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("signed_in");
    expect(res.body.operator).toEqual({
      id: ADMIN_CLERK_SUB,                // <- Clerk subject (v1 bridge), not ADMIN_USER_ID
      user_id: ADMIN_USER_ID,             // <- 033: provider-neutral users.id (SC-033-1)
      display_name: "Admin User",
      role: "admin",                      // <- mapped from internal tenant_admin
      tenant_id: TENANT_ID,
      branch_id: STORE_ID_A,              // <- store_id surfaced as branch_id
    });
    expect(res.body.operator_session.id).toEqual(expect.any(String));
    expect(res.body.operator_session.issued_at).toEqual(expect.any(String));

    // operator.id is NOT the local users.id
    expect(res.body.operator.id).not.toBe(ADMIN_USER_ID);

    // No Clerk session token, no internal bearer leaked anywhere.
    const flat = JSON.stringify(res.body);
    expect(flat).not.toMatch(/clerk_session_token/);
    expect(flat).not.toMatch(/token_hash/);
    expect(flat).not.toMatch(/raw_token/);

    // auth_tokens row materialized with scope = pos_operator
    const r = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM auth_tokens
        WHERE scope = 'pos_operator' AND device_id = $1 AND store_id = $2
          AND user_id = $3 AND tenant_id = $4 AND revoked_at IS NULL`,
      [DEVICE_A_ID, STORE_ID_A, ADMIN_USER_ID, TENANT_ID],
    );
    expect(r.rows[0]!.count).toBe("1");
  });

  it("store_manager signs in → role mapped to 'manager'", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bearer jwt-manager")
      .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("signed_in");
    expect(res.body.operator.role).toBe("manager");
  });

  it("specific-access user signs in on their granted store", async () => {
    if (maybeSkip()) return;
    // SPECIFIC has access to STORE_ID_B only
    const res = await http()
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bearer jwt-specific")
      .send({ kind: "manager_admin", device_token_attestation: DEVICE_B_ATTESTATION });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("signed_in");
    expect(res.body.operator.branch_id).toBe(STORE_ID_B);
  });
});

// -----------------------------------------------------------------------
// Refusals — uniform 401 envelope
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/operators/sign-in (refusals → 401)", () => {
  const cases: Array<[string, () => request.Test]> = [
    [
      "missing Authorization header",
      () =>
        http()
          .post("/api/pos/v1/operators/sign-in")
          .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION }),
    ],
    [
      "malformed bearer (wrong scheme)",
      () =>
        http()
          .post("/api/pos/v1/operators/sign-in")
          .set("Authorization", "Basic abc")
          .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION }),
    ],
    [
      "verifier rejects (unknown JWT)",
      () =>
        http()
          .post("/api/pos/v1/operators/sign-in")
          .set("Authorization", "Bearer not-in-stub-map")
          .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION }),
    ],
    [
      "Clerk subject not mapped to a local user",
      () =>
        http()
          .post("/api/pos/v1/operators/sign-in")
          .set("Authorization", "Bearer jwt-unmapped")
          .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION }),
    ],
    [
      "soft-deleted user",
      () =>
        http()
          .post("/api/pos/v1/operators/sign-in")
          .set("Authorization", "Bearer jwt-deleted")
          .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION }),
    ],
    [
      "device attestation matches no active device",
      () =>
        http()
          .post("/api/pos/v1/operators/sign-in")
          .set("Authorization", "Bearer jwt-admin")
          .send({ kind: "manager_admin", device_token_attestation: "ghost-attestation" }),
    ],
    [
      "device is revoked",
      () =>
        http()
          .post("/api/pos/v1/operators/sign-in")
          .set("Authorization", "Bearer jwt-admin")
          .send({ kind: "manager_admin", device_token_attestation: DEVICE_REVOKED_ATTESTATION }),
    ],
    [
      "role ineligible (store_staff)",
      () =>
        http()
          .post("/api/pos/v1/operators/sign-in")
          .set("Authorization", "Bearer jwt-staff")
          .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION }),
    ],
    [
      "store_access_kind=specific without grant for the resolved store",
      () =>
        http()
          .post("/api/pos/v1/operators/sign-in")
          .set("Authorization", "Bearer jwt-specific")
          .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION }),
    ],
  ];

  for (const [label, build] of cases) {
    it(`uniform 401 envelope: ${label}`, async () => {
      if (maybeSkip()) return;
      const res = await build();
      expect(res.status).toBe(401);
      expectErrorEnvelope(res.body, "unauthorized");
      // The body never enumerates the cause.
      expect(JSON.stringify(res.body)).not.toMatch(/jwt|clerk|device|membership|role|tenant|store_access/i);
    });
  }
});

// -----------------------------------------------------------------------
// Takeover-required path
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/operators/sign-in (takeover_required)", () => {
  it("returns 200 { kind: 'takeover_required' } when an active operator session exists for (device, store)", async () => {
    if (maybeSkip()) return;

    // First sign-in materializes a row.
    const first = await http()
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bearer jwt-admin")
      .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION });
    expect(first.status).toBe(200);
    expect(first.body.kind).toBe("signed_in");

    // Second sign-in (different operator on the same device) → takeover_required.
    const second = await http()
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bearer jwt-manager")
      .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION });

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ kind: "takeover_required" });
  });
});

// -----------------------------------------------------------------------
// Body validation — Zod / OpenAPI additionalProperties:false
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/operators/sign-in (body validation → 400)", () => {
  const FORBIDDEN_EXTRAS: Array<[string, Record<string, unknown>]> = [
    ["branch_id",            { branch_id: STORE_ID_A }],
    ["password",             { password: "anything" }],
    ["identifier",           { identifier: "alice" }],
    ["pin",                  { pin: "1234" }],
    ["cashier",              { cashier: "yes" }],
    ["clerk_session_token",  { clerk_session_token: "leaked" }],
  ];

  for (const [label, extra] of FORBIDDEN_EXTRAS) {
    it(`rejects body with extra '${label}' as 400 validation_error`, async () => {
      if (maybeSkip()) return;
      const res = await http()
        .post("/api/pos/v1/operators/sign-in")
        .set("Authorization", "Bearer jwt-admin")
        .send({
          kind: "manager_admin",
          device_token_attestation: DEVICE_A_ATTESTATION,
          ...extra,
        });
      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, "validation_error");
    });
  }

  it("rejects unknown 'kind' value", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bearer jwt-admin")
      .send({ kind: "operator_signin", device_token_attestation: DEVICE_A_ATTESTATION });
    expect(res.status).toBe(400);
  });

  it("rejects empty device_token_attestation", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bearer jwt-admin")
      .send({ kind: "manager_admin", device_token_attestation: "" });
    expect(res.status).toBe(400);
  });
});

// -----------------------------------------------------------------------
// Wave 3 — GET /api/pos/v1/operators/roster
// -----------------------------------------------------------------------

describe("GET /api/pos/v1/operators/roster", () => {
  it("happy path: returns cashiers for the branch", async () => {
    if (maybeSkip()) return;
    // STAFF_USER has store_staff role → appears as cashier
    const res = await http()
      .get(`/api/pos/v1/operators/roster?branch_id=${STORE_ID_A}`)
      .set("Authorization", "Bearer jwt-admin");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("cashiers");
    expect(Array.isArray(res.body.cashiers)).toBe(true);
    const cashierIds = res.body.cashiers.map((c: { id: string }) => c.id);
    expect(cashierIds).toContain(STAFF_CLERK_SUB);
    // Entries must only have id, user_id, display_name, role (034: user_id
    // = provider-neutral users.id, distinct from id = clerk_user_id).
    for (const c of res.body.cashiers) {
      expect(c).toEqual({
        id: expect.any(String),
        user_id: expect.any(String),
        display_name: expect.any(String),
        role: "cashier",
      });
    }
    // The staff cashier's user_id is its users.id, distinct from its Clerk subject.
    const staff = res.body.cashiers.find((c: { id: string }) => c.id === STAFF_CLERK_SUB);
    expect(staff.user_id).toBe(STAFF_USER_ID);
    expect(staff.user_id).not.toBe(staff.id);
  });

  it("401 when Authorization header is missing", async () => {
    if (maybeSkip()) return;
    const res = await http().get(`/api/pos/v1/operators/roster?branch_id=${STORE_ID_A}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("401 when branch_id is omitted", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get("/api/pos/v1/operators/roster")
      .set("Authorization", "Bearer jwt-admin");
    expect(res.status).toBe(401);
  });

  it("400 on invalid branch_id (non-UUID)", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get("/api/pos/v1/operators/roster?branch_id=not-a-uuid")
      .set("Authorization", "Bearer jwt-admin");
    expect(res.status).toBe(400);
  });

  it("response body never contains email, PIN, or credential fields", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(`/api/pos/v1/operators/roster?branch_id=${STORE_ID_A}`)
      .set("Authorization", "Bearer jwt-admin");
    expect(res.status).toBe(200);
    const flat = JSON.stringify(res.body);
    expect(flat).not.toMatch(/email|pin|password|token|clerk_session/i);
  });

  it("401 when requester belongs to a different tenant than the branch (cross-tenant isolation)", async () => {
    if (maybeSkip()) return;
    // TENANT_B manager requests STORE_ID_A which belongs to TENANT_ID.
    // findActiveMembershipByStore JOINs stores ON stores.tenant_id = memberships.tenant_id,
    // so no row is found → refused → 401.
    const res = await http()
      .get(`/api/pos/v1/operators/roster?branch_id=${STORE_ID_A}`)
      .set("Authorization", "Bearer jwt-tenant-b-mgr");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("401 when requester has specific store access but requests a branch outside their grant", async () => {
    if (maybeSkip()) return;
    // SPECIFIC_USER is granted access to STORE_ID_B only.
    // Requesting STORE_ID_A must be refused.
    const res = await http()
      .get(`/api/pos/v1/operators/roster?branch_id=${STORE_ID_A}`)
      .set("Authorization", "Bearer jwt-specific");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("401 when requester membership is revoked", async () => {
    if (maybeSkip()) return;
    // REVOKED_MBR_USER has a membership with revoked_at set.
    // findActiveMembershipByStore filters WHERE m.revoked_at IS NULL, so no row found → refused.
    const res = await http()
      .get(`/api/pos/v1/operators/roster?branch_id=${STORE_ID_A}`)
      .set("Authorization", "Bearer jwt-revoked-mbr");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });
});

// -----------------------------------------------------------------------
// Wave 3 — POST /api/pos/v1/operators/takeover/confirm
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/operators/takeover/confirm", () => {
  const TAKEOVER_EVENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";

  afterEach(async () => {
    // Remove idempotency keys written during takeover tests.
    if (pool) {
      await pool
        .query(`DELETE FROM idempotency_keys WHERE key = $1`, [TAKEOVER_EVENT_ID])
        .catch(() => undefined);
    }
  });

  it("happy path: confirm takeover after takeover_required sign-in, returns signed_in envelope", async () => {
    if (maybeSkip()) return;
    // Step 1: admin signs in → session exists.
    await http()
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bearer jwt-admin")
      .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION });

    // Step 2: manager sees takeover_required.
    const takeoverCheck = await http()
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bearer jwt-manager")
      .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION });
    expect(takeoverCheck.body.kind).toBe("takeover_required");

    // Step 3: manager confirms takeover.
    const res = await http()
      .post("/api/pos/v1/operators/takeover/confirm")
      .set("Authorization", "Bearer jwt-manager")
      .send({
        event_id: TAKEOVER_EVENT_ID,
        operator_id: MANAGER_CLERK_SUB,
        device_token_attestation: DEVICE_A_ATTESTATION,
      });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("signed_in");
    expect(res.body.operator.id).toBe(MANAGER_CLERK_SUB);
    expect(res.body.operator.branch_id).toBe(STORE_ID_A);
    expect(res.body.operator_session.id).toEqual(expect.any(String));

    // Audit event created.
    const auditCount = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_events WHERE action = 'operator.session.takeover'`,
    );
    expect(auditCount.rows[0]!.count).toBe("1");

    // Prior session should be revoked.
    const priorActive = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM auth_tokens
        WHERE scope = 'pos_operator' AND device_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [DEVICE_A_ID, ADMIN_USER_ID],
    );
    expect(priorActive.rows[0]!.count).toBe("0");
  });

  it("idempotency: re-submitting same event_id + operator_id returns same envelope", async () => {
    if (maybeSkip()) return;
    // Set up an active session.
    await http()
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bearer jwt-admin")
      .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION });

    const body = {
      event_id: TAKEOVER_EVENT_ID,
      operator_id: MANAGER_CLERK_SUB,
      device_token_attestation: DEVICE_A_ATTESTATION,
    };

    const first = await http()
      .post("/api/pos/v1/operators/takeover/confirm")
      .set("Authorization", "Bearer jwt-manager")
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body.kind).toBe("signed_in");
    const firstSessionId = first.body.operator_session.id;

    const second = await http()
      .post("/api/pos/v1/operators/takeover/confirm")
      .set("Authorization", "Bearer jwt-manager")
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.kind).toBe("signed_in");
    expect(second.body.operator_session.id).toBe(firstSessionId);
  });

  it("401 when operator_id in body does not match JWT sub", async () => {
    if (maybeSkip()) return;
    // Active session needed for this test to reach the operator_id check.
    await http()
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bearer jwt-admin")
      .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION });

    const res = await http()
      .post("/api/pos/v1/operators/takeover/confirm")
      .set("Authorization", "Bearer jwt-manager")
      .send({
        event_id: TAKEOVER_EVENT_ID,
        operator_id: ADMIN_CLERK_SUB, // mismatch: body says admin, JWT says manager
        device_token_attestation: DEVICE_A_ATTESTATION,
      });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("401 when no active session exists to supersede", async () => {
    if (maybeSkip()) return;
    // No existing session — no takeover_required was triggered.
    const res = await http()
      .post("/api/pos/v1/operators/takeover/confirm")
      .set("Authorization", "Bearer jwt-manager")
      .send({
        event_id: TAKEOVER_EVENT_ID,
        operator_id: MANAGER_CLERK_SUB,
        device_token_attestation: DEVICE_A_ATTESTATION,
      });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("400 when body is missing required fields", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/operators/takeover/confirm")
      .set("Authorization", "Bearer jwt-manager")
      .send({ event_id: TAKEOVER_EVENT_ID }); // missing operator_id and attestation
    expect(res.status).toBe(400);
  });
});

// -----------------------------------------------------------------------
// Wave 3 — GET /api/pos/v1/operators/active-session
// -----------------------------------------------------------------------

describe("GET /api/pos/v1/operators/active-session", () => {
  it("returns { kind: 'none' } when operator has no active session", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(
        `/api/pos/v1/operators/active-session?branch_id=${STORE_ID_A}&operator_id=${ADMIN_CLERK_SUB}`,
      )
      .set("Authorization", "Bearer jwt-admin");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "none" });
  });

  it("returns { kind: 'active' } when operator has an active session", async () => {
    if (maybeSkip()) return;
    // Sign admin in on device A (→ STORE_ID_A).
    await http()
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bearer jwt-admin")
      .send({ kind: "manager_admin", device_token_attestation: DEVICE_A_ATTESTATION });

    const res = await http()
      .get(
        `/api/pos/v1/operators/active-session?branch_id=${STORE_ID_A}&operator_id=${ADMIN_CLERK_SUB}`,
      )
      .set("Authorization", "Bearer jwt-admin");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "active" });
    // Minimum-disclosure: only kind present.
    expect(Object.keys(res.body)).toEqual(["kind"]);
  });

  it("returns { kind: 'none' } for unknown operator_id (minimum-disclosure, not 401)", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(
        `/api/pos/v1/operators/active-session?branch_id=${STORE_ID_A}&operator_id=user_clerk_never_existed`,
      )
      .set("Authorization", "Bearer jwt-admin");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "none" });
  });

  it("401 when Authorization header is missing", async () => {
    if (maybeSkip()) return;
    const res = await http().get(
      `/api/pos/v1/operators/active-session?branch_id=${STORE_ID_A}&operator_id=${ADMIN_CLERK_SUB}`,
    );
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("401 when requester has no membership for the queried branch", async () => {
    if (maybeSkip()) return;
    // Use a UUID that is not a known store in any tenant.
    const unknownBranch = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const res = await http()
      .get(
        `/api/pos/v1/operators/active-session?branch_id=${unknownBranch}&operator_id=${ADMIN_CLERK_SUB}`,
      )
      .set("Authorization", "Bearer jwt-admin");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("400 when branch_id is missing", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(`/api/pos/v1/operators/active-session?operator_id=${ADMIN_CLERK_SUB}`)
      .set("Authorization", "Bearer jwt-admin");
    expect(res.status).toBe(400);
  });

  it("400 when operator_id is missing", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(`/api/pos/v1/operators/active-session?branch_id=${STORE_ID_A}`)
      .set("Authorization", "Bearer jwt-admin");
    expect(res.status).toBe(400);
  });

  it("400 when both branch_id and operator_id are missing", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get("/api/pos/v1/operators/active-session")
      .set("Authorization", "Bearer jwt-admin");
    expect(res.status).toBe(400);
  });
});
