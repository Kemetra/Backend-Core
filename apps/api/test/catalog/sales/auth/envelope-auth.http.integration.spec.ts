/**
 * envelope-auth.http.integration.spec.ts — #560 full HTTP-stack envelope auth.
 *
 * Drives REAL sale requests through the REAL `PosOperatorEnvelopeSaleGuard`
 * chain end-to-end (guard → controller → request.context → SalesService →
 * Postgres under RLS). Nothing on the auth path is overridden or no-op'd:
 *
 *   - The envelope is obtained from the REAL operator sign-in route
 *     (`POST /api/pos/v1/operators/sign-in` → PosOperatorsService
 *     .issueOperatorSessionRow), i.e. a genuine `auth_tokens` `pos_operator`
 *     row whose raw token is returned as `operator_session.envelope`. Only the
 *     Clerk JWKS verification is stubbed (raw JWT string → Clerk subject), as in
 *     pos-operators.controller.spec.
 *   - The testing module imports the production `SalesModule` (and
 *     `PosOperatorsModule`), so Nest DI bootstraps the guard through its real
 *     factory (inject: [SessionRepository, AuthTokenRepository,
 *     OPERATOR_CONTEXT_RESOLVER]) and the class-referenced
 *     PosWriteRateLimitGuard. No overrideGuard anywhere.
 *   - NO global context guard: `request.context` must be published by the
 *     envelope guard itself. PR #559's regression (the guard swap dropped
 *     `request.context`) would make every sale below 401 — the capture harness
 *     missed it because it no-ops the guard and injects context globally.
 *
 * Pool split (mirrors production AuthModule wiring):
 *   - AUTH_LOOKUP_POOL → env.admin (RLS-exempt): AuthTokenRepository
 *     .findActiveByRawToken runs with NO tenant GUC, as do the reverifier's
 *     device / membership / store-access lookups. Wiring these on the
 *     RLS-enforced app pool would filter the token row → every request 401s.
 *   - PG_POOL → env.app (non-superuser `app_test`, RLS-enforced): the sale
 *     WRITE runs under the tenant GUC, so tenant isolation is real.
 *
 * Coverage:
 *   - Happy path: capture / void / refund → 201; persisted rows carry the
 *     device's (tenant_id, store_id) and created_by = the operator's users.id;
 *     the audit payload's actor_user_id is the real operator; the sale is
 *     visible under its own tenant GUC and invisible under another tenant's.
 *   - Layer 1: missing / unknown envelope → 401.
 *   - G-4 end-to-end: after a successful sale, a mid-session revocation of
 *     (a) membership, (b) device, (c) store-access → 401 on the NEXT
 *     capture / void / refund, while the auth_tokens row itself is still
 *     active (so the refusal is the live predicate, not the token check).
 *
 * NOTE: CI runs Testcontainers (ci.yml db-integration; never sets
 * MIGRATION_TEST_ALLOW_SKIP). Locally without Docker this suite skips when
 * MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import cookieParser from "cookie-parser";
import request from "supertest";

import { AUTH_LOOKUP_POOL, PG_POOL } from "../../../../src/auth/auth.module";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { LoggingInterceptor } from "../../../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../../../src/common/zod-validation.pipe";
import { SalesModule } from "../../../../src/catalog/sales/sales.module";
import {
  CLERK_VERIFIER,
  type ClerkVerifier,
} from "../../../../src/pos-operators/clerk-verifier";
import { PosOperatorsModule } from "../../../../src/pos-operators/pos-operators.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";

// No real Redis/BullMQ in this suite: AuthModule falls back to AlwaysAllowRedis
// (rate limit + idempotency stubs) and the audit enqueuer is spied below.
delete process.env["REDIS_URL"];

const TENANT_ID = "0e000000-0000-4000-8000-000000000001";
const TENANT_OTHER_ID = "0e000000-0000-4000-8000-000000000002";
const STORE_ID = "0e000000-0000-4000-8000-00000000aa01";
const MANAGER_ROLE_ID = "0e000000-0000-4000-8000-00000000bb01";
const OPERATOR_USER_ID = "0e000000-0000-4000-8000-00000000cc01";
const OPERATOR_CLERK_SUB = "user_clerk_envelope_http_560";
const OPERATOR_MEMBERSHIP_ID = "0e000000-0000-4000-8000-00000000dd01";
const DEVICE_ID = "0e000000-0000-4000-8000-00000000ee01";
const DEVICE_ATTESTATION = "device-attestation-envelope-http-560";
const OPERATOR_JWT = "jwt-envelope-operator";

class StubClerkVerifier implements ClerkVerifier {
  async verify(rawJwt: string): Promise<{ sub: string }> {
    if (rawJwt !== OPERATOR_JWT) throw new Error("StubClerkVerifier: unknown jwt");
    return { sub: OPERATOR_CLERK_SUB };
  }
}

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  readonly payloads: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.payloads.push(payload);
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
const audit = new SpyAuditEnqueuer();

function E(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
function http(): ReturnType<typeof request> {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}
function skip(): boolean {
  return dockerSkipped;
}

/** A fresh 32-char ASCII Idempotency-Key per request. */
function idemKey(): string {
  return randomUUID().replace(/-/g, "");
}

let extSeq = 0;
function ext(prefix: string): string {
  extSeq += 1;
  return `${prefix}-${extSeq}`;
}

function captureBody(externalId: string): Record<string, unknown> {
  return {
    sourceSystem: "pos-env-560",
    externalId,
    currencyCode: "USD",
    posTotal: "12.5000",
    occurredAt: "2026-05-01T10:00:00.000Z",
    lines: [
      {
        lineName: "Widget",
        unitPrice: "5.0000",
        currencyCode: "USD",
        quantity: "1",
        lineAmount: "5.0000",
        unit: "ea",
      },
      {
        lineName: "Gadget",
        unitPrice: "7.5000",
        currencyCode: "USD",
        quantity: "1",
        lineAmount: "7.5000",
        unit: "ea",
      },
    ],
  };
}

/** Real operator sign-in → the raw envelope (auth_tokens pos_operator row). */
async function signIn(): Promise<string> {
  const res = await http()
    .post("/api/pos/v1/operators/sign-in")
    .set("Authorization", `Bearer ${OPERATOR_JWT}`)
    .send({ kind: "manager_admin", device_token_attestation: DEVICE_ATTESTATION });
  expect(res.status).toBe(200);
  expect(res.body.kind).toBe("signed_in");
  const envelope: unknown = res.body.operator_session?.envelope;
  expect(typeof envelope).toBe("string");
  return envelope as string;
}

function capture(envelope: string | null, externalId: string): request.Test {
  const req = http().post("/api/pos/v1/sales").set("Idempotency-Key", idemKey());
  if (envelope !== null) req.set("Authorization", `Bearer ${envelope}`);
  return req.send(captureBody(externalId));
}

function voidSale(envelope: string, saleRef: string, externalId: string): request.Test {
  return http()
    .post(`/api/pos/v1/sales/${saleRef}/void`)
    .set("Idempotency-Key", idemKey())
    .set("Authorization", `Bearer ${envelope}`)
    .send({ sourceSystem: "pos-env-560", externalId });
}

function refundSale(envelope: string, saleRef: string, externalId: string): request.Test {
  return http()
    .post(`/api/pos/v1/sales/${saleRef}/refund`)
    .set("Idempotency-Key", idemKey())
    .set("Authorization", `Bearer ${envelope}`)
    .send({
      sourceSystem: "pos-env-560",
      externalId,
      posRefundAmount: "5.0000",
      currencyCode: "USD",
    });
}

async function expectAllSaleRoutes401(envelope: string, saleRef: string): Promise<void> {
  const cap = await capture(envelope, ext("cap-after-revoke"));
  expect(cap.status).toBe(401);
  const v = await voidSale(envelope, saleRef, ext("void-after-revoke"));
  expect(v.status).toBe(401);
  const r = await refundSale(envelope, saleRef, ext("refund-after-revoke"));
  expect(r.status).toBe(401);
}

/** The envelope's auth_tokens row must still be live — so a 401 is G-4, not layer 1. */
async function expectEnvelopeRowStillActive(envelope: string): Promise<void> {
  const r = await E().admin.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM auth_tokens
      WHERE token_hash = $1 AND scope = 'pos_operator'
        AND revoked_at IS NULL AND expires_at > now()`,
    [hashToken(envelope)],
  );
  expect(r.rows[0]?.n).toBe("1");
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[envelope-auth.http.integration.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  const admin = env.admin;
  await admin.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'env560-tenant', 'Envelope 560 Tenant'),
       ($2, 'env560-other',  'Envelope 560 Other')`,
    [TENANT_ID, TENANT_OTHER_ID],
  );
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'store_manager', 'Manager')`,
    [MANAGER_ROLE_ID, TENANT_ID],
  );
  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'ENV', 'Envelope Store')`,
    [STORE_ID, TENANT_ID],
  );
  await admin.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id)
       VALUES ($1, 'operator@env560.example', 'Env Operator', $2)`,
    [OPERATOR_USER_ID, OPERATOR_CLERK_SUB],
  );
  // 'specific' access with an explicit grant for the device store, so the
  // store-access axis of G-4 is revocable (DELETE the grant).
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
       VALUES ($1, $2, $3, $4, 'specific')`,
    [OPERATOR_MEMBERSHIP_ID, TENANT_ID, OPERATOR_USER_ID, MANAGER_ROLE_ID],
  );
  await admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`,
    [OPERATOR_MEMBERSHIP_ID, STORE_ID, TENANT_ID],
  );
  await admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash)
       VALUES ($1, $2, $3, 'till-env560', $4)`,
    [DEVICE_ID, TENANT_ID, STORE_ID, hashToken(DEVICE_ATTESTATION)],
  );

  // Real production modules; only external seams (pools, Clerk JWKS, audit
  // fan-out) are substituted. The auth path is fully real.
  const moduleRef = await Test.createTestingModule({
    imports: [PosOperatorsModule, SalesModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(env.app)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(env.admin)
    .overrideProvider(CLERK_VERIFIER)
    .useValue(new StubClerkVerifier())
    .overrideProvider(AUDIT_JOB_ENQUEUER)
    .useValue(audit)
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.use(cookieParser());
  const logger = createLogger({ service: "api-test", level: "silent" });
  app.useGlobalInterceptors(new RequestIdInterceptor(), new LoggingInterceptor(logger));
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ZodValidationPipe());
  // Deliberately NO app.useGlobalGuards(...) — request.context must come from
  // PosOperatorEnvelopeSaleGuard alone.
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (!env) return;
  // Restore every G-4 axis and drop operator sessions (one-live-session
  // invariant: a leftover token would make the next sign-in takeover_required).
  await env.admin.query(`UPDATE memberships SET revoked_at = NULL WHERE id = $1`, [
    OPERATOR_MEMBERSHIP_ID,
  ]);
  await env.admin.query(`UPDATE devices SET revoked_at = NULL WHERE id = $1`, [DEVICE_ID]);
  await env.admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
    [OPERATOR_MEMBERSHIP_ID, STORE_ID, TENANT_ID],
  );
  await env.admin.query(`DELETE FROM auth_tokens WHERE scope = 'pos_operator'`);
  audit.payloads.length = 0;
});

describe("#560 envelope auth — happy path through the real guard chain", () => {
  it("capture / void / refund → 201 with the device scope and the real operator as actor", async () => {
    if (skip()) return;
    const envelope = await signIn();

    // --- captureSale ---------------------------------------------------
    const capA = await capture(envelope, ext("cap-happy-a"));
    expect(capA.status).toBe(201);
    expect(capA.body.storeId).toBe(STORE_ID);
    const saleA: string = capA.body.saleRef;

    const capB = await capture(envelope, ext("cap-happy-b"));
    expect(capB.status).toBe(201);
    const saleB: string = capB.body.saleRef;

    const sales = await E().admin.query<{ tenant_id: string; store_id: string; created_by: string }>(
      `SELECT tenant_id, store_id, created_by FROM sales WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[saleA, saleB]],
    );
    expect(sales.rows).toHaveLength(2);
    for (const row of sales.rows) {
      expect(row).toEqual({ tenant_id: TENANT_ID, store_id: STORE_ID, created_by: OPERATOR_USER_ID });
    }

    // --- recordVoid ----------------------------------------------------
    const v = await voidSale(envelope, saleA, ext("void-happy"));
    expect(v.status).toBe(201);
    expect(v.body.kind).toBe("void");
    expect(v.body.saleRef).toBe(saleA);
    const voidRow = await E().admin.query<{ tenant_id: string; store_id: string; created_by: string }>(
      `SELECT tenant_id, store_id, created_by FROM sale_voids WHERE id = $1`,
      [v.body.eventRef],
    );
    expect(voidRow.rows[0]).toEqual({
      tenant_id: TENANT_ID,
      store_id: STORE_ID,
      created_by: OPERATOR_USER_ID,
    });

    // --- recordRefund --------------------------------------------------
    const r = await refundSale(envelope, saleB, ext("refund-happy"));
    expect(r.status).toBe(201);
    expect(r.body.kind).toBe("refund");
    expect(r.body.saleRef).toBe(saleB);
    const refundRow = await E().admin.query<{ tenant_id: string; store_id: string; created_by: string }>(
      `SELECT tenant_id, store_id, created_by FROM sale_refunds WHERE id = $1`,
      [r.body.eventRef],
    );
    expect(refundRow.rows[0]).toEqual({
      tenant_id: TENANT_ID,
      store_id: STORE_ID,
      created_by: OPERATOR_USER_ID,
    });

    // --- provenance (G-5): audit actor is the real operator ------------
    const actions = audit.payloads.map((p) => p.action).sort();
    expect(actions).toEqual(["sale.captured", "sale.captured", "sale.refunded", "sale.voided"]);
    for (const p of audit.payloads) {
      expect(p.actor_user_id).toBe(OPERATOR_USER_ID);
      expect(p.tenant_id).toBe(TENANT_ID);
      expect(p.store_id).toBe(STORE_ID);
    }
  });

  it("the sale was written under RLS: visible to its own tenant GUC, invisible to another tenant", async () => {
    if (skip()) return;
    const envelope = await signIn();
    const cap = await capture(envelope, ext("cap-rls"));
    expect(cap.status).toBe(201);
    const saleRef: string = cap.body.saleRef;

    async function visibleAs(tenantId: string): Promise<number> {
      const client = await E().app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
        await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
        const r = await client.query(`SELECT id FROM sales WHERE id = $1`, [saleRef]);
        await client.query("COMMIT");
        return r.rowCount ?? 0;
      } finally {
        client.release();
      }
    }
    expect(await visibleAs(TENANT_ID)).toBe(1);
    expect(await visibleAs(TENANT_OTHER_ID)).toBe(0);
  });
});

describe("#560 envelope auth — layer 1 (canonical bearer) refusals", () => {
  it("no Authorization header → 401", async () => {
    if (skip()) return;
    const res = await capture(null, ext("cap-no-auth"));
    expect(res.status).toBe(401);
  });

  it("unknown envelope → 401", async () => {
    if (skip()) return;
    const res = await capture("not-a-real-envelope-560", ext("cap-bad-auth"));
    expect(res.status).toBe(401);
  });

  it("the Clerk JWT itself is not a sale credential → 401", async () => {
    if (skip()) return;
    const res = await capture(OPERATOR_JWT, ext("cap-jwt-auth"));
    expect(res.status).toBe(401);
  });
});

describe("#560 envelope auth — G-4 live predicate: mid-session revocation → 401 on the next sale", () => {
  async function signInAndCapture(): Promise<{ envelope: string; saleRef: string }> {
    const envelope = await signIn();
    const cap = await capture(envelope, ext("cap-pre-revoke"));
    expect(cap.status).toBe(201);
    return { envelope, saleRef: cap.body.saleRef as string };
  }

  it("membership revoked → next capture / void / refund 401", async () => {
    if (skip()) return;
    const { envelope, saleRef } = await signInAndCapture();
    await E().admin.query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [
      OPERATOR_MEMBERSHIP_ID,
    ]);
    await expectEnvelopeRowStillActive(envelope);
    await expectAllSaleRoutes401(envelope, saleRef);
  });

  it("device revoked → next capture / void / refund 401", async () => {
    if (skip()) return;
    const { envelope, saleRef } = await signInAndCapture();
    await E().admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEVICE_ID]);
    await expectEnvelopeRowStillActive(envelope);
    await expectAllSaleRoutes401(envelope, saleRef);
  });

  it("store-access grant removed → next capture / void / refund 401", async () => {
    if (skip()) return;
    const { envelope, saleRef } = await signInAndCapture();
    await E().admin.query(
      `DELETE FROM store_access WHERE membership_id = $1 AND store_id = $2`,
      [OPERATOR_MEMBERSHIP_ID, STORE_ID],
    );
    await expectEnvelopeRowStillActive(envelope);
    await expectAllSaleRoutes401(envelope, saleRef);
  });

  it("restoring the revoked axis re-admits the same envelope (the 401 was the live predicate)", async () => {
    if (skip()) return;
    const { envelope } = await signInAndCapture();
    await E().admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEVICE_ID]);
    expect((await capture(envelope, ext("cap-while-revoked"))).status).toBe(401);
    await E().admin.query(`UPDATE devices SET revoked_at = NULL WHERE id = $1`, [DEVICE_ID]);
    expect((await capture(envelope, ext("cap-after-restore"))).status).toBe(201);
  });
});
