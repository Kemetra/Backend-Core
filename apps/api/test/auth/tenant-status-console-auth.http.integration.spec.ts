/**
 * tenant-status-console-auth.http.integration.spec.ts — RT-669 (RT-667 / R-1).
 *
 * The console counterpart of RT-213: a member session or `dashboard_api`
 * token of a tenant that is suspended, pending or soft-deleted must not
 * reach any console route of that tenant, read or write. "Active" is the
 * RT-213 rule: `status = 'active' AND deleted_at IS NULL`.
 *
 * Every refusal is compared with the response the API already gives today
 * (same status, same content type, same body byte for byte except
 * `error.request_id`, which is per request):
 *
 *   - a member SESSION is refused like a member whose membership was
 *     revoked: the non-disclosing 404 (FR-ISO-4);
 *   - a `dashboard_api` TOKEN on a TenantContextGuard route is refused like
 *     an invalid token: 401; on a path-as-context RolesGuard route
 *     (`/tenants/:id…`) like the token of a revoked member: 404.
 *
 * Families (one read and one write each):
 *
 *   - context:     GET /context/me (the tenant drops out of `memberships`),
 *                  POST /context/tenant (switch refused);
 *   - tenants:     GET /tenants/:id, PATCH /tenants/:id (owner cannot
 *                  reactivate their own tenant — owner decision D-b);
 *   - memberships: GET /tenants/:id/members, PATCH /memberships/:id;
 *   - stores:      GET /stores, PATCH /stores/:id.
 *
 * Plus: the sign-in membership list drops the tenant; an active tenant is
 * unaffected (session and token); a platform admin can still enter a
 * suspended or pending tenant and reactivate it through PATCH /tenants/:id
 * (D-a), after which the member's existing session and token are re-admitted
 * (the refusal is the live tenant state, not a cached verdict).
 *
 * Real PostgreSQL (all migrations) and the real production modules: the
 * domain pool (PG_POOL) is the NOBYPASSRLS `app_test` role, the pre-tenant
 * lookup pool (AUTH_LOOKUP_POOL) is the RLS-exempt admin pool. Only Redis
 * and email are substituted. No guard is overridden.
 *
 * NOTE: CI runs Testcontainers (ci.yml db-integration; never sets
 * MIGRATION_TEST_ALLOW_SKIP). Locally without Docker this suite skips when
 * MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { generateRawToken, hashPassword, hashToken } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import request from "supertest";

import {
  AUTH_LOOKUP_POOL,
  AuthModule,
  PG_POOL,
  REDIS_CLIENT,
} from "../../src/auth/auth.module";
import { EMAIL_JOB_ENQUEUER, NoOpEmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";
import type { RedisLike } from "../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { LoggingInterceptor } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { ContextInterceptor } from "../../src/context/context.interceptor";
import { ContextModule } from "../../src/context/context.module";
import { MembershipsModule } from "../../src/memberships/memberships.module";
import { StoresModule } from "../../src/stores/stores.module";
import { TenantsModule } from "../../src/tenants/tenants.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import { SAME_ORIGIN } from "../_helpers/same-origin";

class AlwaysAllowRedis implements RedisLike {
  async incr(): Promise<number> { return 1; }
  async pexpireNx(): Promise<number> { return 1; }
  async pttl(): Promise<number> { return -1; }
  async decr(): Promise<number> { return 0; }
  async del(): Promise<number> { return 0; }
}

// ---------------------------------------------------------------------------
// Domain aliases
// ---------------------------------------------------------------------------
/** A UUID: a tenant, store, user, role or membership id. */
type Uuid = string;
/** A `Cookie` header value, or a raw bearer secret. */
type Secret = string;
/** The X-Request-Id sent with a request. */
type RequestId = string;

// ---------------------------------------------------------------------------
// Fixtures (hex-only UUID suffixes)
// ---------------------------------------------------------------------------
/** The tenant whose status the tests change. */
const SUBJECT = "06690000-0000-4000-8000-0000000000a1";
const SUBJECT_STORE = "06690000-0000-4000-8000-0000000000a2";
/** A tenant that stays active; OWNER is its owner too. */
const CONTROL = "06690000-0000-4000-8000-0000000000b1";

const ROLE_OWNER = "06690000-0000-4000-8000-0000000000c1";
const ROLE_STAFF = "06690000-0000-4000-8000-0000000000c2";
const ROLE_CONTROL_OWNER = "06690000-0000-4000-8000-0000000000c3";

/** Owner of SUBJECT (and of CONTROL): the member under test. */
const OWNER = "06690000-0000-4000-8000-0000000000d1";
/** Was owner of SUBJECT; membership revoked — the baseline refusal. */
const REVOKED = "06690000-0000-4000-8000-0000000000d2";
/** Staff of SUBJECT: the target of the membership write. */
const STAFF = "06690000-0000-4000-8000-0000000000d3";
/** Platform admin, no membership anywhere. */
const ADMIN = "06690000-0000-4000-8000-0000000000d4";

const M_OWNER = "06690000-0000-4000-8000-0000000000e1";
const M_REVOKED = "06690000-0000-4000-8000-0000000000e2";
const M_STAFF = "06690000-0000-4000-8000-0000000000e3";
const M_CONTROL_OWNER = "06690000-0000-4000-8000-0000000000e4";

const PASSWORD = "Rt669-Password-ok!";
const EMAIL: Record<Uuid, string> = {
  [OWNER]: "owner.rt669@example.com",
  [REVOKED]: "revoked.rt669@example.com",
  [STAFF]: "staff.rt669@example.com",
  [ADMIN]: "admin.rt669@example.com",
};

/** `dashboard_api` tokens bound to SUBJECT. */
const OWNER_TOKEN: Secret = generateRawToken();
const REVOKED_TOKEN: Secret = generateRawToken();
/** Never inserted: the invalid-token baseline. */
const INVALID_TOKEN: Secret = generateRawToken();

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
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

async function seed(e: PgTestEnv): Promise<void> {
  const a = e.admin;
  const hash = await hashPassword(PASSWORD);
  await a.query(
    `INSERT INTO users (id, email, password_hash, is_platform_admin) VALUES
       ($1, $5, $9, false), ($2, $6, $9, false), ($3, $7, $9, false), ($4, $8, $9, true)`,
    [OWNER, REVOKED, STAFF, ADMIN, EMAIL[OWNER], EMAIL[REVOKED], EMAIL[STAFF], EMAIL[ADMIN], hash],
  );
  await a.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt669-subject', 'RT-669'), ($2, 'rt669-control', 'RT-669 Control')`,
    [SUBJECT, CONTROL],
  );
  await a.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $4, 'owner', 'Owner'), ($2, $4, 'store_staff', 'Staff'), ($3, $5, 'owner', 'Owner')`,
    [ROLE_OWNER, ROLE_STAFF, ROLE_CONTROL_OWNER, SUBJECT, CONTROL],
  );
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S1', 'Store')`, [
    SUBJECT_STORE,
    SUBJECT,
  ]);
  await a.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $5, $6, $9, 'all'), ($2, $5, $7, $9, 'all'), ($3, $5, $8, $10, 'all'), ($4, $11, $6, $12, 'all')`,
    [
      M_OWNER, M_REVOKED, M_STAFF, M_CONTROL_OWNER,
      SUBJECT, OWNER, REVOKED, STAFF,
      ROLE_OWNER, ROLE_STAFF,
      CONTROL, ROLE_CONTROL_OWNER,
    ],
  );
  await a.query(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at) VALUES
       (gen_random_uuid(), $1, $3, $4, 'dashboard_api', now() + interval '1 day'),
       (gen_random_uuid(), $2, $3, $5, 'dashboard_api', now() + interval '1 day')`,
    [hashToken(OWNER_TOKEN), hashToken(REVOKED_TOKEN), SUBJECT, OWNER, REVOKED],
  );
}

/** Sign in `userId`; returns the `Cookie` header value and the response body. */
async function signIn(userId: Uuid): Promise<{ cookie: Secret; body: Record<string, unknown> }> {
  const res = await http()
    .post("/api/v1/auth/signin")
    .send({ email: EMAIL[userId], password: PASSWORD })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = list.find((c: string) => c.startsWith("dp2_session="))!.split(";")[0]!;
  return { cookie, body: res.body as Record<string, unknown> };
}

function switchTenant(cookie: Secret, tenantId: Uuid, requestId: RequestId = randomUUID()): request.Test {
  return http()
    .post("/api/v1/context/tenant")
    .set("Cookie", cookie)
    .set(SAME_ORIGIN)
    .set("x-request-id", requestId)
    .send({ tenant_id: tenantId });
}

/** Sessions whose active tenant is SUBJECT (set while it was active). */
let ownerSession: Secret;
let revokedSession: Secret;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[tenant-status-console-auth] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seed(env);

  const moduleRef = await Test.createTestingModule({
    imports: [AuthModule, ContextModule, TenantsModule, MembershipsModule, StoresModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(env.app)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(env.admin)
    .overrideProvider(REDIS_CLIENT)
    .useValue(new AlwaysAllowRedis())
    .overrideProvider(EMAIL_JOB_ENQUEUER)
    .useValue(new NoOpEmailJobEnqueuer())
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true, logger: false });
  app.use(cookieParser());
  const logger = createLogger({ service: "api-test", level: "silent" });
  app.useGlobalInterceptors(
    new RequestIdInterceptor(),
    new LoggingInterceptor(logger),
    new ContextInterceptor(),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();

  // Both members enter SUBJECT while it is active and every membership is
  // live; then REVOKED's membership is revoked, so its session (and token)
  // are today's no-membership refusal.
  ownerSession = (await signIn(OWNER)).cookie;
  await switchTenant(ownerSession, SUBJECT).expect(200);
  revokedSession = (await signIn(REVOKED)).cookie;
  await switchTenant(revokedSession, SUBJECT).expect(200);
  await env.admin.query("UPDATE memberships SET revoked_at = now() WHERE id = $1", [M_REVOKED]);
}, 240_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

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
  await E().admin.query(state.sql, [SUBJECT]);
}

async function tenantRow(): Promise<{ status: string; deleted_at: Date | null; name: string }> {
  const { rows } = await E().admin.query<{ status: string; deleted_at: Date | null; name: string }>(
    "SELECT status, deleted_at, name FROM tenants WHERE id = $1",
    [SUBJECT],
  );
  return rows[0]!;
}

afterEach(async () => {
  if (!env) return;
  await env.admin.query(
    "UPDATE tenants SET status = 'active', deleted_at = NULL, name = 'RT-669' WHERE id = $1",
    [SUBJECT],
  );
});

// ---------------------------------------------------------------------------
// Requests (each takes the credential and an X-Request-Id)
// ---------------------------------------------------------------------------
type Call = (credential: Secret, requestId: RequestId) => request.Test;

function asSession(req: request.Test, cookie: Secret, requestId: RequestId): request.Test {
  return req.set("Cookie", cookie).set(SAME_ORIGIN).set("x-request-id", requestId);
}
function asToken(req: request.Test, token: Secret, requestId: RequestId): request.Test {
  return req.set("authorization", `Bearer ${token}`).set("x-request-id", requestId);
}

/** One console route: how to call it, and how to authenticate the call. */
interface Route {
  readonly label: string;
  readonly call: (r: ReturnType<typeof request>) => request.Test;
}

const ROUTES = {
  tenantRead: { label: "tenants read: GET /tenants/:id", call: (r) => r.get(`/api/v1/tenants/${SUBJECT}`) },
  tenantWrite: {
    label: "tenants write: PATCH /tenants/:id",
    call: (r) => r.patch(`/api/v1/tenants/${SUBJECT}`).send({ name: "RT-669" }),
  },
  membersRead: {
    label: "memberships read: GET /tenants/:id/members",
    call: (r) => r.get(`/api/v1/tenants/${SUBJECT}/members`),
  },
  membershipWrite: {
    label: "memberships write: PATCH /memberships/:id",
    call: (r) => r.patch(`/api/v1/memberships/${M_STAFF}`).send({ role_code: "store_staff" }),
  },
  storesRead: { label: "stores read: GET /stores", call: (r) => r.get("/api/v1/stores") },
  storeWrite: {
    label: "stores write: PATCH /stores/:id",
    call: (r) => r.patch(`/api/v1/stores/${SUBJECT_STORE}`).send({ name: "Store" }),
  },
} satisfies Record<string, Route>;

const sessionCall = (route: Route): Call => (cookie, rid) => asSession(route.call(http()), cookie, rid);
const tokenCall = (route: Route): Call => (token, rid) => asToken(route.call(http()), token, rid);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
interface Captured {
  status: number;
  contentType: string | undefined;
  text: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Run `call`; mask the per-request `error.request_id` so two refusals compare byte for byte. */
async function run(call: Call, credential: Secret, requestId: RequestId): Promise<Captured> {
  const res = await call(credential, requestId);
  let text = res.text;
  const error = (res.body as { error?: { request_id?: unknown } } | null)?.error;
  if (error && typeof error.request_id === "string") {
    expect(error.request_id).toMatch(UUID_RE);
    text = text.split(error.request_id).join("<request_id>");
  }
  return { status: res.status, contentType: res.headers["content-type"] as string | undefined, text };
}

/** A refusal and the baseline credential whose existing response it must equal. */
interface RefusalCase {
  readonly label: string;
  readonly call: Call;
  readonly refused: Secret;
  readonly baseline: Secret;
  readonly status: 401 | 404;
}

async function expectRefusedLikeBaseline(c: RefusalCase): Promise<void> {
  const requestId = randomUUID();
  const refused = await run(c.call, c.refused, requestId);
  const baseline = await run(c.call, c.baseline, requestId);
  expect({ label: c.label, status: baseline.status }).toEqual({ label: c.label, status: c.status });
  expect({ label: c.label, ...refused }).toEqual({ label: c.label, ...baseline });
}

/** Member session cases: refused like the revoked member's session (404). */
function sessionCases(): RefusalCase[] {
  return Object.values(ROUTES).map((route) => ({
    label: `session — ${route.label}`,
    call: sessionCall(route),
    refused: ownerSession,
    baseline: revokedSession,
    status: 404,
  }));
}

/**
 * dashboard_api token cases: TenantContextGuard routes refuse like an invalid
 * token (401); path-as-context `/tenants/:id…` routes like the revoked
 * member's token (404).
 */
function tokenCases(): RefusalCase[] {
  const viaContextGuard = [ROUTES.membershipWrite, ROUTES.storesRead, ROUTES.storeWrite];
  const viaPath = [ROUTES.tenantRead, ROUTES.tenantWrite, ROUTES.membersRead];
  return [
    ...viaContextGuard.map((route) => ({
      label: `token — ${route.label}`,
      call: tokenCall(route),
      refused: OWNER_TOKEN,
      baseline: INVALID_TOKEN,
      status: 401 as const,
    })),
    ...viaPath.map((route) => ({
      label: `token — ${route.label}`,
      call: tokenCall(route),
      refused: OWNER_TOKEN,
      baseline: REVOKED_TOKEN,
      status: 404 as const,
    })),
  ];
}

interface ContextMe {
  active_role_code: string | null;
  memberships: Array<{ tenant_id: string }>;
}

async function contextMe(cookie: Secret): Promise<ContextMe> {
  const res = await asSession(http().get("/api/v1/context/me"), cookie, randomUUID()).expect(200);
  return res.body as ContextMe;
}

/** Every family works for OWNER's session and token. */
async function expectMemberAdmitted(): Promise<void> {
  for (const route of Object.values(ROUTES)) {
    const viaSession = await sessionCall(route)(ownerSession, randomUUID());
    expect({ label: `session — ${route.label}`, status: viaSession.status }).toEqual({
      label: `session — ${route.label}`,
      status: 200,
    });
    const viaToken = await tokenCall(route)(OWNER_TOKEN, randomUUID());
    expect({ label: `token — ${route.label}`, status: viaToken.status }).toEqual({
      label: `token — ${route.label}`,
      status: 200,
    });
  }
  const me = await contextMe(ownerSession);
  expect(me.active_role_code).toBe("owner");
  expect(me.memberships.map((m) => m.tenant_id).sort()).toEqual([SUBJECT, CONTROL].sort());
}

// ===========================================================================
// Active tenant: unaffected
// ===========================================================================
describe("RT-669 — an active tenant is unaffected", () => {
  it("every family works for the member's session and dashboard_api token; /context/me lists the tenant", async () => {
    if (skip()) return;
    await expectMemberAdmitted();
  });

  it("the member can switch into the tenant; sign-in lists it", async () => {
    if (skip()) return;
    const { cookie, body } = await signIn(OWNER);
    const ids = (body["memberships"] as Array<{ tenant_id: string }>).map((m) => m.tenant_id);
    expect(ids.sort()).toEqual([SUBJECT, CONTROL].sort());
    await switchTenant(cookie, SUBJECT).expect(200);
  });
});

// ===========================================================================
// Non-active tenant: refused like today's no-membership / invalid-token
// ===========================================================================
describe.each(INACTIVE_STATES)("RT-669 — $label tenant: member refused", (state) => {
  beforeEach(async () => {
    if (!skip()) await setTenant(state);
  });

  it("session: every family refused exactly like a revoked membership (404)", async () => {
    if (skip()) return;
    for (const c of sessionCases()) await expectRefusedLikeBaseline(c);
  });

  it("dashboard_api token: refused like an invalid token (401) / a revoked member's token (404)", async () => {
    if (skip()) return;
    for (const c of tokenCases()) await expectRefusedLikeBaseline(c);
  });

  it("context write: switching into the tenant is refused like a revoked membership (404)", async () => {
    if (skip()) return;
    const fresh = (await signIn(OWNER)).cookie;
    const revokedFresh = (await signIn(REVOKED)).cookie;
    await expectRefusedLikeBaseline({
      label: "POST /context/tenant",
      call: (cookie, rid) => switchTenant(cookie, SUBJECT, rid),
      refused: fresh,
      baseline: revokedFresh,
      status: 404,
    });
  });

  it("context read: /context/me and sign-in drop the tenant; no role in it", async () => {
    if (skip()) return;
    const me = await contextMe(ownerSession);
    expect(me.memberships.map((m) => m.tenant_id)).toEqual([CONTROL]);
    expect(me.active_role_code).toBeNull();
    const { body } = await signIn(OWNER);
    expect((body["memberships"] as Array<{ tenant_id: string }>).map((m) => m.tenant_id)).toEqual([
      CONTROL,
    ]);
  });

  it("other tenants of the same member are unaffected", async () => {
    if (skip()) return;
    const fresh = (await signIn(OWNER)).cookie;
    await switchTenant(fresh, CONTROL).expect(200);
    await asSession(http().get("/api/v1/stores"), fresh, randomUUID()).expect(200);
    await asSession(http().get(`/api/v1/tenants/${CONTROL}`), fresh, randomUUID()).expect(200);
  });
});

// ===========================================================================
// D-b: the owner of a suspended tenant cannot reactivate it
// ===========================================================================
describe("RT-669 D-b — reactivation is platform-admin-only", () => {
  it("the owner's PATCH /tenants/:id {status: active} is refused (404) and the tenant stays suspended", async () => {
    if (skip()) return;
    await setTenant(INACTIVE_STATES[0]!);
    const reactivate = (r: ReturnType<typeof request>) => r.patch(`/api/v1/tenants/${SUBJECT}`);
    for (const [label, req] of [
      ["session", () => asSession(reactivate(http()), ownerSession, randomUUID())],
      ["token", () => asToken(reactivate(http()), OWNER_TOKEN, randomUUID())],
    ] as const) {
      const res = await req().send({ status: "active" });
      expect({ label, status: res.status }).toEqual({ label, status: 404 });
    }
    expect((await tenantRow()).status).toBe("suspended");
  });
});

// ===========================================================================
// D-a: platform admin enters and reactivates; members are re-admitted
// ===========================================================================
describe.each(INACTIVE_STATES.filter((s) => s.label !== "soft-deleted"))(
  "RT-669 D-a — $label tenant: platform admin enters and reactivates",
  (state) => {
    it("admin switches in, reads and writes, sets status active → the member's session and token are re-admitted", async () => {
      if (skip()) return;
      await setTenant(state);
      const admin = (await signIn(ADMIN)).cookie;
      await switchTenant(admin, SUBJECT).expect(200);
      await asSession(http().get("/api/v1/stores"), admin, randomUUID()).expect(200);
      await asSession(http().get(`/api/v1/tenants/${SUBJECT}`), admin, randomUUID()).expect(200);
      await asSession(http().get(`/api/v1/tenants/${SUBJECT}/members`), admin, randomUUID()).expect(200);

      // Still refused for the member until the admin reactivates.
      await asSession(http().get("/api/v1/stores"), ownerSession, randomUUID()).expect(404);

      const res = await asSession(http().patch(`/api/v1/tenants/${SUBJECT}`), admin, randomUUID())
        .send({ status: "active" })
        .expect(200);
      expect(res.body.status).toBe("active");
      expect((await tenantRow()).status).toBe("active");

      await expectMemberAdmitted();
    });
  },
);

describe("RT-669 — soft-deleted tenant restored", () => {
  it("restoring the row re-admits the member's session and token", async () => {
    if (skip()) return;
    await setTenant(INACTIVE_STATES[2]!);
    await asSession(http().get("/api/v1/stores"), ownerSession, randomUUID()).expect(404);
    await E().admin.query("UPDATE tenants SET deleted_at = NULL WHERE id = $1", [SUBJECT]);
    await expectMemberAdmitted();
  });
});
