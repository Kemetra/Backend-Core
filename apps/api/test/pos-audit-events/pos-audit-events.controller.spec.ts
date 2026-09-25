/**
 * PosAuditEventsController — integration spec.
 *
 * Real Postgres via Testcontainers (0000 + 0001 migrations applied).
 * The Clerk verifier is overridden with a deterministic fake so no test
 * traffic reaches Clerk's JWKS endpoint.
 *
 * Coverage:
 *   - Happy paths: batch with known events → accepted array, auth_events rows
 *     written with `occurred_at` from wire `created_at` (not ingestion time).
 *   - Idempotency (P5): re-submitting the same event_id → duplicates array,
 *     no second row in audit_events.
 *   - Per-event isolation: one bad event in a batch does not block others.
 *   - Device auth refusal (invalid / revoked attestation) → uniform 401.
 *   - Optional Clerk JWT: batch accepted without Authorization header.
 *   - Clerk JWT present but invalid → 401 (fail-closed).
 *   - Per-event rejections:
 *       - unknown action_category → schema_violation
 *       - payload with forbidden key → schema_violation
 *       - tenant_id mismatch → tenant_mismatch
 *       - acting_operator_id not mapped to a local user → invalid_input
 *   - Top-level 400: empty events array, missing device_token_attestation.
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
import { PosAuditEventsModule } from "../../src/pos-audit-events/pos-audit-events.module";
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

const TENANT_ID = "0c000000-0000-4000-8000-000000000001";
const TENANT_ID_OTHER = "0c000000-0000-4000-8000-000000000002";
const STORE_ID = "0c000000-0000-4000-8000-00000000aa01";

const OPERATOR_USER_ID = "0c000000-0000-4000-8000-00000000cc01";
const OPERATOR_CLERK_SUB = "user_clerk_op_ae_pr6";

const OPERATOR_OTHER_TENANT_USER_ID = "0c000000-0000-4000-8000-00000000cc02";
const OPERATOR_OTHER_TENANT_CLERK_SUB = "user_clerk_op_ae_other_tenant";

const OPERATOR_REVOKED_USER_ID = "0c000000-0000-4000-8000-00000000cc03";
const OPERATOR_REVOKED_CLERK_SUB = "user_clerk_op_ae_revoked";

const DEVICE_ID = "0c000000-0000-4000-8000-00000000ee01";
const DEVICE_REVOKED_ID = "0c000000-0000-4000-8000-00000000ee02";
const OPERATOR_SESSION_ID = "0c000000-0000-4000-8000-00000000ee03";

const DEVICE_ATTESTATION = "ae-device-attestation-token-pr6";
const DEVICE_REVOKED_ATTESTATION = "ae-device-revoked-attestation-pr6";

const EVT_1 = "0c111111-0000-4000-8000-000000000001";
const EVT_2 = "0c111111-0000-4000-8000-000000000002";
const EVT_3 = "0c111111-0000-4000-8000-000000000003";
const EVT_4 = "0c111111-0000-4000-8000-000000000004";
const EVT_5 = "0c111111-0000-4000-8000-000000000005";

const SHIFT_ID = "0c222222-0000-4000-8000-000000000001";

const CREATED_AT = "2026-01-15T10:00:00.000Z";

function makeShiftOpen(eventId: string) {
  return {
    event_id: eventId,
    tenant_id: TENANT_ID,
    branch_id: STORE_ID,
    originating_terminal_id: DEVICE_ID,
    acting_operator_id: OPERATOR_CLERK_SUB,
    session_id: OPERATOR_SESSION_ID,
    action_category: "shift.open",
    created_at: CREATED_AT,
    payload: { shift_id: SHIFT_ID, opened_at: CREATED_AT },
  };
}

class StubClerkVerifier implements ClerkVerifier {
  constructor(private readonly validTokens: Set<string>) {}
  async verify(rawJwt: string): Promise<{ sub: string }> {
    if (!this.validTokens.has(rawJwt)) throw new Error("StubClerkVerifier: unknown jwt");
    return { sub: OPERATOR_CLERK_SUB };
  }
}

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[pos-audit-events.controller.spec] skipping (Docker unavailable)");
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

    await pool.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'ae-tenant', 'AE Tenant'), ($2, 'ae-other', 'AE Other')`,
      [TENANT_ID, TENANT_ID_OTHER],
    );
    await pool.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'AE1', 'Store AE')`,
      [STORE_ID, TENANT_ID],
    );
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES ($1, 'op@ae.example', 'Operator AE', $2)`,
      [OPERATOR_USER_ID, OPERATOR_CLERK_SUB],
    );

    // Membership for the primary operator in TENANT_ID (required by the tenant-scoped actor lookup).
    const ROLE_ID = "0c000000-0000-4000-8000-00000000ff01";
    await pool.query(
      `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'store_manager', 'Manager AE') ON CONFLICT DO NOTHING`,
      [ROLE_ID, TENANT_ID],
    );
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
       VALUES ($1, $2, $3, $4, 'all')`,
      ["0c000000-0000-4000-8000-00000000dd01", TENANT_ID, OPERATOR_USER_ID, ROLE_ID],
    );

    // User with NO membership in TENANT_ID (belongs to TENANT_ID_OTHER only).
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES ($1, 'op@ae-other.example', 'Operator Other Tenant', $2)`,
      [OPERATOR_OTHER_TENANT_USER_ID, OPERATOR_OTHER_TENANT_CLERK_SUB],
    );

    // User with a REVOKED membership in TENANT_ID.
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES ($1, 'op-revoked@ae.example', 'Operator Revoked', $2)`,
      [OPERATOR_REVOKED_USER_ID, OPERATOR_REVOKED_CLERK_SUB],
    );
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind, revoked_at)
       VALUES ($1, $2, $3, $4, 'all', now())`,
      ["0c000000-0000-4000-8000-00000000dd02", TENANT_ID, OPERATOR_REVOKED_USER_ID, ROLE_ID],
    );

    const hashActive = hashToken(DEVICE_ATTESTATION);
    const hashRevoked = hashToken(DEVICE_REVOKED_ATTESTATION);
    await pool.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'till-ae', $4)`,
      [DEVICE_ID, TENANT_ID, STORE_ID, hashActive],
    );
    await pool.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, revoked_at) VALUES ($1, $2, $3, 'till-rev', $4, now())`,
      [DEVICE_REVOKED_ID, TENANT_ID, STORE_ID, hashRevoked],
    );
    await pool.query(
      `INSERT INTO auth_tokens
         (id, token_hash, tenant_id, user_id, device_id, store_id, scope,
          issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pos_operator', $7, $8)`,
      [
        OPERATOR_SESSION_ID,
        hashToken("ae-operator-session"),
        TENANT_ID,
        OPERATOR_USER_ID,
        DEVICE_ID,
        STORE_ID,
        "2026-01-14T10:00:00.000Z",
        "2027-01-15T10:00:00.000Z",
      ],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [PosAuditEventsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(env.app)
      .overrideProvider(AUTH_LOOKUP_POOL)
      .useValue(pool)
      .overrideProvider(CLERK_VERIFIER)
      .useValue(new StubClerkVerifier(new Set(["jwt-valid"])))
      .compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    const logger = createLogger({ service: "api-test-ae", level: "silent" });
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
      console.warn(`\n[pos-audit-events.controller.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
  if (pool) {
    await pool
      .query(`DELETE FROM shifts WHERE tenant_id = $1`, [TENANT_ID])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM audit_events WHERE tenant_id = $1`, [TENANT_ID])
      .catch(() => undefined);
  }
});

// -----------------------------------------------------------------------
// Happy paths
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/audit-events (happy paths)", () => {
  it("accepts a valid batch and returns accepted array; row written with wire created_at as occurred_at", async () => {
    if (maybeSkip()) return;

    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({
        device_token_attestation: DEVICE_ATTESTATION,
        events: [makeShiftOpen(EVT_1)],
      });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toEqual([EVT_1]);
    expect(res.body.duplicates).toEqual([]);
    expect(res.body.rejected).toEqual([]);

    // Verify row in audit_events with occurred_at from wire (not ingestion time).
    const r = await pool!.query<{ occurred_at: string }>(
      `SELECT occurred_at::text FROM audit_events WHERE id = $1`,
      [EVT_1],
    );
    expect(r.rows).toHaveLength(1);
    // occurred_at must be the wire-side created_at, NOT current timestamp.
    const dbMs = new Date(r.rows[0]!.occurred_at).getTime();
    const wireMs = new Date(CREATED_AT).getTime();
    expect(dbMs).toBe(wireMs);
  });

  it("accepts batch without Authorization header (Clerk JWT optional)", async () => {
    if (maybeSkip()) return;

    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({
        device_token_attestation: DEVICE_ATTESTATION,
        events: [makeShiftOpen(EVT_2)],
      });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toEqual([EVT_2]);
  });

  it("accepts batch when valid Clerk JWT is present", async () => {
    if (maybeSkip()) return;

    const res = await http()
      .post("/api/pos/v1/audit-events")
      .set("Authorization", "Bearer jwt-valid")
      .send({
        device_token_attestation: DEVICE_ATTESTATION,
        events: [makeShiftOpen(EVT_3)],
      });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toEqual([EVT_3]);
  });
});

// -----------------------------------------------------------------------
// Idempotency (P5)
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/audit-events (idempotency P5)", () => {
  it("re-submitting the same event_id returns it in duplicates, no second row written", async () => {
    if (maybeSkip()) return;

    // First submission — accepted.
    await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [makeShiftOpen(EVT_4)] });

    // Second submission of the same event_id.
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [makeShiftOpen(EVT_4)] });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toEqual([]);
    expect(res.body.duplicates).toEqual([EVT_4]);
    expect(res.body.rejected).toEqual([]);

    // Only one row in audit_events.
    const r = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_events WHERE id = $1`,
      [EVT_4],
    );
    expect(r.rows[0]!.count).toBe("1");
  });
});

// -----------------------------------------------------------------------
// Per-event isolation
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/audit-events (per-event isolation)", () => {
  it("bad event in a batch does not block valid events — partial accepted + rejected", async () => {
    if (maybeSkip()) return;

    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({
        device_token_attestation: DEVICE_ATTESTATION,
        events: [
          makeShiftOpen(EVT_5),
          {
            // unknown action_category → schema_violation rejection
            ...makeShiftOpen("0c111111-0000-4000-8000-000000000006"),
            action_category: "ghost.category.unknown",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toEqual([EVT_5]);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0]).toMatchObject({ category: "schema_violation" });
  });
});

// -----------------------------------------------------------------------
// Device auth refusals → 401
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/audit-events (device auth → 401)", () => {
  it("invalid device attestation → uniform 401", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({
        device_token_attestation: "ghost-attestation-not-in-db",
        events: [makeShiftOpen("0c111111-0000-4000-8000-000000000010")],
      });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("revoked device attestation → uniform 401", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({
        device_token_attestation: DEVICE_REVOKED_ATTESTATION,
        events: [makeShiftOpen("0c111111-0000-4000-8000-000000000011")],
      });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("malformed Authorization header (not Bearer) → 401", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .set("Authorization", "Basic somethingelse")
      .send({
        device_token_attestation: DEVICE_ATTESTATION,
        events: [makeShiftOpen("0c111111-0000-4000-8000-000000000012")],
      });
    expect(res.status).toBe(401);
  });

  it("invalid JWT when Authorization header present → 401 (fail-closed)", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .set("Authorization", "Bearer jwt-not-in-stub-map")
      .send({
        device_token_attestation: DEVICE_ATTESTATION,
        events: [makeShiftOpen("0c111111-0000-4000-8000-000000000013")],
      });
    expect(res.status).toBe(401);
  });
});

// -----------------------------------------------------------------------
// Per-event rejection categories
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/audit-events (per-event rejections)", () => {
  it("unknown action_category → schema_violation", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({
        device_token_attestation: DEVICE_ATTESTATION,
        events: [{ ...makeShiftOpen("0c111111-0000-4000-8000-000000000020"), action_category: "unknown.category" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([
      { event_id: "0c111111-0000-4000-8000-000000000020", category: "schema_violation" },
    ]);
  });

  it("payload with top-level forbidden key (pin) → schema_violation", async () => {
    if (maybeSkip()) return;
    const evt = makeShiftOpen("0c111111-0000-4000-8000-000000000021");
    evt.payload = { shift_id: "0c222222-0000-4000-8000-000000000001", opened_at: CREATED_AT, pin: "1234" };
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [evt] });
    expect(res.status).toBe(200);
    expect(res.body.rejected[0]).toMatchObject({ category: "schema_violation" });
  });

  it("payload with nested forbidden key (password_hash) → schema_violation", async () => {
    if (maybeSkip()) return;
    const evt = makeShiftOpen("0c111111-0000-4000-8000-000000000022");
    evt.payload = { shift_id: "0c222222-0000-4000-8000-000000000001", opened_at: CREATED_AT, meta: { password_hash: "x" } };
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [evt] });
    expect(res.status).toBe(200);
    expect(res.body.rejected[0]).toMatchObject({ category: "schema_violation" });
  });

  it("tenant_id mismatch → tenant_mismatch", async () => {
    if (maybeSkip()) return;
    const evt = { ...makeShiftOpen("0c111111-0000-4000-8000-000000000023"), tenant_id: TENANT_ID_OTHER };
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [evt] });
    expect(res.status).toBe(200);
    expect(res.body.rejected[0]).toMatchObject({ category: "tenant_mismatch" });
  });

  it("acting_operator_id not mapped to a local user → invalid_input", async () => {
    if (maybeSkip()) return;
    const evt = { ...makeShiftOpen("0c111111-0000-4000-8000-000000000024"), acting_operator_id: "user_clerk_unmapped_ae_ghost" };
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [evt] });
    expect(res.status).toBe(200);
    expect(res.body.rejected[0]).toMatchObject({ category: "invalid_input" });
  });

  it("acting_operator_id belongs to a user with no membership in device tenant → invalid_input", async () => {
    if (maybeSkip()) return;
    // OPERATOR_OTHER_TENANT_USER_ID exists in users but has no membership in TENANT_ID.
    const evt = {
      ...makeShiftOpen("0c111111-0000-4000-8000-000000000025"),
      acting_operator_id: OPERATOR_OTHER_TENANT_CLERK_SUB,
    };
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [evt] });
    expect(res.status).toBe(200);
    expect(res.body.rejected[0]).toMatchObject({
      event_id: "0c111111-0000-4000-8000-000000000025",
      category: "invalid_input",
    });
  });

  it("acting_operator_id has a revoked membership in device tenant → invalid_input", async () => {
    if (maybeSkip()) return;
    // OPERATOR_REVOKED_USER_ID has a membership in TENANT_ID but revoked_at IS NOT NULL.
    const evt = {
      ...makeShiftOpen("0c111111-0000-4000-8000-000000000026"),
      acting_operator_id: OPERATOR_REVOKED_CLERK_SUB,
    };
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [evt] });
    expect(res.status).toBe(200);
    expect(res.body.rejected[0]).toMatchObject({
      event_id: "0c111111-0000-4000-8000-000000000026",
      category: "invalid_input",
    });
  });

  it("accepts a delayed audit from a session valid before the operator was demoted", async () => {
    if (maybeSkip()) return;
    const membershipId = "0c000000-0000-4000-8000-00000000dd01";
    const eventId = "0c111111-0000-4000-8000-000000000029";
    await pool!.query("UPDATE memberships SET revoked_at=now() WHERE id=$1", [membershipId]);
    try {
      const res = await http()
        .post("/api/pos/v1/audit-events")
        .send({ device_token_attestation: DEVICE_ATTESTATION, events: [makeShiftOpen(eventId)] });
      expect(res.status).toBe(200);
      expect(res.body.accepted).toContain(eventId);
    } finally {
      await pool!.query("UPDATE memberships SET revoked_at=NULL WHERE id=$1", [membershipId]);
    }
  });

  it("contradictory originating_terminal_id is rejected and never persisted", async () => {
    if (maybeSkip()) return;
    const eventId = "0c111111-0000-4000-8000-000000000027";
    const evt = {
      ...makeShiftOpen(eventId),
      originating_terminal_id: DEVICE_REVOKED_ID,
    };
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [evt] });
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([{ event_id: eventId, category: "invalid_input" }]);
    const persisted = await pool!.query("SELECT id FROM audit_events WHERE id = $1", [eventId]);
    expect(persisted.rows).toHaveLength(0);
  });

  it("a session not bound to the authenticated device/operator is rejected", async () => {
    if (maybeSkip()) return;
    const eventId = "0c111111-0000-4000-8000-000000000028";
    const evt = {
      ...makeShiftOpen(eventId),
      session_id: "0c000000-0000-4000-8000-00000000ee99",
    };
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [evt] });
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([{ event_id: eventId, category: "invalid_input" }]);
  });
});

// -----------------------------------------------------------------------
// Top-level 400 (structural body failures)
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/audit-events (body validation → 400)", () => {
  it("empty events array → 400 validation_error", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [] });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  it("missing device_token_attestation → 400 validation_error", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ events: [makeShiftOpen("0c111111-0000-4000-8000-000000000030")] });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  it("event missing required field (action_category) → 400 validation_error", async () => {
    if (maybeSkip()) return;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { action_category, ...noCategory } = makeShiftOpen("0c111111-0000-4000-8000-000000000031");
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [noCategory] });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });
});

// -----------------------------------------------------------------------
// Wave 4.1a: shifts write path
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/audit-events (Wave 4.1a: shifts write path)", () => {
  const SHIFT_EVT = "0c111111-0000-4000-8000-000000000040";
  const SHIFT_EVT_2 = "0c111111-0000-4000-8000-000000000041";
  const SHIFT_EVT_3 = "0c111111-0000-4000-8000-000000000042";
  const SHIFT_ID_ALT = "0c222222-0000-4000-8000-000000000099";

  it("accepted shift.open creates a shifts row with correct field values", async () => {
    if (maybeSkip()) return;

    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [makeShiftOpen(SHIFT_EVT)] });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toEqual([SHIFT_EVT]);

    const r = await pool!.query<{
      shift_id: string;
      tenant_id: string;
      store_id: string;
      opening_cashier_user_id: string;
      opening_device_id: string;
      opened_at: string;
      lifecycle_state: string;
    }>(
      `SELECT shift_id, tenant_id, store_id, opening_cashier_user_id,
              opening_device_id, opened_at::text, lifecycle_state
       FROM shifts WHERE shift_id = $1`,
      [SHIFT_ID],
    );

    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.tenant_id).toBe(TENANT_ID);
    expect(row.store_id).toBe(STORE_ID);
    expect(row.opening_cashier_user_id).toBe(OPERATOR_USER_ID);
    expect(row.opening_device_id).toBe(DEVICE_ID);
    expect(new Date(row.opened_at).getTime()).toBe(new Date(CREATED_AT).getTime());
    expect(row.lifecycle_state).toBe("open");
  });

  it("duplicate shift.open (same event_id) → duplicates; no second shifts row", async () => {
    if (maybeSkip()) return;

    await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [makeShiftOpen(SHIFT_EVT_2)] });

    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [makeShiftOpen(SHIFT_EVT_2)] });

    expect(res.status).toBe(200);
    expect(res.body.duplicates).toEqual([SHIFT_EVT_2]);

    const r = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM shifts WHERE shift_id = $1`,
      [SHIFT_ID],
    );
    expect(r.rows[0]!.count).toBe("1");
  });

  it("shift.open with missing payload.shift_id → schema_violation, no shifts row", async () => {
    if (maybeSkip()) return;

    const evt = {
      ...makeShiftOpen(SHIFT_EVT_3),
      payload: { opened_at: CREATED_AT }, // shift_id intentionally absent
    };

    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [evt] });

    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([{ event_id: SHIFT_EVT_3, category: "schema_violation" }]);

    const r = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM shifts WHERE shift_id = $1`,
      [SHIFT_ID],
    );
    expect(r.rows[0]!.count).toBe("0");
  });

  it("shift.open with non-UUID payload.shift_id → schema_violation, no shifts row", async () => {
    if (maybeSkip()) return;

    const EVT_BAD_UUID = "0c111111-0000-4000-8000-000000000043";
    const evt = {
      ...makeShiftOpen(EVT_BAD_UUID),
      payload: { shift_id: "not-a-uuid", opened_at: CREATED_AT },
    };

    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [evt] });

    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([{ event_id: EVT_BAD_UUID, category: "schema_violation" }]);
  });

  it("rejected event (tenant mismatch) does not write a shifts row", async () => {
    if (maybeSkip()) return;

    const EVT_MISMATCH = "0c111111-0000-4000-8000-000000000044";
    const evt = { ...makeShiftOpen(EVT_MISMATCH), tenant_id: TENANT_ID_OTHER, payload: { shift_id: SHIFT_ID_ALT, opened_at: CREATED_AT } };

    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send({ device_token_attestation: DEVICE_ATTESTATION, events: [evt] });

    expect(res.body.rejected[0]).toMatchObject({ category: "tenant_mismatch" });

    const r = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM shifts WHERE shift_id = $1`,
      [SHIFT_ID_ALT],
    );
    expect(r.rows[0]!.count).toBe("0");
  });
});
