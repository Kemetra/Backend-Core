/**
 * pos-operator-live-reverify.http.integration.spec.ts — RT-137.
 *
 * The two POS operator-token routes that used to trust the 8h token alone —
 * `GET /api/pos/v1/sales/:saleRef` and `POST /api/pos/v1/catalog/unknown-items`
 * (both `PosOperatorAuthGuard` + `TenantContextGuard`) — now re-verify the
 * operator LIVE on every request, like the sale-write routes' envelope guard.
 *
 * Drives the REAL guard chain over HTTP (no overrideGuard): the envelope comes
 * from the real operator sign-in; only the pools, Clerk JWKS verification and
 * audit fan-out are substituted (same seams as envelope-auth.http.integration
 * .spec). After a successful call, a mid-session revocation of membership,
 * role eligibility, device or store access makes the NEXT call 401 while the
 * auth_tokens row is still active — so the refusal is the live check.
 *
 * Locally without Docker this suite skips when MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import cookieParser from "cookie-parser";
import request from "supertest";

import { AUTH_LOOKUP_POOL, PG_POOL } from "../../src/auth/auth.module";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../src/audit/audit-job.types";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { LoggingInterceptor } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { SalesModule } from "../../src/catalog/sales/sales.module";
import { UnknownItemsModule } from "../../src/catalog/unknown-items/unknown-items.module";
import {
  CLERK_VERIFIER,
  type ClerkVerifier,
} from "../../src/pos-operators/clerk-verifier";
import { PosOperatorsModule } from "../../src/pos-operators/pos-operators.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// No real Redis/BullMQ in this suite: AuthModule falls back to AlwaysAllowRedis
// (rate limit + idempotency stubs) and the audit enqueuer is spied below.
delete process.env["REDIS_URL"];

const TENANT_ID = "0e000000-0000-4000-8000-000001300001";

const STORE_ID = "0e000000-0000-4000-8000-00000130aa01";
const MANAGER_ROLE_ID = "0e000000-0000-4000-8000-00000130bb01";
const CASHIER_ROLE_ID = "0e000000-0000-4000-8000-00000130bb02";
const OPERATOR_USER_ID = "0e000000-0000-4000-8000-00000130cc01";
const OPERATOR_CLERK_SUB = "user_clerk_rt137_live_reverify";
const OPERATOR_MEMBERSHIP_ID = "0e000000-0000-4000-8000-00000130dd01";
const DEVICE_ID = "0e000000-0000-4000-8000-00000130ee01";
const DEVICE_ATTESTATION = "device-attestation-rt137";
const OPERATOR_JWT = "jwt-rt137-operator";

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

let seq = 0;
function next(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
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

/** A sale to read back, captured through the (already live-verified) write route. */
async function captureSale(envelope: string): Promise<string> {
  const res = await http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", idemKey())
    .set("Authorization", `Bearer ${envelope}`)
    .send({
      sourceSystem: "pos-rt137",
      externalId: next("rt137-sale"),
      currencyCode: "USD",
      posTotal: "5.0000",
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
      ],
    });
  expect(res.status).toBe(201);
  return res.body.saleRef as string;
}

function readSale(envelope: string, saleRef: string): request.Test {
  return http().get(`/api/pos/v1/sales/${saleRef}`).set("Authorization", `Bearer ${envelope}`);
}

function captureUnknownItem(envelope: string): request.Test {
  return http()
    .post("/api/pos/v1/catalog/unknown-items")
    .set("Idempotency-Key", idemKey())
    .set("Authorization", `Bearer ${envelope}`)
    .send({ identifier_type: "barcode", identifier_value: next("rt137-barcode") });
}

/** The envelope's auth_tokens row must still be live — so a 401 is the live check, not the token check. */
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
      console.warn(`\n[pos-operator-live-reverify.http.integration.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  const admin = env.admin;
  await admin.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt137-tenant', 'RT-137 Tenant')`,
    [TENANT_ID],
  );
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $3, 'store_manager', 'Manager'),
       ($2, $3, 'cashier', 'Cashier')`,
    [MANAGER_ROLE_ID, CASHIER_ROLE_ID, TENANT_ID],
  );
  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'R137', 'RT-137 Store')`,
    [STORE_ID, TENANT_ID],
  );
  await admin.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id)
       VALUES ($1, 'operator@rt137.example', 'RT-137 Operator', $2)`,
    [OPERATOR_USER_ID, OPERATOR_CLERK_SUB],
  );
  // 'specific' access with an explicit grant, so store access is revocable.
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
       VALUES ($1, $2, $3, 'till-rt137', $4)`,
    [DEVICE_ID, TENANT_ID, STORE_ID, hashToken(DEVICE_ATTESTATION)],
  );

  // Real production modules; only external seams (pools, Clerk JWKS, audit
  // fan-out) are substituted. PosOperatorAuthGuard is NOT overridden.
  const moduleRef = await Test.createTestingModule({
    imports: [PosOperatorsModule, SalesModule, UnknownItemsModule],
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
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (!env) return;
  // Restore every axis and drop operator sessions (one-live-session invariant).
  await env.admin.query(
    `UPDATE memberships SET revoked_at = NULL, role_id = $2 WHERE id = $1`,
    [OPERATOR_MEMBERSHIP_ID, MANAGER_ROLE_ID],
  );
  await env.admin.query(`UPDATE devices SET revoked_at = NULL WHERE id = $1`, [DEVICE_ID]);
  await env.admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
    [OPERATOR_MEMBERSHIP_ID, STORE_ID, TENANT_ID],
  );
  await env.admin.query(`DELETE FROM auth_tokens WHERE scope = 'pos_operator'`);
  audit.payloads.length = 0;
});

const revocations: ReadonlyArray<{ axis: string; revoke: () => Promise<unknown> }> = [
  {
    axis: "membership revoked",
    revoke: () =>
      E().admin.query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [
        OPERATOR_MEMBERSHIP_ID,
      ]),
  },
  {
    axis: "role no longer eligible",
    revoke: () =>
      E().admin.query(`UPDATE memberships SET role_id = $2 WHERE id = $1`, [
        OPERATOR_MEMBERSHIP_ID,
        CASHIER_ROLE_ID,
      ]),
  },
  {
    axis: "device revoked",
    revoke: () =>
      E().admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEVICE_ID]),
  },
  {
    axis: "store-access grant removed",
    revoke: () =>
      E().admin.query(`DELETE FROM store_access WHERE membership_id = $1 AND store_id = $2`, [
        OPERATOR_MEMBERSHIP_ID,
        STORE_ID,
      ]),
  },
];

describe("RT-137 — GET /api/pos/v1/sales/:saleRef re-verifies the operator live", () => {
  it("a live operator reads its sale", async () => {
    if (skip()) return;
    const envelope = await signIn();
    const saleRef = await captureSale(envelope);
    const res = await readSale(envelope, saleRef);
    expect(res.status).toBe(200);
    expect(res.body.saleRef).toBe(saleRef);
  });

  it.each(revocations)("$axis → next read 401 while the token row is still active", async ({ revoke }) => {
    if (skip()) return;
    const envelope = await signIn();
    const saleRef = await captureSale(envelope);
    expect((await readSale(envelope, saleRef)).status).toBe(200);

    await revoke();
    await expectEnvelopeRowStillActive(envelope);
    expect((await readSale(envelope, saleRef)).status).toBe(401);
  });
});

describe("RT-137 — POST /api/pos/v1/catalog/unknown-items re-verifies the operator live", () => {
  it("a live operator captures an unknown item", async () => {
    if (skip()) return;
    const envelope = await signIn();
    const res = await captureUnknownItem(envelope);
    expect(res.status).toBe(201);
    expect(res.body.unknown_item?.store_id).toBe(STORE_ID);
  });

  it.each(revocations)("$axis → next capture 401 and no row written", async ({ revoke }) => {
    if (skip()) return;
    const envelope = await signIn();
    expect((await captureUnknownItem(envelope)).status).toBe(201);

    await revoke();
    await expectEnvelopeRowStillActive(envelope);
    const before = await E().admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM unknown_items WHERE tenant_id = $1`,
      [TENANT_ID],
    );
    expect((await captureUnknownItem(envelope)).status).toBe(401);
    const after = await E().admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM unknown_items WHERE tenant_id = $1`,
      [TENANT_ID],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("restoring the revoked axis re-admits the same envelope (the 401 was the live check)", async () => {
    if (skip()) return;
    const envelope = await signIn();
    await E().admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEVICE_ID]);
    expect((await captureUnknownItem(envelope)).status).toBe(401);
    await E().admin.query(`UPDATE devices SET revoked_at = NULL WHERE id = $1`, [DEVICE_ID]);
    expect((await captureUnknownItem(envelope)).status).toBe(201);
  });
});
