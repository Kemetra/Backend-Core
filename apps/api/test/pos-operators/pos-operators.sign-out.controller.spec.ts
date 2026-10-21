/**
 * PosOperatorsController.signOut — integration spec.
 *
 * Real Postgres via Testcontainers (with both 0000 and 0001 migrations
 * applied). The Clerk verifier is overridden with a deterministic fake
 * (raw JWT string → Clerk subject) so no test traffic reaches Clerk.
 *
 * Coverage:
 *   - Happy path: a sign-in materializes an `auth_tokens` row; sign-out
 *     marks it `revoked_at IS NOT NULL` and returns
 *     `{ kind: "signed_out" }` exactly. No operator/session metadata
 *     leaks.
 *   - Idempotent-in-effect, NOT idempotent-in-response: a second sign-out
 *     with the same `session_id` returns the uniform 401 envelope, not
 *     `{ kind: "signed_out" }`. (This is what prevents the endpoint
 *     from becoming an existence oracle.)
 *   - Refusal taxonomy → uniform 401 envelope: missing Authorization,
 *     malformed bearer, unknown JWT, unmapped Clerk subject, soft-
 *     deleted user, unknown session_id, expired session, session
 *     belonging to a different operator, non-pos_operator scope row.
 *   - Body shape rejection (Zod): malformed UUID, missing session_id,
 *     forbidden extras (`password`, `pin`, `clerk_session_token`,
 *     `device_token_attestation`).
 *   - PR-5 sign-in remains unchanged.
 */
import "reflect-metadata";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { newId } from "@data-pulse-2/shared";
import { createLogger } from "@data-pulse-2/shared";
import cookieParser from "cookie-parser";
import { Pool } from "pg";
import request from "supertest";

import {
  OPERATOR_TOKEN_VERIFIER,
  type OperatorTokenVerifier,
} from "../../src/auth/operator-token-verifier";
import { PosOperatorsModule } from "../../src/pos-operators/pos-operators.module";
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
// Fixture identifiers — distinct from PR-5 fixtures so concurrent runs
// don't collide if both specs ever share state.
// -----------------------------------------------------------------------

const TENANT_ID = "0c000000-0000-4000-8000-000000000001";
const STORE_ID = "0c000000-0000-4000-8000-00000000aa01";
const STORE_ID_B = "0c000000-0000-4000-8000-00000000aa02";

const ADMIN_ROLE_ID = "0c000000-0000-4000-8000-00000000bb01";

const ADMIN_USER_ID = "0c000000-0000-4000-8000-00000000cc01";
const ADMIN_CLERK_SUB = "user_clerk_admin_pr6";
const OTHER_USER_ID = "0c000000-0000-4000-8000-00000000cc02";
const OTHER_CLERK_SUB = "user_clerk_other_pr6";
const DELETED_USER_ID = "0c000000-0000-4000-8000-00000000cc03";
const DELETED_CLERK_SUB = "user_clerk_deleted_pr6";

const ADMIN_MEMBERSHIP_ID = "0c000000-0000-4000-8000-00000000dd01";
const OTHER_MEMBERSHIP_ID = "0c000000-0000-4000-8000-00000000dd02";

const DEVICE_ID = "0c000000-0000-4000-8000-00000000ee01";
const DEVICE_ATTESTATION = "device-attestation-pr6";

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
    console.warn("[pos-operators.sign-out.controller.spec] skipping (Docker unavailable)");
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

/**
 * Seed an `auth_tokens` row directly so each test owns a distinct
 * session id and we can assert the row's `revoked_at` after.
 */
async function seedSession(opts: {
  id?: string;
  userId: string;
  scope?: string;
  revokedAt?: Date | null;
  expiresAt?: Date;
  storeId?: string;
}): Promise<string> {
  if (!pool) throw new Error("pool not initialized");
  const id = opts.id ?? newId();
  const tokenHash = hashToken(generateRawToken());
  const expiresAt =
    opts.expiresAt ?? new Date(Date.now() + 8 * 60 * 60 * 1000);
  const scope = opts.scope ?? "pos_operator";
  // CHECK auth_tokens_principal_by_scope (migration 0001):
  //   pos_operator      → user_id AND device_id both required
  //   any other scope   → exactly one of user_id / device_id
  // The fixture seeds with user_id; for non-pos_operator scopes
  // device_id must be NULL to satisfy the constraint.
  const deviceId = scope === "pos_operator" ? DEVICE_ID : null;
  await pool.query(
    `INSERT INTO auth_tokens
       (id, token_hash, tenant_id, user_id, device_id, store_id,
        scope, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      tokenHash,
      TENANT_ID,
      opts.userId,
      deviceId,
      opts.storeId ?? STORE_ID,
      scope,
      expiresAt,
      opts.revokedAt ?? null,
    ],
  );
  return id;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });

    await pool.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'pr6-tenant', 'PR6 Tenant')`,
      [TENANT_ID],
    );
    await pool.query(
      `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'tenant_admin', 'Admin')`,
      [ADMIN_ROLE_ID, TENANT_ID],
    );
    await pool.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'STA', 'Store A')`,
      [STORE_ID, TENANT_ID],
    );
    await pool.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'STB', 'Store B')`,
      [STORE_ID_B, TENANT_ID],
    );
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
         ($1, 'admin@pr6.example', 'Admin User', $2),
         ($3, 'other@pr6.example', 'Other User', $4)`,
      [
        ADMIN_USER_ID, ADMIN_CLERK_SUB,
        OTHER_USER_ID, OTHER_CLERK_SUB,
      ],
    );
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id, deleted_at)
         VALUES ($1, 'deleted@pr6.example', 'Deleted', $2, now())`,
      [DELETED_USER_ID, DELETED_CLERK_SUB],
    );
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
         ($1, $2, $3, $4, 'all'),
         ($5, $2, $6, $4, 'all')`,
      [
        ADMIN_MEMBERSHIP_ID, TENANT_ID, ADMIN_USER_ID, ADMIN_ROLE_ID,
        OTHER_MEMBERSHIP_ID, OTHER_USER_ID,
      ],
    );
    await pool.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash)
         VALUES ($1, $2, $3, 'till-PR6', $4)`,
      [DEVICE_ID, TENANT_ID, STORE_ID, hashToken(DEVICE_ATTESTATION)],
    );

    const verifierMap = new Map<string, string>([
      ["jwt-admin",    ADMIN_CLERK_SUB],
      ["jwt-other",    OTHER_CLERK_SUB],
      ["jwt-deleted",  DELETED_CLERK_SUB],
      ["jwt-unmapped", "user_clerk_unmapped_pr6"],
    ]);

    const moduleRef = await Test.createTestingModule({
      imports: [PosOperatorsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(OPERATOR_TOKEN_VERIFIER)
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
      console.warn(`\n[pos-operators.sign-out.controller.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
      .query(`DELETE FROM auth_tokens WHERE scope = 'pos_operator' OR scope = 'dashboard_api'`)
      .catch(() => undefined);
  }
});

// -----------------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/operators/sign-out (happy path)", () => {
  it("revokes the session and returns exactly { kind: 'signed_out' }", async () => {
    if (maybeSkip()) return;
    const sessionId = await seedSession({ userId: ADMIN_USER_ID });

    const res = await http()
      .post("/api/pos/v1/operators/sign-out")
      .set("Authorization", "Bearer jwt-admin")
      .send({ session_id: sessionId });

    expect(res.status).toBe(200);
    // Body is EXACTLY { kind: "signed_out" } — no operator, no session_id,
    // no timestamps, no tenant/store metadata.
    expect(res.body).toEqual({ kind: "signed_out" });
    expect(Object.keys(res.body)).toEqual(["kind"]);

    // The auth_tokens row is now revoked.
    const r = await pool!.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM auth_tokens WHERE id = $1`,
      [sessionId],
    );
    expect(r.rows[0]!.revoked_at).not.toBeNull();
  });
});

// -----------------------------------------------------------------------
// Idempotent-in-effect, NOT idempotent-in-response
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/operators/sign-out (double sign-out)", () => {
  it("a second sign-out with the same session_id returns the uniform 401, not signed_out", async () => {
    if (maybeSkip()) return;
    const sessionId = await seedSession({ userId: ADMIN_USER_ID });

    const first = await http()
      .post("/api/pos/v1/operators/sign-out")
      .set("Authorization", "Bearer jwt-admin")
      .send({ session_id: sessionId });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ kind: "signed_out" });

    const second = await http()
      .post("/api/pos/v1/operators/sign-out")
      .set("Authorization", "Bearer jwt-admin")
      .send({ session_id: sessionId });
    expect(second.status).toBe(401);
    expectErrorEnvelope(second.body, "unauthorized");
  });
});

// -----------------------------------------------------------------------
// Refusals — uniform 401 envelope
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/operators/sign-out (refusals → 401)", () => {
  it("missing Authorization header → 401", async () => {
    if (maybeSkip()) return;
    const sessionId = await seedSession({ userId: ADMIN_USER_ID });
    const res = await http()
      .post("/api/pos/v1/operators/sign-out")
      .send({ session_id: sessionId });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it.each([
    ["malformed bearer (wrong scheme)", "Basic abc", ADMIN_USER_ID],
    ["verifier rejects (unknown JWT)", "Bearer not-in-stub-map", ADMIN_USER_ID],
    ["Clerk subject not mapped to a local user", "Bearer jwt-unmapped", ADMIN_USER_ID],
    ["soft-deleted user", "Bearer jwt-deleted", DELETED_USER_ID],
  ])("%s → 401", async (_label, authorization, userId) => {
    if (maybeSkip()) return;
    const sessionId = await seedSession({ userId });
    const res = await http()
      .post("/api/pos/v1/operators/sign-out")
      .set("Authorization", authorization)
      .send({ session_id: sessionId });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("unknown session_id (well-formed UUID, no row) → 401", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/operators/sign-out")
      .set("Authorization", "Bearer jwt-admin")
      .send({ session_id: "00000000-0000-4000-8000-0000deadbeef" });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("session belongs to a different operator → 401, target session NOT revoked", async () => {
    if (maybeSkip()) return;
    // Session belongs to OTHER, but admin attempts to sign it out.
    const otherSessionId = await seedSession({ userId: OTHER_USER_ID });
    const res = await http()
      .post("/api/pos/v1/operators/sign-out")
      .set("Authorization", "Bearer jwt-admin")
      .send({ session_id: otherSessionId });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");

    // The other user's session must still be active.
    const r = await pool!.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM auth_tokens WHERE id = $1`,
      [otherSessionId],
    );
    expect(r.rows[0]!.revoked_at).toBeNull();
  });

  it("expired session → 401", async () => {
    if (maybeSkip()) return;
    const sessionId = await seedSession({
      userId: ADMIN_USER_ID,
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    const res = await http()
      .post("/api/pos/v1/operators/sign-out")
      .set("Authorization", "Bearer jwt-admin")
      .send({ session_id: sessionId });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("non-pos_operator scope (dashboard_api) → 401", async () => {
    if (maybeSkip()) return;
    const sessionId = await seedSession({
      userId: ADMIN_USER_ID,
      scope: "dashboard_api",
    });
    const res = await http()
      .post("/api/pos/v1/operators/sign-out")
      .set("Authorization", "Bearer jwt-admin")
      .send({ session_id: sessionId });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");

    // The dashboard_api token must not be revoked by a POS sign-out.
    const r = await pool!.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM auth_tokens WHERE id = $1`,
      [sessionId],
    );
    expect(r.rows[0]!.revoked_at).toBeNull();
  });

  it("uniform 401 body never enumerates the cause", async () => {
    if (maybeSkip()) return;
    const sessionId = await seedSession({ userId: OTHER_USER_ID });
    const res = await http()
      .post("/api/pos/v1/operators/sign-out")
      .set("Authorization", "Bearer jwt-admin")
      .send({ session_id: sessionId });
    expect(res.status).toBe(401);
    // No mention of jwt / clerk / device / membership / role / tenant / store
    expect(JSON.stringify(res.body)).not.toMatch(
      /jwt|clerk|device|membership|role|tenant|store_access|expired|revoked/i,
    );
  });
});

// -----------------------------------------------------------------------
// Body validation — 400 (Zod / OpenAPI additionalProperties:false)
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/operators/sign-out (body validation → 400)", () => {
  it("missing session_id → 400 validation_error", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/operators/sign-out")
      .set("Authorization", "Bearer jwt-admin")
      .send({});
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  it("non-UUID session_id → 400 validation_error", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/operators/sign-out")
      .set("Authorization", "Bearer jwt-admin")
      .send({ session_id: "not-a-uuid" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });

  const FORBIDDEN_EXTRAS: Array<[string, Record<string, unknown>]> = [
    ["password",                 { password: "anything" }],
    ["pin",                      { pin: "1234" }],
    ["cashier",                  { cashier: "yes" }],
    ["clerk_session_token",      { clerk_session_token: "leaked" }],
    ["device_token_attestation", { device_token_attestation: "leaked" }],
    ["branch_id",                { branch_id: STORE_ID }],
  ];

  for (const [label, extra] of FORBIDDEN_EXTRAS) {
    it(`rejects body with extra '${label}' as 400 validation_error`, async () => {
      if (maybeSkip()) return;
      const sessionId = "00000000-0000-4000-8000-0000deadbeef";
      const res = await http()
        .post("/api/pos/v1/operators/sign-out")
        .set("Authorization", "Bearer jwt-admin")
        .send({ session_id: sessionId, ...extra });
      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, "validation_error");
    });
  }
});

// -----------------------------------------------------------------------
// Cross-store behavior (same user, different store) — documents intent
// -----------------------------------------------------------------------

describe("POST /api/pos/v1/operators/sign-out (same-user cross-store)", () => {
  it("same user can revoke a session bound to a different store (design: no branch_id in body)", async () => {
    if (maybeSkip()) return;
    // The sign-out body carries only `session_id` — no branch attestation.
    // A session seeded against STORE_ID_B is owned by the same user, so
    // `user_id = $2` in the UPDATE matches and the revocation succeeds.
    // This is intentional: re-attestation via branch_id is out-of-scope for
    // this slice (see CODX-POS-1 P2 tracking item).
    const sessionId = await seedSession({ userId: ADMIN_USER_ID, storeId: STORE_ID_B });

    const res = await http()
      .post("/api/pos/v1/operators/sign-out")
      .set("Authorization", "Bearer jwt-admin")
      .send({ session_id: sessionId });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "signed_out" });

    const r = await pool!.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM auth_tokens WHERE id = $1`,
      [sessionId],
    );
    expect(r.rows[0]!.revoked_at).not.toBeNull();
  });
});
