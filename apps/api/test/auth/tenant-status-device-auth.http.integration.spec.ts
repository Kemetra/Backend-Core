/**
 * tenant-status-device-auth.http.integration.spec.ts — RT-213.
 *
 * A POS device whose tenant is suspended, pending or soft-deleted must be
 * refused on every device route family with the SAME response a revoked
 * device gets today, so the refusal discloses nothing about the tenant.
 *
 * Real PostgreSQL (all migrations) and the real production modules, wired
 * like production: the pre-tenant lookup pool (AUTH_LOOKUP_POOL) is the
 * RLS-exempt admin pool, the domain pool (PG_POOL) is the NOBYPASSRLS
 * `app_test` role. Only external seams are substituted (Clerk JWKS, the
 * audit fan-out). No guard is overridden.
 *
 * Families covered (each one compared to a revoked device: same status,
 * same content type, same body byte for byte except `error.request_id`,
 * which is per request; a guard refusal runs before the request-id
 * interceptor, so the filter mints a fresh id):
 *
 *   - cashier-admissions (PosDeviceAuthGuard): admit, roster, end;
 *   - read-down (PosDeviceAuthGuard): catalog snapshot, deltas;
 *   - pos-operators: sign-in (device attestation);
 *   - sales capture: an envelope issued while the tenant was active, then
 *     capture (PosOperatorEnvelopeSaleGuard) and read
 *     (PosOperatorAuthGuard), compared to the same envelope after the device
 *     is revoked mid-session;
 *   - POS audit-event sync (device attestation).
 *
 * Plus: an active tenant's device still works on every family, another
 * tenant's device is unaffected, and restoring the tenant re-admits the
 * device (the refusal is the live tenant state, not a cached verdict).
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
import request from "supertest";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../src/audit/audit-job.enqueuer";
import { AUTH_LOOKUP_POOL, PG_POOL } from "../../src/auth/auth.module";
import { ReadDownModule } from "../../src/catalog/read-down/read-down.module";
import { SalesModule } from "../../src/catalog/sales/sales.module";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { PosAuditEventsModule } from "../../src/pos-audit-events/pos-audit-events.module";
import { CashierAdmissionsModule } from "../../src/pos-cashier-admissions/cashier-admissions.module";
import { CLERK_VERIFIER, type ClerkVerifier } from "../../src/pos-operators/clerk-verifier";
import { PosOperatorsModule } from "../../src/pos-operators/pos-operators.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// No Redis: AuthModule falls back to its in-process stubs.
delete process.env["REDIS_URL"];

// ---------------------------------------------------------------------------
// Fixtures (hex-only UUID suffixes)
// ---------------------------------------------------------------------------
/** The tenant whose status the tests change. */
const TENANT = "0f213000-0000-4000-8000-000000000001";
/** A tenant that stays active: holds the revoked device and a control device. */
const CONTROL = "0f213000-0000-4000-8000-000000000002";
const STORE = "0f213000-0000-4000-8000-00000000a001";
const CONTROL_STORE = "0f213000-0000-4000-8000-00000000a002";
const MANAGER_ROLE = "0f213000-0000-4000-8000-00000000b001";
const STAFF_ROLE = "0f213000-0000-4000-8000-00000000b002";
const CONTROL_STAFF_ROLE = "0f213000-0000-4000-8000-00000000b003";
const MANAGER = "0f213000-0000-4000-8000-00000000c001";
const CASHIER = "0f213000-0000-4000-8000-00000000c002";
const CONTROL_CASHIER = "0f213000-0000-4000-8000-00000000c003";
const MANAGER_SUB = "user_rt213_manager";
const MANAGER_JWT = "jwt-rt213-manager";

interface FixtureDevice {
  readonly id: string;
  readonly token: string;
}
const DEV: FixtureDevice = {
  id: "0f213000-0000-4000-8000-00000000e001",
  token: "rt213-device-token-active-aaaaaaaaaaaaaaaa",
};
const DEV_REVOKED: FixtureDevice = {
  id: "0f213000-0000-4000-8000-00000000e002",
  token: "rt213-device-token-revoked-bbbbbbbbbbbbbbb",
};
const DEV_CONTROL: FixtureDevice = {
  id: "0f213000-0000-4000-8000-00000000e003",
  token: "rt213-device-token-control-ccccccccccccccc",
};

const ADMIT = "/api/pos/v1/cashier-admissions";
const ROSTER = "/api/pos/v1/cashier-admissions/roster";
const SNAPSHOT = "/api/pos/v1/catalog/snapshot";
const DELTAS = "/api/pos/v1/catalog/deltas";
const SIGN_IN = "/api/pos/v1/operators/sign-in";
const AUDIT_EVENTS = "/api/pos/v1/audit-events";
const SALES = "/api/pos/v1/sales";

class StubClerkVerifier implements ClerkVerifier {
  async verify(rawJwt: string): Promise<{ sub: string }> {
    if (rawJwt !== MANAGER_JWT) throw new Error("StubClerkVerifier: unknown jwt");
    return { sub: MANAGER_SUB };
  }
}

class NullAuditEnqueuer implements AuditJobEnqueuer {
  async enqueue(): Promise<void> {
    /* audit fan-out is not under test */
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

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

// ---------------------------------------------------------------------------
// Tenant states
// ---------------------------------------------------------------------------
interface TenantState {
  readonly label: string;
  readonly sql: string;
}

const INACTIVE_STATES: ReadonlyArray<TenantState> = [
  { label: "suspended", sql: "UPDATE tenants SET status = 'suspended' WHERE id = $1" },
  { label: "pending", sql: "UPDATE tenants SET status = 'pending' WHERE id = $1" },
  { label: "soft-deleted", sql: "UPDATE tenants SET deleted_at = now() WHERE id = $1" },
];

async function setTenant(state: TenantState): Promise<void> {
  await E().admin.query(state.sql, [TENANT]);
}

async function restoreTenant(): Promise<void> {
  await E().admin.query(
    "UPDATE tenants SET status = 'active', deleted_at = NULL WHERE id = $1",
    [TENANT],
  );
}

async function setDeviceRevoked(revoked: boolean): Promise<void> {
  await E().admin.query(
    `UPDATE devices SET revoked_at = ${revoked ? "now()" : "NULL"} WHERE id = $1`,
    [DEV.id],
  );
}

// ---------------------------------------------------------------------------
// Requests (each takes an X-Request-Id)
// ---------------------------------------------------------------------------
type Call = (requestId: string) => request.Test;

function bearer(token: string, req: request.Test, requestId: string): request.Test {
  return req.set("authorization", `Bearer ${token}`).set("x-request-id", requestId);
}

function admissionCalls(d: FixtureDevice): Record<string, Call> {
  return {
    admit: (rid) =>
      bearer(d.token, http().post(ADMIT), rid).send({
        mode: "online",
        user_id: CASHIER,
        idempotency_key: `rt213-test:${randomUUID()}`,
      }),
    roster: (rid) => bearer(d.token, http().get(ROSTER), rid),
    end: (rid) => bearer(d.token, http().post(`${ADMIT}/${randomUUID()}/end`), rid),
  };
}

function readDownCalls(d: FixtureDevice): Record<string, Call> {
  return {
    snapshot: (rid) => bearer(d.token, http().get(SNAPSHOT), rid),
    deltas: (rid) => bearer(d.token, http().get(DELTAS).query({ since: "x" }), rid),
  };
}

function signInCall(d: FixtureDevice): Call {
  return (rid) =>
    http()
      .post(SIGN_IN)
      .set("authorization", `Bearer ${MANAGER_JWT}`)
      .set("x-request-id", rid)
      .send({ kind: "manager_admin", device_token_attestation: d.token });
}

function auditEventsCall(
  d: FixtureDevice,
  tenantId: string,
  storeId: string,
  createdAt = "2026-10-04T08:00:00.000Z",
): Call {
  return (rid) =>
    http()
      .post(AUDIT_EVENTS)
      .set("x-request-id", rid)
      .send({
        device_token_attestation: d.token,
        events: [
          {
            event_id: randomUUID(),
            tenant_id: tenantId,
            branch_id: storeId,
            originating_terminal_id: d.id,
            acting_operator_id: MANAGER_SUB,
            action_category: "operator.session.takeover",
            created_at: createdAt,
            payload: {},
          },
        ],
      });
}

let extSeq = 0;
function captureBody(): Record<string, unknown> {
  extSeq += 1;
  return {
    sourceSystem: "pos-rt213",
    externalId: `rt213-${extSeq}`,
    currencyCode: "USD",
    posTotal: "5.0000",
    occurredAt: "2026-10-01T10:00:00.000Z",
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
  };
}

function saleCalls(envelope: string, saleRef: string): Record<string, Call> {
  return {
    capture: (rid) =>
      bearer(envelope, http().post(SALES), rid)
        .set("Idempotency-Key", randomUUID().replace(/-/g, ""))
        .send(captureBody()),
    read: (rid) => bearer(envelope, http().get(`${SALES}/${saleRef}`), rid),
  };
}

async function signInEnvelope(): Promise<string> {
  const res = await signInCall(DEV)(randomUUID());
  expect(res.status).toBe(200);
  expect(res.body.kind).toBe("signed_in");
  return res.body.operator_session.envelope as string;
}

async function captureSale(envelope: string): Promise<string> {
  const res = await saleCalls(envelope, "unused").capture!(randomUUID());
  expect(res.status).toBe(201);
  return res.body.saleRef as string;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
interface Captured {
  status: number;
  contentType: string | undefined;
  text: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The response with its per-request `error.request_id` replaced by a marker
 * (after checking it is a UUID), so two refusals compare byte for byte.
 */
async function run(call: Call, requestId: string): Promise<Captured> {
  const res = await call(requestId);
  let text = res.text;
  const body: unknown = res.body;
  const error = (body as { error?: { request_id?: unknown } } | null)?.error;
  if (error && typeof error.request_id === "string") {
    expect(error.request_id).toMatch(UUID_RE);
    text = text.split(error.request_id).join("<request_id>");
  }
  return {
    status: res.status,
    contentType: res.headers["content-type"] as string | undefined,
    text,
  };
}

/** `refused` and `baseline` (a revoked device) must be the same 401, byte for byte. */
function expectSameAsRevoked(refused: Captured, baseline: Captured, label: string): void {
  expect({ label, status: baseline.status }).toEqual({ label, status: 401 });
  expect({ label, ...refused }).toEqual({ label, ...baseline });
}

/** Run each call for `refusedDevice` and for the revoked baseline with one request id. */
async function expectFamilyRefused(
  refused: Record<string, Call>,
  baseline: Record<string, Call>,
): Promise<void> {
  for (const [name, call] of Object.entries(refused)) {
    const rid = randomUUID();
    const got = await run(call, rid);
    const want = await run(baseline[name]!, rid);
    expectSameAsRevoked(got, want, name);
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[tenant-status-device-auth] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seed(env);

  const moduleRef = await Test.createTestingModule({
    imports: [
      CashierAdmissionsModule,
      ReadDownModule,
      PosOperatorsModule,
      SalesModule,
      PosAuditEventsModule,
    ],
  })
    .overrideProvider(PG_POOL)
    .useValue(env.app)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(env.admin)
    .overrideProvider(CLERK_VERIFIER)
    .useValue(new StubClerkVerifier())
    .overrideProvider(AUDIT_JOB_ENQUEUER)
    .useValue(new NullAuditEnqueuer())
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true, logger: false });
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
  await restoreTenant();
  await setDeviceRevoked(false);
  // One live operator session / admission per user: start each test clean.
  await env.admin.query("DELETE FROM auth_tokens WHERE scope = 'pos_operator'");
  await env.admin.query("DELETE FROM cashier_admission_requests");
  await env.admin.query("DELETE FROM cashier_admissions");
});

async function seed(e: PgTestEnv): Promise<void> {
  const a = e.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt213-tenant', 'RT-213'), ($2, 'rt213-control', 'RT-213 Control')`,
    [TENANT, CONTROL],
  );
  await a.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $4, 'store_manager', 'Manager'),
       ($2, $4, 'store_staff', 'Staff'),
       ($3, $5, 'store_staff', 'Staff')`,
    [MANAGER_ROLE, STAFF_ROLE, CONTROL_STAFF_ROLE, TENANT, CONTROL],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'T1', 'Store'), ($3, $4, 'C1', 'Control')`,
    [STORE, TENANT, CONTROL_STORE, CONTROL],
  );
  await a.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
       ($1, 'manager@rt213.example', 'Manager', $4),
       ($2, 'cashier@rt213.example', 'Cashier', 'user_rt213_cashier'),
       ($3, 'control@rt213.example', 'Control', 'user_rt213_control')`,
    [MANAGER, CASHIER, CONTROL_CASHIER, MANAGER_SUB],
  );
  await a.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $4, $5, $6, 'all'),
       ($2, $4, $7, $8, 'all'),
       ($3, $9, $10, $11, 'all')`,
    [
      "0f213000-0000-4000-8000-00000000d001",
      "0f213000-0000-4000-8000-00000000d002",
      "0f213000-0000-4000-8000-00000000d003",
      TENANT,
      MANAGER,
      MANAGER_ROLE,
      CASHIER,
      STAFF_ROLE,
      CONTROL,
      CONTROL_CASHIER,
      CONTROL_STAFF_ROLE,
    ],
  );
  const devices: Array<[FixtureDevice, string, string, boolean]> = [
    [DEV, TENANT, STORE, false],
    [DEV_REVOKED, CONTROL, CONTROL_STORE, true],
    [DEV_CONTROL, CONTROL, CONTROL_STORE, false],
  ];
  for (const [d, tenant, store, revoked] of devices) {
    await a.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, revoked_at)
       VALUES ($1, $2, $3, 'till', $4, $5)`,
      [d.id, tenant, store, hashToken(d.token), revoked ? new Date() : null],
    );
  }
}

// ===========================================================================
// Active tenant: every family still works
// ===========================================================================
describe("RT-213 — an active tenant's device still works", () => {
  it("cashier-admissions: admit → 200 admitted, roster → 200", async () => {
    if (skip()) return;
    const calls = admissionCalls(DEV);
    const admit = await calls.admit!(randomUUID());
    expect(admit.status).toBe(200);
    expect(admit.body.kind).toBe("admitted");
    expect((await calls.roster!(randomUUID())).status).toBe(200);
  });

  it("read-down: snapshot → 200", async () => {
    if (skip()) return;
    const res = await readDownCalls(DEV).snapshot!(randomUUID());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
  });

  it("pos-operators sign-in, then sales capture and read → 200 / 201 / 200", async () => {
    if (skip()) return;
    const envelope = await signInEnvelope();
    const saleRef = await captureSale(envelope);
    expect((await saleCalls(envelope, saleRef).read!(randomUUID())).status).toBe(200);
  });

  it("audit-event sync → 200, event accepted", async () => {
    if (skip()) return;
    // The event's actor must hold a pos_operator session on this device.
    await signInEnvelope();
    const res = await auditEventsCall(DEV, TENANT, STORE, new Date().toISOString())(randomUUID());
    expect(res.status).toBe(200);
    expect(res.body.accepted).toHaveLength(1);
  });
});

// ===========================================================================
// Inactive tenant: every family refuses exactly like a revoked device
// ===========================================================================
describe.each(INACTIVE_STATES)("RT-213 — $label tenant: refused like a revoked device", (state) => {
  it("cashier-admissions: admit / roster / end", async () => {
    if (skip()) return;
    await setTenant(state);
    await expectFamilyRefused(admissionCalls(DEV), admissionCalls(DEV_REVOKED));
  });

  it("read-down: snapshot / deltas", async () => {
    if (skip()) return;
    await setTenant(state);
    await expectFamilyRefused(readDownCalls(DEV), readDownCalls(DEV_REVOKED));
  });

  it("pos-operators: sign-in", async () => {
    if (skip()) return;
    await setTenant(state);
    await expectFamilyRefused({ signIn: signInCall(DEV) }, { signIn: signInCall(DEV_REVOKED) });
  });

  it("audit-event sync", async () => {
    if (skip()) return;
    await setTenant(state);
    await expectFamilyRefused(
      { sync: auditEventsCall(DEV, TENANT, STORE) },
      { sync: auditEventsCall(DEV_REVOKED, CONTROL, CONTROL_STORE) },
    );
  });

  it("sales capture / read: an envelope issued while active → same 401 as the device revoked mid-session", async () => {
    if (skip()) return;
    const envelope = await signInEnvelope();
    const saleRef = await captureSale(envelope);
    const calls = saleCalls(envelope, saleRef);
    const rids = { capture: randomUUID(), read: randomUUID() };

    await setTenant(state);
    const refused = {
      capture: await run(calls.capture!, rids.capture),
      read: await run(calls.read!, rids.read),
    };

    await restoreTenant();
    await setDeviceRevoked(true);
    const revoked = {
      capture: await run(calls.capture!, rids.capture),
      read: await run(calls.read!, rids.read),
    };

    expectSameAsRevoked(refused.capture, revoked.capture, "capture");
    expectSameAsRevoked(refused.read, revoked.read, "read");
  });

  it("another tenant's device is unaffected", async () => {
    if (skip()) return;
    await setTenant(state);
    expect((await readDownCalls(DEV_CONTROL).snapshot!(randomUUID())).status).toBe(200);
    expect((await admissionCalls(DEV_CONTROL).roster!(randomUUID())).status).toBe(200);
  });

  it("restoring the tenant re-admits the same device (the refusal is the live state)", async () => {
    if (skip()) return;
    await setTenant(state);
    expect((await readDownCalls(DEV).snapshot!(randomUUID())).status).toBe(401);
    await restoreTenant();
    expect((await readDownCalls(DEV).snapshot!(randomUUID())).status).toBe(200);
  });
});
