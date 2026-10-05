/**
 * device-operator-capture.http.integration.spec.ts — RT-224 (Option B).
 *
 * captureSale accepts, as an alternative to the operator envelope, the paired
 * terminal's DEVICE bearer plus the cashier's `operatorUserId` in the body
 * (sales.yaml 1.5.0-draft; [GATED] approval Jira RT-224 comment 10889). The
 * server accepts the claimed cashier only when:
 *
 *   - the device is active and its tenant is active (PosDeviceAuthGuard,
 *     RT-213); the device row supplies tenant, store and device;
 *   - a cashier_admissions row of that tenant, store, device and user has a
 *     window covering occurredAt:
 *       created_at <= occurredAt < LEAST(ended_at, expires_at)
 *     (an ended or expired admission still covers its own window);
 *   - the RT-113 BC2 cashier eligibility rules hold LIVE (membership active,
 *     user not deleted, cashier role, store active and accessible).
 *
 * The cashier then becomes `created_by` and the audit actor. Every refusal is
 * the same generic 401 as an invalid envelope.
 *
 * Wiring mirrors production: the real SalesModule, PosOperatorsModule and
 * CashierAdmissionsModule; AUTH_LOOKUP_POOL = the RLS-exempt admin pool,
 * PG_POOL = the NOBYPASSRLS `app_test` role; and the GLOBAL
 * FailClosedAuthGuard, so the route's @DeviceBearer marker is exercised the
 * way the app runs it. Only the Clerk JWKS check and the audit fan-out are
 * substituted. No guard is overridden.
 *
 * NOTE: CI runs Testcontainers (ci.yml db-integration). Locally without
 * Docker this suite skips when MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import cookieParser from "cookie-parser";
import request from "supertest";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../../../../src/auth/auth.module";
import { FailClosedAuthGuard } from "../../../../src/auth/fail-closed-auth.guard";
import { sha256CanonicalHex } from "../../../../src/catalog/sales/payload-hash";
import { SalesModule } from "../../../../src/catalog/sales/sales.module";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { RequestIdInterceptor } from "../../../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../../../src/common/zod-validation.pipe";
import { CashierAdmissionsModule } from "../../../../src/pos-cashier-admissions/cashier-admissions.module";
import { CLERK_VERIFIER, type ClerkVerifier } from "../../../../src/pos-operators/clerk-verifier";
import { PosOperatorsModule } from "../../../../src/pos-operators/pos-operators.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";

// No real Redis: AuthModule falls back to its no-op client (rate limit allows;
// the idempotency store reads through to its Postgres mirror).
delete process.env["REDIS_URL"];

const TENANT = "0a224000-0000-4000-8000-000000000001";
const TENANT_OTHER = "0a224000-0000-4000-8000-000000000002";
const STORE = "0a224000-0000-4000-8000-0000000000a1";
const STORE_2 = "0a224000-0000-4000-8000-0000000000a2";
const STORE_OTHER = "0a224000-0000-4000-8000-0000000000a3";
const ROLE_STAFF = "0a224000-0000-4000-8000-0000000000b1";
const ROLE_MANAGER = "0a224000-0000-4000-8000-0000000000b2";
const ROLE_STAFF_OTHER = "0a224000-0000-4000-8000-0000000000b3";
const CASHIER = "0a224000-0000-4000-8000-0000000000c1";
const CASHIER_2 = "0a224000-0000-4000-8000-0000000000c2";
const MANAGER = "0a224000-0000-4000-8000-0000000000c3";
const CASHIER_OTHER = "0a224000-0000-4000-8000-0000000000c4";
const M_CASHIER = "0a224000-0000-4000-8000-0000000000d1";
const M_CASHIER_2 = "0a224000-0000-4000-8000-0000000000d2";
const M_MANAGER = "0a224000-0000-4000-8000-0000000000d3";
const M_CASHIER_OTHER = "0a224000-0000-4000-8000-0000000000d4";
const DEVICE = "0a224000-0000-4000-8000-0000000000e1";
const DEVICE_2 = "0a224000-0000-4000-8000-0000000000e2";
const DEVICE_S2 = "0a224000-0000-4000-8000-0000000000e3";
const DEVICE_OTHER = "0a224000-0000-4000-8000-0000000000e4";
const TOKEN = "rt224-device-token-store-till-1";
const TOKEN_2 = "rt224-device-token-store-till-2";
const TOKEN_S2 = "rt224-device-token-store2-till-1";
const TOKEN_OTHER = "rt224-device-token-other-tenant";
const MANAGER_SUB = "user_clerk_rt224_manager";
const MANAGER_JWT = "jwt-rt224-manager";

/** Admission window base: every seeded window starts here. */
const T0 = Date.parse("2026-09-01T08:00:00.000Z");
const HOUR = 3_600_000;
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

class StubClerkVerifier implements ClerkVerifier {
  async verify(rawJwt: string): Promise<{ sub: string }> {
    if (rawJwt !== MANAGER_JWT) throw new Error("StubClerkVerifier: unknown jwt");
    return { sub: MANAGER_SUB };
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
const skip = (): boolean => dockerSkipped;

let extSeq = 0;
function nextExternalId(): string {
  extSeq += 1;
  return `rt224-${extSeq}-${randomUUID().slice(0, 8)}`;
}

function saleBody(opts: {
  operatorUserId?: string | null;
  occurredAt: string;
  externalId?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sourceSystem: "pos-pulse",
    externalId: opts.externalId ?? nextExternalId(),
    currencyCode: "EGP",
    posTotal: "12.50",
    occurredAt: opts.occurredAt,
    lines: [
      {
        lineName: "Widget",
        unitPrice: "5.00",
        currencyCode: "EGP",
        quantity: "1",
        lineAmount: "5.00",
        unit: "unit",
      },
      {
        lineName: "Gadget",
        unitPrice: "7.50",
        currencyCode: "EGP",
        quantity: "1",
        lineAmount: "7.50",
        unit: "unit",
      },
    ],
  };
  if (opts.operatorUserId !== undefined) body["operatorUserId"] = opts.operatorUserId;
  return body;
}

/** One capture request: the presented bearer (none → null), the body, the idempotency key. */
interface CaptureCall {
  bearer: string | null;
  body: Record<string, unknown>;
  key?: string;
}

function capture(call: CaptureCall): request.Test {
  const key = call.key ?? randomUUID().replace(/-/g, "");
  const req = http().post("/api/pos/v1/sales").set("Idempotency-Key", key);
  if (call.bearer !== null) req.set("Authorization", `Bearer ${call.bearer}`);
  return req.send(call.body);
}

/** A cashier sale claimed at `occurredAt` by `user` (default CASHIER) from the till `token` names (default till 1). */
interface CashierSale {
  occurredAt: string;
  user?: string;
  token?: string;
}

function cashierSale(sale: CashierSale): request.Test {
  return capture({
    bearer: sale.token ?? TOKEN,
    body: saleBody({ operatorUserId: sale.user ?? CASHIER, occurredAt: sale.occurredAt }),
  });
}

async function admission(opts: {
  user?: string;
  device?: string;
  store?: string;
  tenant?: string;
  createdAt: string;
  expiresAt: string;
  endedAt?: string;
  endReason?: "device_end" | "takeover" | "expired";
}): Promise<string> {
  const id = randomUUID();
  await E().admin.query(
    `INSERT INTO cashier_admissions
       (id, tenant_id, store_id, user_id, device_id, mode,
        created_at, renewed_at, expires_at, ended_at, end_reason)
     VALUES ($1, $2, $3, $4, $5, 'online',
             $6::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9)`,
    [
      id,
      opts.tenant ?? TENANT,
      opts.store ?? STORE,
      opts.user ?? CASHIER,
      opts.device ?? DEVICE,
      opts.createdAt,
      opts.expiresAt,
      opts.endedAt ?? null,
      opts.endedAt ? (opts.endReason ?? "device_end") : null,
    ],
  );
  return id;
}

/** The standard window: [T0, T0 + 12h), live (never ended). */
function liveAdmission(extra: Partial<Parameters<typeof admission>[0]> = {}): Promise<string> {
  return admission({ createdAt: at(0), expiresAt: at(12 * HOUR), ...extra });
}

async function saleRow(saleRef: string): Promise<{
  tenant_id: string;
  store_id: string;
  created_by: string;
  device_id: string;
  payload_hash: string;
}> {
  const r = await E().admin.query(
    `SELECT tenant_id, store_id, created_by, device_id, payload_hash FROM sales WHERE id = $1`,
    [saleRef],
  );
  return r.rows[0];
}

async function saleCount(): Promise<number> {
  const r = await E().admin.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM sales`);
  return Number(r.rows[0]?.n ?? "0");
}

/** The 401 body without its per-request id. */
function genericBody(res: request.Response): unknown {
  const body = res.body as { error?: Record<string, unknown> };
  const { request_id: _rid, ...rest } = body.error ?? {};
  return { status: res.status, type: res.type, error: rest };
}

async function signInManager(): Promise<string> {
  const res = await http()
    .post("/api/pos/v1/operators/sign-in")
    .set("Authorization", `Bearer ${MANAGER_JWT}`)
    .send({ kind: "manager_admin", device_token_attestation: TOKEN });
  expect(res.status).toBe(200);
  return res.body.operator_session.envelope as string;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[device-operator-capture] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'rt224-tenant', 'RT-224 Tenant'), ($2, 'rt224-other', 'RT-224 Other')`,
    [TENANT, TENANT_OTHER],
  );
  await a.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $4, 'store_staff', 'Cashier'),
       ($2, $4, 'store_manager', 'Manager'),
       ($3, $5, 'store_staff', 'Cashier')`,
    [ROLE_STAFF, ROLE_MANAGER, ROLE_STAFF_OTHER, TENANT, TENANT_OTHER],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $4, 'S1', 'Store 1'), ($2, $4, 'S2', 'Store 2'), ($3, $5, 'SO', 'Other Store')`,
    [STORE, STORE_2, STORE_OTHER, TENANT, TENANT_OTHER],
  );
  await a.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
       ($1, 'cashier@rt224.example',   'Cashier One',   'user_clerk_rt224_c1'),
       ($2, 'cashier2@rt224.example',  'Cashier Two',   'user_clerk_rt224_c2'),
       ($3, 'manager@rt224.example',   'Manager',       $5),
       ($4, 'cashierx@rt224.example',  'Other Cashier', 'user_clerk_rt224_cx')`,
    [CASHIER, CASHIER_2, MANAGER, CASHIER_OTHER, MANAGER_SUB],
  );
  // CASHIER: 'specific' access to STORE only (so store access is revocable).
  // CASHIER_2: 'all' stores. MANAGER: 'specific' access to STORE.
  await a.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $5, $6, $9,  'specific'),
       ($2, $5, $7, $9,  'all'),
       ($3, $5, $8, $10, 'specific'),
       ($4, $11, $12, $13, 'all')`,
    [
      M_CASHIER, M_CASHIER_2, M_MANAGER, M_CASHIER_OTHER,
      TENANT, CASHIER, CASHIER_2, MANAGER, ROLE_STAFF, ROLE_MANAGER,
      TENANT_OTHER, CASHIER_OTHER, ROLE_STAFF_OTHER,
    ],
  );
  await a.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $3, $4), ($2, $3, $4)`,
    [M_CASHIER, M_MANAGER, STORE, TENANT],
  );
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES
       ($1, $5, $6, 'till-1',  $9),
       ($2, $5, $6, 'till-2',  $10),
       ($3, $5, $7, 's2-till', $11),
       ($4, $8, $12, 'other',  $13)`,
    [
      DEVICE, DEVICE_2, DEVICE_S2, DEVICE_OTHER,
      TENANT, STORE, STORE_2, TENANT_OTHER,
      hashToken(TOKEN), hashToken(TOKEN_2), hashToken(TOKEN_S2), STORE_OTHER, hashToken(TOKEN_OTHER),
    ],
  );

  const moduleRef = await Test.createTestingModule({
    imports: [AuthModule, PosOperatorsModule, CashierAdmissionsModule, SalesModule],
    // The production global guard: a route with no marker must present an
    // opaque bearer/cookie; captureSale's @DeviceBearer defers to its route guard.
    providers: [{ provide: APP_GUARD, useClass: FailClosedAuthGuard }],
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

  app = moduleRef.createNestApplication({ bufferLogs: true, logger: false });
  app.use(cookieParser());
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
}, 240_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (!env) return;
  const a = env.admin;
  await a.query(`DELETE FROM cashier_admission_requests`);
  await a.query(`DELETE FROM cashier_admissions`);
  await a.query(`DELETE FROM auth_tokens WHERE scope = 'pos_operator'`);
  await a.query(`UPDATE memberships SET revoked_at = NULL, deleted_at = NULL`);
  await a.query(`UPDATE memberships SET role_id = $1 WHERE id = $2`, [ROLE_STAFF, M_CASHIER]);
  await a.query(`UPDATE users SET deleted_at = NULL`);
  await a.query(`UPDATE devices SET revoked_at = NULL`);
  await a.query(`UPDATE tenants SET status = 'active', deleted_at = NULL`);
  await a.query(`UPDATE stores SET is_active = true, deleted_at = NULL`);
  await a.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
    [M_CASHIER, STORE, TENANT],
  );
  audit.payloads.length = 0;
});

// ---------------------------------------------------------------------------

describe("RT-224 — a covering admission authorizes the cashier's sale", () => {
  it("device + operatorUserId + covering admission → 201; created_by, device, scope and audit actor are the cashier's", async () => {
    if (skip()) return;
    await liveAdmission();
    const body = saleBody({ operatorUserId: CASHIER, occurredAt: at(1 * HOUR) });
    const res = await capture({ bearer: TOKEN, body });
    expect(res.status).toBe(201);
    expect(res.body.storeId).toBe(STORE);

    const row = await saleRow(res.body.saleRef as string);
    expect(row.tenant_id).toBe(TENANT);
    expect(row.store_id).toBe(STORE);
    expect(row.created_by).toBe(CASHIER);
    expect(row.device_id).toBe(DEVICE);

    const captured = audit.payloads.filter((p) => p.action === "sale.captured");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.actor_user_id).toBe(CASHIER);
    expect(captured[0]?.tenant_id).toBe(TENANT);
    expect(captured[0]?.store_id).toBe(STORE);
  });

  it("the attribution is kept out of payload_hash: the hash is the sale facts only", async () => {
    if (skip()) return;
    await liveAdmission();
    const body = saleBody({ operatorUserId: CASHIER, occurredAt: at(1 * HOUR) });
    const res = await capture({ bearer: TOKEN, body });
    expect(res.status).toBe(201);
    const { operatorUserId: _claim, ...facts } = body;
    expect((await saleRow(res.body.saleRef as string)).payload_hash).toBe(sha256CanonicalHex(facts));
  });

  it("an admission created through the real admit route covers a sale made after it", async () => {
    if (skip()) return;
    const admit = await http()
      .post("/api/pos/v1/cashier-admissions")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ user_id: CASHIER_2, mode: "online", idempotency_key: randomUUID() });
    expect(admit.status).toBe(200);
    expect(admit.body.kind).toBe("admitted");
    const res = await cashierSale({ occurredAt: new Date(Date.now() + 1000).toISOString(), user: CASHIER_2 });
    expect(res.status).toBe(201);
    expect((await saleRow(res.body.saleRef as string)).created_by).toBe(CASHIER_2);
  });
});

describe("RT-224 — window edges: created_at <= occurredAt < LEAST(ended_at, expires_at)", () => {
  it("occurredAt exactly at created_at → accepted (inclusive lower bound)", async () => {
    if (skip()) return;
    await liveAdmission();
    expect((await cashierSale({ occurredAt: at(0) })).status).toBe(201);
  });

  it("occurredAt 1 ms before created_at → refused", async () => {
    if (skip()) return;
    await liveAdmission();
    expect((await cashierSale({ occurredAt: at(-1) })).status).toBe(401);
  });

  it("occurredAt 1 ms before expires_at → accepted", async () => {
    if (skip()) return;
    await liveAdmission();
    expect((await cashierSale({ occurredAt: at(12 * HOUR - 1) })).status).toBe(201);
  });

  it("occurredAt exactly at expires_at → refused (exclusive upper bound, as the admission's own expiry)", async () => {
    if (skip()) return;
    await liveAdmission();
    expect((await cashierSale({ occurredAt: at(12 * HOUR) })).status).toBe(401);
  });

  it("occurredAt after expires_at → refused", async () => {
    if (skip()) return;
    await liveAdmission();
    expect((await cashierSale({ occurredAt: at(13 * HOUR) })).status).toBe(401);
  });

  it("nothing is recorded for a refused sale", async () => {
    if (skip()) return;
    await liveAdmission();
    const before = await saleCount();
    expect((await cashierSale({ occurredAt: at(-1) })).status).toBe(401);
    expect(await saleCount()).toBe(before);
  });
});

describe("RT-224 — ended and expired admissions still cover their own window", () => {
  it("a sale inside the window of an admission that has since ENDED → accepted (queue drained after sign-out)", async () => {
    if (skip()) return;
    await admission({ createdAt: at(0), expiresAt: at(12 * HOUR), endedAt: at(2 * HOUR) });
    expect((await cashierSale({ occurredAt: at(1 * HOUR) })).status).toBe(201);
  });

  it("a sale 1 ms before ended_at → accepted; exactly at ended_at → refused", async () => {
    if (skip()) return;
    await admission({ createdAt: at(0), expiresAt: at(12 * HOUR), endedAt: at(2 * HOUR) });
    expect((await cashierSale({ occurredAt: at(2 * HOUR - 1) })).status).toBe(201);
    expect((await cashierSale({ occurredAt: at(2 * HOUR) })).status).toBe(401);
  });

  it("a sale after the end but before the old expiry → refused (the end cuts the window)", async () => {
    if (skip()) return;
    await admission({ createdAt: at(0), expiresAt: at(12 * HOUR), endedAt: at(2 * HOUR) });
    expect((await cashierSale({ occurredAt: at(3 * HOUR) })).status).toBe(401);
  });

  it("an admission ended lazily AFTER it expired stops at expires_at, not at ended_at", async () => {
    if (skip()) return;
    await admission({
      createdAt: at(0),
      expiresAt: at(12 * HOUR),
      endedAt: at(20 * HOUR),
      endReason: "expired",
    });
    expect((await cashierSale({ occurredAt: at(11 * HOUR) })).status).toBe(201);
    expect((await cashierSale({ occurredAt: at(13 * HOUR) })).status).toBe(401);
  });

  it("a takeover: the old device's window still covers its own sales; the new device's does not reach back", async () => {
    if (skip()) return;
    // Till 1 admitted T0..T0+2h, taken over by till 2 at T0+2h.
    await admission({ createdAt: at(0), expiresAt: at(12 * HOUR), endedAt: at(2 * HOUR), endReason: "takeover" });
    await admission({ device: DEVICE_2, createdAt: at(2 * HOUR), expiresAt: at(14 * HOUR) });
    expect((await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER, token: TOKEN })).status).toBe(201);
    expect((await cashierSale({ occurredAt: at(3 * HOUR), user: CASHIER, token: TOKEN })).status).toBe(401);
    expect((await cashierSale({ occurredAt: at(3 * HOUR), user: CASHIER, token: TOKEN_2 })).status).toBe(201);
    expect((await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER, token: TOKEN_2 })).status).toBe(401);
  });
});

describe("RT-224 — the admission must be this device's, this store's and this user's", () => {
  it("a covering admission on ANOTHER device of the same store → refused", async () => {
    if (skip()) return;
    await liveAdmission({ device: DEVICE_2 });
    expect((await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER, token: TOKEN })).status).toBe(401);
  });

  it("a covering admission for ANOTHER store (same device id) → refused", async () => {
    if (skip()) return;
    await liveAdmission({ store: STORE_2 });
    expect((await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER, token: TOKEN })).status).toBe(401);
  });

  it("a covering admission of the other store's till, used from this store's till → refused", async () => {
    if (skip()) return;
    await liveAdmission({ user: CASHIER_2, device: DEVICE_S2, store: STORE_2 });
    expect((await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER_2, token: TOKEN })).status).toBe(401);
  });

  it("a covering admission for ANOTHER user → refused for this user", async () => {
    if (skip()) return;
    await liveAdmission({ user: CASHIER_2 });
    expect((await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER, token: TOKEN })).status).toBe(401);
  });

  it("a user of ANOTHER tenant (admitted there) → refused on this tenant's device", async () => {
    if (skip()) return;
    await liveAdmission({ tenant: TENANT_OTHER, store: STORE_OTHER, device: DEVICE_OTHER, user: CASHIER_OTHER });
    expect((await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER_OTHER, token: TOKEN })).status).toBe(401);
  });

  it("an unknown user id → refused", async () => {
    if (skip()) return;
    await liveAdmission();
    expect((await cashierSale({ occurredAt: at(1 * HOUR), user: randomUUID(), token: TOKEN })).status).toBe(401);
  });
});

describe("RT-224 — the device is checked live (RT-213)", () => {
  it("a revoked device → 401 even with a covering admission", async () => {
    if (skip()) return;
    await liveAdmission();
    await E().admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEVICE]);
    expect((await cashierSale({ occurredAt: at(1 * HOUR) })).status).toBe(401);
  });

  it.each(["suspended", "pending"])("a device of a %s tenant → 401", async (status) => {
    if (skip()) return;
    await liveAdmission();
    await E().admin.query(`UPDATE tenants SET status = $1 WHERE id = $2`, [status, TENANT]);
    expect((await cashierSale({ occurredAt: at(1 * HOUR) })).status).toBe(401);
  });

  it("an unknown device token → 401", async () => {
    if (skip()) return;
    await liveAdmission();
    const res = await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER, token: "not-a-device-token" });
    expect(res.status).toBe(401);
  });

  it("a device token WITHOUT operatorUserId is not a sale credential → 401", async () => {
    if (skip()) return;
    await liveAdmission();
    expect((await capture({ bearer: TOKEN, body: saleBody({ occurredAt: at(1 * HOUR) }) })).status).toBe(401);
  });

  it("no Authorization header on either path → 401", async () => {
    if (skip()) return;
    await liveAdmission();
    const claimed = saleBody({ operatorUserId: CASHIER, occurredAt: at(1 * HOUR) });
    expect((await capture({ bearer: null, body: claimed })).status).toBe(401);
    expect((await capture({ bearer: null, body: saleBody({ occurredAt: at(1 * HOUR) }) })).status).toBe(401);
  });
});

describe("RT-224 — the cashier is re-checked live (RT-113 BC2 eligibility)", () => {
  const revocations: ReadonlyArray<{ axis: string; revoke: () => Promise<unknown> }> = [
    {
      axis: "membership revoked",
      revoke: () => E().admin.query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [M_CASHIER]),
    },
    {
      axis: "membership soft-deleted",
      revoke: () => E().admin.query(`UPDATE memberships SET deleted_at = now() WHERE id = $1`, [M_CASHIER]),
    },
    {
      axis: "store access removed",
      revoke: () =>
        E().admin.query(`DELETE FROM store_access WHERE membership_id = $1 AND store_id = $2`, [M_CASHIER, STORE]),
    },
    {
      axis: "user soft-deleted",
      revoke: () => E().admin.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [CASHIER]),
    },
    {
      axis: "role no longer the cashier role",
      revoke: () => E().admin.query(`UPDATE memberships SET role_id = $1 WHERE id = $2`, [ROLE_MANAGER, M_CASHIER]),
    },
    {
      axis: "store deactivated",
      revoke: () => E().admin.query(`UPDATE stores SET is_active = false WHERE id = $1`, [STORE]),
    },
  ];

  it.each(revocations)("$axis → 401 even inside a covering window", async ({ revoke }) => {
    if (skip()) return;
    await liveAdmission();
    expect((await cashierSale({ occurredAt: at(1 * HOUR) })).status).toBe(201);
    await revoke();
    expect((await cashierSale({ occurredAt: at(1 * HOUR) })).status).toBe(401);
  });

  it("restoring the membership re-admits the same sale request (the refusal was the live state)", async () => {
    if (skip()) return;
    await liveAdmission();
    await E().admin.query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [M_CASHIER]);
    const body = saleBody({ operatorUserId: CASHIER, occurredAt: at(1 * HOUR) });
    expect((await capture({ bearer: TOKEN, body })).status).toBe(401);
    await E().admin.query(`UPDATE memberships SET revoked_at = NULL WHERE id = $1`, [M_CASHIER]);
    expect((await capture({ bearer: TOKEN, body })).status).toBe(201);
  });
});

describe("RT-224 — every refusal is the same generic 401", () => {
  it("no admission / unknown user / other device / revoked membership / revoked device / bad envelope: one body", async () => {
    if (skip()) return;
    await liveAdmission({ device: DEVICE_2 });
    const bodies: unknown[] = [];
    // No admission for this device.
    bodies.push(genericBody(await cashierSale({ occurredAt: at(1 * HOUR) })));
    // Unknown user.
    bodies.push(genericBody(await cashierSale({ occurredAt: at(1 * HOUR), user: randomUUID() })));
    // Admission exists on till 2, but the window is checked against till 1.
    bodies.push(genericBody(await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER, token: TOKEN })));
    // Revoked membership, covering admission on till 2 used from till 2.
    await E().admin.query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [M_CASHIER]);
    bodies.push(genericBody(await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER, token: TOKEN_2 })));
    // Revoked device.
    await E().admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEVICE_2]);
    bodies.push(genericBody(await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER, token: TOKEN_2 })));
    // The envelope path's refusal, for reference.
    const unclaimed = saleBody({ occurredAt: at(1 * HOUR) });
    bodies.push(genericBody(await capture({ bearer: "not-an-envelope", body: unclaimed })));

    expect(bodies[0]).toMatchObject({ status: 401 });
    for (const b of bodies) expect(b).toEqual(bodies[0]);
  });

  it("an authenticated device with a malformed operatorUserId → the usual 400, nothing recorded", async () => {
    if (skip()) return;
    const before = await saleCount();
    const res = await capture({
      bearer: TOKEN,
      body: saleBody({ operatorUserId: "not-a-uuid", occurredAt: at(1 * HOUR) }),
    });
    expect(res.status).toBe(400);
    expect(await saleCount()).toBe(before);
  });

  it("an unknown device with a malformed body → 401, not 400 (authentication first)", async () => {
    if (skip()) return;
    const res = await capture({ bearer: "not-a-device-token", body: { operatorUserId: "not-a-uuid" } });
    expect(res.status).toBe(401);
  });
});

describe("RT-224 — the manager envelope path is unchanged", () => {
  it("envelope (no operatorUserId) → 201 with created_by = the manager", async () => {
    if (skip()) return;
    const envelope = await signInManager();
    const res = await capture({ bearer: envelope, body: saleBody({ occurredAt: at(1 * HOUR) }) });
    expect(res.status).toBe(201);
    expect((await saleRow(res.body.saleRef as string)).created_by).toBe(MANAGER);
    expect(audit.payloads.find((p) => p.action === "sale.captured")?.actor_user_id).toBe(MANAGER);
  });

  it("the envelope still re-verifies live: revoked manager membership → 401", async () => {
    if (skip()) return;
    const envelope = await signInManager();
    await E().admin.query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [M_MANAGER]);
    expect((await capture({ bearer: envelope, body: saleBody({ occurredAt: at(1 * HOUR) }) })).status).toBe(401);
  });

  it("an envelope carrying operatorUserId is refused: the field selects the device path, and created_by is never taken from the body", async () => {
    if (skip()) return;
    await liveAdmission();
    const envelope = await signInManager();
    const before = await saleCount();
    const res = await capture({
      bearer: envelope,
      body: saleBody({ operatorUserId: CASHIER, occurredAt: at(1 * HOUR) }),
    });
    expect(res.status).toBe(401);
    expect(await saleCount()).toBe(before);
  });
});

describe("RT-224 — idempotency and divergence are unchanged on the device path", () => {
  it("same Idempotency-Key + same body → stored 201 replayed, one sale", async () => {
    if (skip()) return;
    await liveAdmission();
    const key = randomUUID().replace(/-/g, "");
    const body = saleBody({ operatorUserId: CASHIER, occurredAt: at(1 * HOUR) });
    const first = await capture({ bearer: TOKEN, body, key });
    expect(first.status).toBe(201);
    const before = await saleCount();
    const again = await capture({ bearer: TOKEN, body, key });
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body.saleRef).toBe(first.body.saleRef);
    expect(await saleCount()).toBe(before);
  });

  it("a new key for the same provenance → 200 provenance replay, one sale, attribution unchanged", async () => {
    if (skip()) return;
    await liveAdmission();
    await liveAdmission({ user: CASHIER_2 });
    const externalId = nextExternalId();
    const first = await capture({
      bearer: TOKEN,
      body: saleBody({ operatorUserId: CASHIER, occurredAt: at(1 * HOUR), externalId }),
    });
    expect(first.status).toBe(201);
    const replay = await capture({
      bearer: TOKEN,
      body: saleBody({ operatorUserId: CASHIER_2, occurredAt: at(1 * HOUR), externalId }),
    });
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.saleRef).toBe(first.body.saleRef);
    expect((await saleRow(first.body.saleRef as string)).created_by).toBe(CASHIER);
  });

  it("same Idempotency-Key + a different body → 409 idempotency_key_conflict", async () => {
    if (skip()) return;
    await liveAdmission();
    const key = randomUUID().replace(/-/g, "");
    const first = await capture({
      bearer: TOKEN,
      body: saleBody({ operatorUserId: CASHIER, occurredAt: at(1 * HOUR) }),
      key,
    });
    expect(first.status).toBe(201);
    const diverged = await capture({
      bearer: TOKEN,
      body: saleBody({ operatorUserId: CASHIER, occurredAt: at(1 * HOUR) }),
      key,
    });
    expect(diverged.status).toBe(409);
    expect(diverged.body.error.code).toBe("idempotency_key_conflict");
  });

  it("a same-key replay is re-authorized first: revoked membership → 401, never the stored 201", async () => {
    if (skip()) return;
    await liveAdmission();
    const key = randomUUID().replace(/-/g, "");
    const body = saleBody({ operatorUserId: CASHIER, occurredAt: at(1 * HOUR) });
    expect((await capture({ bearer: TOKEN, body, key })).status).toBe(201);
    await E().admin.query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [M_CASHIER]);
    expect((await capture({ bearer: TOKEN, body, key })).status).toBe(401);
  });
});

describe("RT-224 — cross-tenant isolation", () => {
  it("the other tenant's cashier on the other tenant's device → 201 in THAT tenant, invisible to this tenant", async () => {
    if (skip()) return;
    await liveAdmission({ tenant: TENANT_OTHER, store: STORE_OTHER, device: DEVICE_OTHER, user: CASHIER_OTHER });
    const res = await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER_OTHER, token: TOKEN_OTHER });
    expect(res.status).toBe(201);
    const row = await saleRow(res.body.saleRef as string);
    expect(row).toMatchObject({ tenant_id: TENANT_OTHER, store_id: STORE_OTHER, created_by: CASHIER_OTHER });

    async function visibleAs(tenantId: string): Promise<number> {
      const client = await E().app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
        await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
        const r = await client.query(`SELECT id FROM sales WHERE id = $1`, [res.body.saleRef]);
        await client.query("COMMIT");
        return r.rowCount ?? 0;
      } finally {
        client.release();
      }
    }
    expect(await visibleAs(TENANT_OTHER)).toBe(1);
    expect(await visibleAs(TENANT)).toBe(0);
  });

  it("this tenant's cashier claimed on the other tenant's device → 401 (no admission there)", async () => {
    if (skip()) return;
    await liveAdmission();
    expect((await cashierSale({ occurredAt: at(1 * HOUR), user: CASHIER, token: TOKEN_OTHER })).status).toBe(401);
  });
});
