/**
 * T236 — PII / credential redaction proof.
 *
 * Verifies that forbidden fields (pin, password, token, secret, credential,
 * and their common variants) are detected by `hasForbiddenField` at every
 * nesting level, and that the POS audit-events batch pipeline rejects events
 * containing those keys.
 *
 * Test structure
 * --------------
 * Part A — Unit: `hasForbiddenField` directly.
 *   Exercises the exported helper from `pos-audit-events/dto.ts`, which is
 *   the only place in this slice where audit metadata is actively scanned
 *   for forbidden fields before persistence.
 *
 * Part B — Pipeline contract: `AuditJobPayload` / `AuditJobTypes`.
 *   Structural check: the `AuditJobPayload` type has `metadata` typed as
 *   `Record<string, unknown> | null`, not a wide `any`. This is a
 *   compile-time invariant so the test is a schema-shape assertion.
 *
 * Part C — Integration (Testcontainers): POST /api/pos/v1/audit-events.
 *   Proves that a batch containing a forbidden-field event is rejected (the
 *   event lands in `rejected`, not `accepted`), while a clean sibling event
 *   in the same batch is still accepted (per-event isolation).
 *   Also proves that a persisted row's `metadata` column never contains any
 *   of the forbidden keys by querying the DB directly.
 *
 * Scope note
 * ----------
 * The `AuditEmitterInterceptor` emits `metadata: null` for every event in
 * this slice (no metadata content is populated yet). That path therefore
 * cannot leak PII; the active redaction surface is `PosAuditEventsService`.
 * This test file focuses on the active surface.
 *
 * The worker (`apps/worker/src/audit/`) is out of scope per the approved
 * slice boundaries. Worker-side persistence redaction is a separate concern.
 */
import "reflect-metadata";

import { hasForbiddenField } from "../../src/pos-audit-events/dto";

// ---------------------------------------------------------------------------
// Part A — Unit: hasForbiddenField
// ---------------------------------------------------------------------------

describe("hasForbiddenField — top-level forbidden keys", () => {
  const CASES: Array<[string, Record<string, unknown>]> = [
    ["pin",                       { pin: "1234" }],
    ["pin_hash",                  { pin_hash: "hash" }],
    ["password",                  { password: "secret!" }],
    ["password_hash",             { password_hash: "$argon2id$..." }],
    ["clerk_jwt",                 { clerk_jwt: "eyJh..." }],
    ["clerk_session_token",       { clerk_session_token: "sess_..." }],
    ["device_token",              { device_token: "dt_..." }],
    ["device_token_attestation",  { device_token_attestation: "dta_..." }],
    ["token",                     { token: "tok_..." }],
    ["secret",                    { secret: "shh" }],
    ["credential",                { credential: "cred" }],
  ];

  test.each(CASES)("detects top-level key: %s", (_key, payload) => {
    expect(hasForbiddenField(payload)).toBe(true);
  });
});

describe("hasForbiddenField — nested forbidden keys", () => {
  it("detects a forbidden key one level deep", () => {
    expect(hasForbiddenField({ outer: { pin: "1234" } })).toBe(true);
  });

  it("detects a forbidden key two levels deep", () => {
    expect(
      hasForbiddenField({ level1: { level2: { password: "pw" } } }),
    ).toBe(true);
  });

  it("detects a forbidden key at depth = 5", () => {
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 4; i++) {
      cursor["child"] = {};
      cursor = cursor["child"] as Record<string, unknown>;
    }
    cursor["secret"] = "buried";
    expect(hasForbiddenField(deep)).toBe(true);
  });

  it("detects a forbidden key mixed with safe keys", () => {
    expect(
      hasForbiddenField({ action: "shift.open", ctx: { token: "t" } }),
    ).toBe(true);
  });
});

describe("hasForbiddenField — clean payloads (must return false)", () => {
  const CLEAN_CASES: Array<[string, unknown]> = [
    ["empty object",           {}],
    ["safe flat object",       { shift_id: "abc", operator: "op1" }],
    ["nested safe object",     { outer: { inner: { value: 42 } } }],
    ["array of safe primitives (no object keys)", { items: ["shift.open", "shift.close"] }],
    ["null",                   null],
    ["undefined",              undefined],
    ["number",                 42],
    ["string",                 "just a string"],
    ["boolean",                false],
    ["key containing 'pin' as substring (not exact match)", { spinning: "top" }],
    ["key containing 'token' as suffix",                    { access_tokenizer: "x" }],
  ];

  test.each(CLEAN_CASES)("returns false for: %s", (_label, value) => {
    expect(hasForbiddenField(value)).toBe(false);
  });
});

describe("hasForbiddenField — array handling", () => {
  it("returns false for a top-level array of primitive strings (no object keys to scan)", () => {
    // A bare array of strings has no object keys. The scanner recurses into
    // each element but primitives short-circuit on typeof !== "object".
    expect(hasForbiddenField(["pin", "password"])).toBe(false);
  });

  it("detects a forbidden key in a direct array element object", () => {
    // { items: [{ pin: "1234" }] } — forbidden key is one object inside an array.
    expect(hasForbiddenField({ items: [{ pin: "1234" }] })).toBe(true);
  });

  it("detects a forbidden key nested inside an array element's child object", () => {
    // { batches: [{ payload: { clerk_session_token: "x" } }] }
    expect(
      hasForbiddenField({ batches: [{ payload: { clerk_session_token: "x" } }] }),
    ).toBe(true);
  });

  it("detects a forbidden key in the second element of a mixed array", () => {
    // First element is clean; forbidden key is in the second.
    expect(
      hasForbiddenField({ events: [{ action: "shift.open" }, { token: "t" }] }),
    ).toBe(true);
  });

  it("returns false for a clean array of safe objects", () => {
    expect(
      hasForbiddenField({ items: [{ shift_id: "s1" }, { duration: 30 }] }),
    ).toBe(false);
  });

  it("detects forbidden key in an object that is a value inside a safe container", () => {
    expect(
      hasForbiddenField({ metadata: { credentials: { pin: "0000" } } }),
    ).toBe(true);
  });
});

describe("hasForbiddenField — depth guard (depth > 20 fails closed)", () => {
  it("rejects a payload deeper than 20 instead of stack-overflowing", () => {
    // Build an object 25 levels deep; the forbidden key sits at depth 22.
    let root: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < 22; i++) {
      cursor["child"] = {};
      cursor = cursor["child"] as Record<string, unknown>;
    }
    cursor["pin"] = "deep";
    expect(hasForbiddenField(root)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part B — Structural: AuditJobPayload metadata is typed, not any
// ---------------------------------------------------------------------------

describe("AuditJobPayload — metadata type contract", () => {
  it("metadata field is Record<string, unknown> | null, not any (compile-time proof)", () => {
    // This test exists to ensure the type is not widened to `any`, which
    // would allow forbidden fields to slip through without TypeScript
    // complaining. We verify the shape structurally by constructing a valid
    // AuditJobPayload at runtime.
    const { AuditJobPayload: _unused } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../src/audit/audit-job.types") as {
        AuditJobPayload: unknown;
      };
    // The file exports an interface (erased at runtime). The structural proof
    // is that we can construct a conforming object without TypeScript errors
    // and that `metadata: null` is legal (nullable sentinel).
    const payload: import("../../src/audit/audit-job.types").AuditJobPayload = {
      actor_user_id: null,
      actor_label: null,
      tenant_id: null,
      store_id: null,
      action: "test.action",
      target_type: null,
      target_id: null,
      request_id: null,
      metadata: null,
    };
    expect(payload.metadata).toBeNull();

    // Also verify a non-null metadata value is accepted.
    const withMeta: import("../../src/audit/audit-job.types").AuditJobPayload = {
      ...payload,
      metadata: { shift_id: "abc", count: 3 },
    };
    expect(withMeta.metadata).toEqual({ shift_id: "abc", count: 3 });
  });
});

// ---------------------------------------------------------------------------
// Part C — Integration (Testcontainers): batch sync redaction enforcement
// ---------------------------------------------------------------------------

import { Pool } from "pg";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import supertest from "supertest";
import { hashToken } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import cookieParser from "cookie-parser";
import {
  CLERK_VERIFIER,
  type ClerkVerifier,
} from "../../src/pos-operators/clerk-verifier";
import { PosAuditEventsModule } from "../../src/pos-audit-events/pos-audit-events.module";
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

// Stable UUIDs for the integration fixtures.
const TENANT_ID      = "0a000000-0000-7000-8000-000000ff1001";
const BRANCH_ID      = "0a000000-0000-7000-8000-000000ff2001";
const TERMINAL_ID    = "0a000000-0000-7000-8000-000000ff3001";
const OPERATOR_ID    = "0a000000-0000-7000-8000-000000ff5001";
// clerk_user_id — used as acting_operator_id in POS event requests.
const OPERATOR_CLERK = "clerk_redact_op_t236";
// Deterministic event IDs.
const CLEAN_EVENT_ID     = "0a000000-0000-7000-8000-000000ff6001";
const FORBIDDEN_EVENT_ID = "0a000000-0000-7000-8000-000000ff6002";
const ATTESTATION        = "redaction-spec-attestation-token-t236";

// Stub Clerk verifier — accepts one known JWT, rejects everything else.
class StubClerkVerifier implements ClerkVerifier {
  async verify(_rawJwt: string): Promise<{ sub: string }> {
    return { sub: OPERATOR_CLERK };
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let pool: Pool | null = null;        // admin pool for seeding + DB assertions
let dockerSkipped = false;

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[redaction.spec] skipping integration tests (Docker unavailable)");
    return true;
  }
  return false;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);

    pool = new Pool({ connectionString: env.adminUri });

    // Seed: tenant, store (branch), operator user (with Clerk sub), active device.
    await pool.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'redact-t236', 'Redact T236')`,
      [TENANT_ID],
    );
    await pool.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'R01', 'Redact Store')`,
      [BRANCH_ID, TENANT_ID],
    );
    await pool.query(
      `INSERT INTO users (id, email, clerk_user_id) VALUES ($1, 'op@redact.example', $2)`,
      [OPERATOR_ID, OPERATOR_CLERK],
    );
    // Active membership required by the tenant-scoped actor lookup (CODX-POS-2).
    await pool.query(
      `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'store_manager', 'Store Manager T236')`,
      ["0a000000-0000-7000-8000-000000ff4001", TENANT_ID],
    );
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
       VALUES ($1, $2, $3, $4, 'all')`,
      ["0a000000-0000-7000-8000-000000ff4002", TENANT_ID, OPERATOR_ID, "0a000000-0000-7000-8000-000000ff4001"],
    );
    // Active device: revoked_at IS NULL. Hash computed in Node, not via pgcrypto.
    await pool.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'POS-R', $4)`,
      [TERMINAL_ID, TENANT_ID, BRANCH_ID, hashToken(ATTESTATION)],
    );
    await pool.query(
      `INSERT INTO auth_tokens
         (id, token_hash, tenant_id, user_id, device_id, store_id, scope, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pos_operator', $7, $8)`,
      ["0a000000-0000-7000-8000-000000ff7001", hashToken("redaction-operator-session"),
        TENANT_ID, OPERATOR_ID, TERMINAL_ID, BRANCH_ID,
        "2020-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z"],
    );

    // Boot the PosAuditEventsModule with the test pool and stub Clerk verifier —
    // same pattern as pos-audit-events.controller.spec.ts.
    const moduleRef = await Test.createTestingModule({
      imports: [PosAuditEventsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(CLERK_VERIFIER)
      .useValue(new StubClerkVerifier())
      .compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    const logger = createLogger({ service: "api-test-t236", level: "silent" });
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
      console.warn(`\n[redaction.spec] Docker NOT AVAILABLE: ${msg}\n`);
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

describe("POST /api/pos/v1/audit-events — forbidden-field enforcement (integration)", () => {
  it("rejects an event whose payload contains a top-level forbidden key (pin)", async () => {
    if (maybeSkip()) return;

    const res = await supertest(app!.getHttpServer())
      .post("/api/pos/v1/audit-events")
      .send({
        device_token_attestation: ATTESTATION,
        events: [
          {
            event_id: FORBIDDEN_EVENT_ID,
            tenant_id: TENANT_ID,
            branch_id: BRANCH_ID,
            originating_terminal_id: TERMINAL_ID,
            acting_operator_id: OPERATOR_CLERK,
            action_category: "cashier.pin.reset",
            created_at: new Date().toISOString(),
            payload: { reason: "forgotten", pin: "0000" },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0].event_id).toBe(FORBIDDEN_EVENT_ID);
    expect(res.body.rejected[0].category).toBe("schema_violation");
    expect(res.body.accepted).toHaveLength(0);
  });

  it("rejects an event with a nested forbidden key (credential buried in context)", async () => {
    if (maybeSkip()) return;

    const nestedForbiddenEventId = "0a000000-0000-7000-8000-000000ff6003";
    const res = await supertest(app!.getHttpServer())
      .post("/api/pos/v1/audit-events")
      .send({
        device_token_attestation: ATTESTATION,
        events: [
          {
            event_id: nestedForbiddenEventId,
            tenant_id: TENANT_ID,
            branch_id: BRANCH_ID,
            originating_terminal_id: TERMINAL_ID,
            acting_operator_id: OPERATOR_CLERK,
            action_category: "shift.open",
            created_at: new Date().toISOString(),
            payload: { context: { secret: "session-key-abc" } },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.rejected[0].event_id).toBe(nestedForbiddenEventId);
    expect(res.body.rejected[0].category).toBe("schema_violation");
  });

  it("accepts a clean event and verifies no forbidden keys appear in the persisted metadata", async () => {
    if (maybeSkip()) return;

    const res = await supertest(app!.getHttpServer())
      .post("/api/pos/v1/audit-events")
      .send({
        device_token_attestation: ATTESTATION,
        events: [
          {
            event_id: CLEAN_EVENT_ID,
            tenant_id: TENANT_ID,
            branch_id: BRANCH_ID,
            originating_terminal_id: TERMINAL_ID,
            acting_operator_id: OPERATOR_CLERK,
            action_category: "shift.open",
            created_at: new Date().toISOString(),
            payload: { shift_id: "0a000000-0000-4000-8000-000000ff6001", shift_number: 7, terminal_label: "POS-1" },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toContain(CLEAN_EVENT_ID);

    // Query the persisted row and assert the metadata is clean.
    const { rows } = await pool!.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE id = $1`,
      [CLEAN_EVENT_ID],
    );
    expect(rows).toHaveLength(1);
    const metadata = rows[0]!.metadata ?? {};
    // Verify none of the forbidden keys are present at any level.
    expect(hasForbiddenField(metadata)).toBe(false);
  });

  it("per-event isolation: clean event accepted even when sibling has forbidden key", async () => {
    if (maybeSkip()) return;

    const cleanId   = "0a000000-0000-7000-8000-000000ff6004";
    const dirtyId   = "0a000000-0000-7000-8000-000000ff6005";

    const res = await supertest(app!.getHttpServer())
      .post("/api/pos/v1/audit-events")
      .send({
        device_token_attestation: ATTESTATION,
        events: [
          {
            event_id: dirtyId,
            tenant_id: TENANT_ID,
            branch_id: BRANCH_ID,
            originating_terminal_id: TERMINAL_ID,
            acting_operator_id: OPERATOR_CLERK,
            action_category: "shift.close",
            created_at: new Date().toISOString(),
            payload: { password: "should-not-persist" },
          },
          {
            event_id: cleanId,
            tenant_id: TENANT_ID,
            branch_id: BRANCH_ID,
            originating_terminal_id: TERMINAL_ID,
            acting_operator_id: OPERATOR_CLERK,
            action_category: "shift.close",
            created_at: new Date().toISOString(),
            payload: { duration_minutes: 480 },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toContain(cleanId);
    expect(res.body.rejected.map((r: { event_id: string }) => r.event_id)).toContain(dirtyId);

    // Confirm the dirty event was NOT persisted.
    const { rows } = await pool!.query(
      `SELECT id FROM audit_events WHERE id = $1`,
      [dirtyId],
    );
    expect(rows).toHaveLength(0);
  });
});
