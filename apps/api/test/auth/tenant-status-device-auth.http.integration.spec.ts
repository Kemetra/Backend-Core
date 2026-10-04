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
// Domain aliases (ids, secrets and request ids are not interchangeable
// strings at the call sites)
// ---------------------------------------------------------------------------
/** A UUID: a tenant, store, device, user, role or sale id. */
type Uuid = string;
/** A bearer secret: a device token, an operator envelope or a Clerk JWT. */
type Secret = string;
/** The X-Request-Id sent with a request. */
type RequestId = string;
/** An ISO-8601 timestamp. */
type Timestamp = string;

// ---------------------------------------------------------------------------
// Fixtures (hex-only UUID suffixes)
// ---------------------------------------------------------------------------
/** A tenant and one of its stores. */
interface TenantFixture {
  readonly tenantId: Uuid;
  readonly storeId: Uuid;
}

/** A paired till: its tenant and store, its device row id and its token. */
interface Terminal extends TenantFixture {
  readonly deviceId: Uuid;
  readonly deviceToken: Secret;
}

/** The tenant whose status the tests change. */
const SUBJECT: TenantFixture = {
  tenantId: "0f213000-0000-4000-8000-000000000001",
  storeId: "0f213000-0000-4000-8000-00000000a001",
};
/** A tenant that stays active: holds the revoked device and a control device. */
const CONTROL: TenantFixture = {
  tenantId: "0f213000-0000-4000-8000-000000000002",
  storeId: "0f213000-0000-4000-8000-00000000a002",
};

/** The active device of the SUBJECT tenant. */
const TERMINAL: Terminal = {
  ...SUBJECT,
  deviceId: "0f213000-0000-4000-8000-00000000e001",
  deviceToken: "rt213-device-token-active-aaaaaaaaaaaaaaaa",
};
/** A revoked device (CONTROL tenant, which stays active): the baseline refusal. */
const REVOKED_TERMINAL: Terminal = {
  ...CONTROL,
  deviceId: "0f213000-0000-4000-8000-00000000e002",
  deviceToken: "rt213-device-token-revoked-bbbbbbbbbbbbbbb",
};
/** An active device of the CONTROL tenant. */
const CONTROL_TERMINAL: Terminal = {
  ...CONTROL,
  deviceId: "0f213000-0000-4000-8000-00000000e003",
  deviceToken: "rt213-device-token-control-ccccccccccccccc",
};

const MANAGER_ROLE = "0f213000-0000-4000-8000-00000000b001";
const STAFF_ROLE = "0f213000-0000-4000-8000-00000000b002";
const CONTROL_STAFF_ROLE = "0f213000-0000-4000-8000-00000000b003";
const MANAGER = "0f213000-0000-4000-8000-00000000c001";
const CASHIER = "0f213000-0000-4000-8000-00000000c002";
const CONTROL_CASHIER = "0f213000-0000-4000-8000-00000000c003";
const MANAGER_SUB = "user_rt213_manager";
const MANAGER_JWT = "jwt-rt213-manager";

const ADMIT = "/api/pos/v1/cashier-admissions";
const ROSTER = "/api/pos/v1/cashier-admissions/roster";
const SNAPSHOT = "/api/pos/v1/catalog/snapshot";
const DELTAS = "/api/pos/v1/catalog/deltas";
const SIGN_IN = "/api/pos/v1/operators/sign-in";
const AUDIT_EVENTS = "/api/pos/v1/audit-events";
const SALES = "/api/pos/v1/sales";

class StubClerkVerifier implements ClerkVerifier {
  async verify(rawJwt: Secret): Promise<{ sub: string }> {
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
// Tenant and device states
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
  await E().admin.query(state.sql, [SUBJECT.tenantId]);
}

async function restoreTenant(): Promise<void> {
  await E().admin.query(
    "UPDATE tenants SET status = 'active', deleted_at = NULL WHERE id = $1",
    [SUBJECT.tenantId],
  );
}

async function revokeDevice(): Promise<void> {
  await E().admin.query("UPDATE devices SET revoked_at = now() WHERE id = $1", [
    TERMINAL.deviceId,
  ]);
}

async function restoreDevice(): Promise<void> {
  await E().admin.query("UPDATE devices SET revoked_at = NULL WHERE id = $1", [
    TERMINAL.deviceId,
  ]);
}

// ---------------------------------------------------------------------------
// Requests (each takes an X-Request-Id)
// ---------------------------------------------------------------------------
type Call = (requestId: RequestId) => request.Test;
type Calls = Record<string, Call>;

/** A bearer credential and the request id to send it with. */
interface Credential {
  readonly token: Secret;
  readonly requestId: RequestId;
}

function withBearer(req: request.Test, cred: Credential): request.Test {
  return req.set("authorization", `Bearer ${cred.token}`).set("x-request-id", cred.requestId);
}

function admissionCalls(t: Terminal): Calls {
  const as = (requestId: RequestId): Credential => ({ token: t.deviceToken, requestId });
  return {
    admit: (rid) =>
      withBearer(http().post(ADMIT), as(rid)).send({
        mode: "online",
        user_id: CASHIER,
        idempotency_key: `rt213-test:${randomUUID()}`,
      }),
    roster: (rid) => withBearer(http().get(ROSTER), as(rid)),
    end: (rid) => withBearer(http().post(`${ADMIT}/${randomUUID()}/end`), as(rid)),
  };
}

function readDownCalls(t: Terminal): Calls {
  const as = (requestId: RequestId): Credential => ({ token: t.deviceToken, requestId });
  return {
    snapshot: (rid) => withBearer(http().get(SNAPSHOT), as(rid)),
    deltas: (rid) => withBearer(http().get(DELTAS).query({ since: "x" }), as(rid)),
  };
}

function signInCall(t: Terminal): Call {
  return (rid) =>
    withBearer(http().post(SIGN_IN), { token: MANAGER_JWT, requestId: rid }).send({
      kind: "manager_admin",
      device_token_attestation: t.deviceToken,
    });
}

/** One audit event from `terminal`, stamped `createdAt`. */
interface AuditEventSpec {
  readonly terminal: Terminal;
  readonly createdAt?: Timestamp;
}

function auditEventsCall(spec: AuditEventSpec): Call {
  const t = spec.terminal;
  return (rid) =>
    http()
      .post(AUDIT_EVENTS)
      .set("x-request-id", rid)
      .send({
        device_token_attestation: t.deviceToken,
        events: [
          {
            event_id: randomUUID(),
            tenant_id: t.tenantId,
            branch_id: t.storeId,
            originating_terminal_id: t.deviceId,
            acting_operator_id: MANAGER_SUB,
            action_category: "operator.session.takeover",
            created_at: spec.createdAt ?? "2026-10-04T08:00:00.000Z",
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

/** An operator envelope issued by sign-in on TERMINAL. */
interface OperatorSession {
  readonly envelope: Secret;
}

/** A sale captured under an operator session. */
interface OpenSale extends OperatorSession {
  readonly saleRef: Uuid;
}

function captureCall(session: OperatorSession): Call {
  return (rid) =>
    withBearer(http().post(SALES), { token: session.envelope, requestId: rid })
      .set("Idempotency-Key", randomUUID().replace(/-/g, ""))
      .send(captureBody());
}

function saleCalls(sale: OpenSale): Calls {
  return {
    capture: captureCall(sale),
    read: (rid) =>
      withBearer(http().get(`${SALES}/${sale.saleRef}`), { token: sale.envelope, requestId: rid }),
  };
}

async function signIn(): Promise<OperatorSession> {
  const res = await signInCall(TERMINAL)(randomUUID());
  expect(res.status).toBe(200);
  expect(res.body.kind).toBe("signed_in");
  return { envelope: res.body.operator_session.envelope as Secret };
}

async function openSale(session: OperatorSession): Promise<OpenSale> {
  const res = await captureCall(session)(randomUUID());
  expect(res.status).toBe(201);
  return { ...session, saleRef: res.body.saleRef as Uuid };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
interface Captured {
  status: number;
  contentType: string | undefined;
  text: string;
}

/** A call and the request id to send it with. */
interface Probe {
  readonly call: Call;
  readonly requestId: RequestId;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The response with its per-request `error.request_id` replaced by a marker
 * (after checking it is a UUID), so two refusals compare byte for byte.
 */
async function run(probe: Probe): Promise<Captured> {
  const res = await probe.call(probe.requestId);
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

/** One route's refusal next to the revoked-device baseline. */
interface RefusalPair {
  readonly label: string;
  readonly refused: Captured;
  readonly baseline: Captured;
}

/** `refused` and `baseline` (a revoked device) must be the same 401, byte for byte. */
function expectSameAsRevoked(pair: RefusalPair): void {
  const { label, refused, baseline } = pair;
  expect({ label, status: baseline.status }).toEqual({ label, status: 401 });
  expect({ label, ...refused }).toEqual({ label, ...baseline });
}

/** The same routes called by the refused device and by the revoked baseline. */
interface FamilyComparison {
  readonly refused: Calls;
  readonly baseline: Calls;
}

/** Run each route for both devices with one request id and compare. */
async function expectFamilyRefused(family: FamilyComparison): Promise<void> {
  for (const [label, call] of Object.entries(family.refused)) {
    const requestId = randomUUID();
    const refused = await run({ call, requestId });
    const baseline = await run({ call: family.baseline[label]!, requestId });
    expectSameAsRevoked({ label, refused, baseline });
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
  await restoreDevice();
  // One live operator session / admission per user: start each test clean.
  await env.admin.query("DELETE FROM auth_tokens WHERE scope = 'pos_operator'");
  await env.admin.query("DELETE FROM cashier_admission_requests");
  await env.admin.query("DELETE FROM cashier_admissions");
});

async function seed(e: PgTestEnv): Promise<void> {
  const a = e.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt213-tenant', 'RT-213'), ($2, 'rt213-control', 'RT-213 Control')`,
    [SUBJECT.tenantId, CONTROL.tenantId],
  );
  await a.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $4, 'store_manager', 'Manager'),
       ($2, $4, 'store_staff', 'Staff'),
       ($3, $5, 'store_staff', 'Staff')`,
    [MANAGER_ROLE, STAFF_ROLE, CONTROL_STAFF_ROLE, SUBJECT.tenantId, CONTROL.tenantId],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'T1', 'Store'), ($3, $4, 'C1', 'Control')`,
    [SUBJECT.storeId, SUBJECT.tenantId, CONTROL.storeId, CONTROL.tenantId],
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
      SUBJECT.tenantId,
      MANAGER,
      MANAGER_ROLE,
      CASHIER,
      STAFF_ROLE,
      CONTROL.tenantId,
      CONTROL_CASHIER,
      CONTROL_STAFF_ROLE,
    ],
  );
  const terminals: Array<{ terminal: Terminal; revoked: boolean }> = [
    { terminal: TERMINAL, revoked: false },
    { terminal: REVOKED_TERMINAL, revoked: true },
    { terminal: CONTROL_TERMINAL, revoked: false },
  ];
  for (const { terminal: t, revoked } of terminals) {
    await a.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, revoked_at)
       VALUES ($1, $2, $3, 'till', $4, $5)`,
      [t.deviceId, t.tenantId, t.storeId, hashToken(t.deviceToken), revoked ? new Date() : null],
    );
  }
}

// ===========================================================================
// Active tenant: every family still works
// ===========================================================================
describe("RT-213 — an active tenant's device still works", () => {
  it("cashier-admissions: admit → 200 admitted, roster → 200", async () => {
    if (skip()) return;
    const calls = admissionCalls(TERMINAL);
    const admit = await calls.admit!(randomUUID());
    expect(admit.status).toBe(200);
    expect(admit.body.kind).toBe("admitted");
    expect((await calls.roster!(randomUUID())).status).toBe(200);
  });

  it("read-down: snapshot → 200", async () => {
    if (skip()) return;
    const res = await readDownCalls(TERMINAL).snapshot!(randomUUID());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
  });

  it("pos-operators sign-in, then sales capture and read → 200 / 201 / 200", async () => {
    if (skip()) return;
    const sale = await openSale(await signIn());
    expect((await saleCalls(sale).read!(randomUUID())).status).toBe(200);
  });

  it("audit-event sync → 200, event accepted", async () => {
    if (skip()) return;
    // The event's actor must hold a pos_operator session on this device.
    await signIn();
    const call = auditEventsCall({ terminal: TERMINAL, createdAt: new Date().toISOString() });
    const res = await call(randomUUID());
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
    await expectFamilyRefused({
      refused: admissionCalls(TERMINAL),
      baseline: admissionCalls(REVOKED_TERMINAL),
    });
  });

  it("read-down: snapshot / deltas", async () => {
    if (skip()) return;
    await setTenant(state);
    await expectFamilyRefused({
      refused: readDownCalls(TERMINAL),
      baseline: readDownCalls(REVOKED_TERMINAL),
    });
  });

  it("pos-operators: sign-in", async () => {
    if (skip()) return;
    await setTenant(state);
    await expectFamilyRefused({
      refused: { signIn: signInCall(TERMINAL) },
      baseline: { signIn: signInCall(REVOKED_TERMINAL) },
    });
  });

  it("audit-event sync", async () => {
    if (skip()) return;
    await setTenant(state);
    await expectFamilyRefused({
      refused: { sync: auditEventsCall({ terminal: TERMINAL }) },
      baseline: { sync: auditEventsCall({ terminal: REVOKED_TERMINAL }) },
    });
  });

  it("sales capture / read: an envelope issued while active → same 401 as the device revoked mid-session", async () => {
    if (skip()) return;
    const calls = saleCalls(await openSale(await signIn()));
    const probes = {
      capture: { call: calls.capture!, requestId: randomUUID() },
      read: { call: calls.read!, requestId: randomUUID() },
    };

    await setTenant(state);
    const refused = { capture: await run(probes.capture), read: await run(probes.read) };

    await restoreTenant();
    await revokeDevice();
    const revoked = { capture: await run(probes.capture), read: await run(probes.read) };

    expectSameAsRevoked({ label: "capture", refused: refused.capture, baseline: revoked.capture });
    expectSameAsRevoked({ label: "read", refused: refused.read, baseline: revoked.read });
  });

  it("another tenant's device is unaffected", async () => {
    if (skip()) return;
    await setTenant(state);
    expect((await readDownCalls(CONTROL_TERMINAL).snapshot!(randomUUID())).status).toBe(200);
    expect((await admissionCalls(CONTROL_TERMINAL).roster!(randomUUID())).status).toBe(200);
  });

  it("restoring the tenant re-admits the same device (the refusal is the live state)", async () => {
    if (skip()) return;
    await setTenant(state);
    expect((await readDownCalls(TERMINAL).snapshot!(randomUUID())).status).toBe(401);
    await restoreTenant();
    expect((await readDownCalls(TERMINAL).snapshot!(randomUUID())).status).toBe(200);
  });
});
