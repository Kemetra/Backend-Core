/**
 * platform-support-sessions.http.integration.spec.ts — RT-414 (RT-391 P0-a, D2).
 *
 * The support-session runtime end to end: the four operations, enforcement on
 * the covered routes (a TenantContextGuard route, switchActiveStore, the path
 * tenants listMembers / updateTenant), expiry refused server-side, explicit
 * renewal and its cap, the suspended-tenant read-only rule (comment 11737),
 * exactly one `platform.cross_tenant.accessed` row per covered request, the
 * opened / renewed / ended rows, their visibility to the tenant's owner and
 * tenant_admin through `listAuditEvents`, the metadata allowlists (no PII),
 * and the RLS of `platform_support_sessions` (0062).
 *
 * Real PostgreSQL (all migrations) and the production modules: the domain
 * pool (PG_POOL) is the NOBYPASSRLS `app_test` role, the pre-tenant lookup
 * pool (AUTH_LOOKUP_POOL) is the RLS-exempt admin pool. Only Redis, email and
 * the async audit enqueuer are substituted. No guard is overridden.
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
import Ajv from "ajv";
import addFormats from "ajv-formats";
import cookieParser from "cookie-parser";
import request from "supertest";

import { AuditModule } from "../../src/audit/audit.module";
import { AUDIT_JOB_ENQUEUER, NoOpAuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
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
import { loadOpenApiContracts } from "../../src/openapi/loader";
import { PlatformSupportSessionsModule } from "../../src/platform-support-sessions/platform-support-sessions.module";
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
  async incrWindow(): Promise<{ count: number; ttlMs: number }> { return { count: 1, ttlMs: -1 }; }
  async pttl(): Promise<number> { return -1; }
  async decr(): Promise<number> { return 0; }
  async del(): Promise<number> { return 0; }
}

type Uuid = string;
type Cookie = string;
/** An X-Request-Id value. */
type RequestId = string;
/** A request path. */
type Path = string;

// ---------------------------------------------------------------------------
// Fixtures (hex-only UUID suffixes)
// ---------------------------------------------------------------------------
/** The tenant operators support. OWNER owns it, TADMIN administers it. */
const ACME = "04140000-0000-4000-8000-0000000000a1";
const ACME_STORE = "04140000-0000-4000-8000-0000000000a2";
/** A suspended tenant (read-only support sessions). */
const PAUSED = "04140000-0000-4000-8000-0000000000b1";
/** A soft-deleted tenant (the non-disclosing 404). */
const GONE = "04140000-0000-4000-8000-0000000000c1";
/** A tenant MEMBER_ADMIN is not a member of. */
const OTHER = "04140000-0000-4000-8000-0000000000d1";
/** Never inserted. */
const UNKNOWN = "04140000-0000-4000-8000-0000000000e1";

const ROLE_OWNER = "04140000-0000-4000-8000-0000000001a1";
const ROLE_TADMIN = "04140000-0000-4000-8000-0000000001a2";
const ROLE_STAFF = "04140000-0000-4000-8000-0000000001a3";

/** Platform admin, member of no tenant: the support operator. */
const ADMIN = "04140000-0000-4000-8000-0000000002a1";
/** Platform admin AND owner of ACME: never needs a support session there. */
const MEMBER_ADMIN = "04140000-0000-4000-8000-0000000002a2";
const OWNER = "04140000-0000-4000-8000-0000000002a3";
const TADMIN = "04140000-0000-4000-8000-0000000002a4";
const STAFF = "04140000-0000-4000-8000-0000000002a5";

const PASSWORD = "Rt414-Password-ok!";
const EMAIL: Record<Uuid, string> = {
  [ADMIN]: "admin.rt414@example.com",
  [MEMBER_ADMIN]: "member-admin.rt414@example.com",
  [OWNER]: "owner.rt414@example.com",
  [TADMIN]: "tadmin.rt414@example.com",
  [STAFF]: "staff.rt414@example.com",
};
const OWNER_TOKEN = generateRawToken();

const BASE = "/api/v1/platform/support-sessions";

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

async function seed(e: PgTestEnv): Promise<void> {
  const a = e.admin;
  const hash = await hashPassword(PASSWORD);
  for (const id of [ADMIN, MEMBER_ADMIN, OWNER, TADMIN, STAFF]) {
    await a.query(
      `INSERT INTO users (id, email, password_hash, is_platform_admin) VALUES ($1, $2, $3, $4)`,
      [id, EMAIL[id], hash, id === ADMIN || id === MEMBER_ADMIN],
    );
  }
  await a.query(
    `INSERT INTO tenants (id, slug, name, status, deleted_at) VALUES
       ($1, 'rt414-acme', 'Acme', 'active', NULL),
       ($2, 'rt414-paused', 'Paused', 'suspended', NULL),
       ($3, 'rt414-gone', 'Gone', 'active', now()),
       ($4, 'rt414-other', 'Other', 'active', NULL)`,
    [ACME, PAUSED, GONE, OTHER],
  );
  await a.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $4, 'owner', 'Owner'), ($2, $4, 'tenant_admin', 'Admin'), ($3, $4, 'store_staff', 'Staff')`,
    [ROLE_OWNER, ROLE_TADMIN, ROLE_STAFF, ACME],
  );
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S1', 'Store')`, [
    ACME_STORE,
    ACME,
  ]);
  await a.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       (gen_random_uuid(), $1, $2, $5, 'all'),
       (gen_random_uuid(), $1, $3, $6, 'all'),
       (gen_random_uuid(), $1, $4, $7, 'all'),
       (gen_random_uuid(), $1, $8, $5, 'all')`,
    [ACME, OWNER, TADMIN, STAFF, ROLE_OWNER, ROLE_TADMIN, ROLE_STAFF, MEMBER_ADMIN],
  );
  await a.query(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'dashboard_api', now() + interval '1 day')`,
    [hashToken(OWNER_TOKEN), ACME, OWNER],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[platform-support-sessions.http] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seed(env);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AuthModule,
      ContextModule,
      TenantsModule,
      StoresModule,
      AuditModule,
      PlatformSupportSessionsModule,
    ],
  })
    .overrideProvider(PG_POOL)
    .useValue(env.app)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(env.admin)
    .overrideProvider(REDIS_CLIENT)
    .useValue(new AlwaysAllowRedis())
    .overrideProvider(EMAIL_JOB_ENQUEUER)
    .useValue(new NoOpEmailJobEnqueuer())
    .overrideProvider(AUDIT_JOB_ENQUEUER)
    .useValue(new NoOpAuditJobEnqueuer())
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
}, 240_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function signIn(userId: Uuid): Promise<Cookie> {
  const res = await http()
    .post("/api/v1/auth/signin")
    .send({ email: EMAIL[userId], password: PASSWORD })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.find((c: string) => c.startsWith("dp2_session="))!.split(";")[0]!;
}

function post(path: Path, cookie: Cookie, requestId: RequestId = randomUUID()): request.Test {
  return http().post(path).set("Cookie", cookie).set(SAME_ORIGIN).set("x-request-id", requestId);
}
function get(path: Path, cookie: Cookie, requestId: RequestId = randomUUID()): request.Test {
  return http().get(path).set("Cookie", cookie).set(SAME_ORIGIN).set("x-request-id", requestId);
}

function open(cookie: Cookie, tenantId: Uuid, extra: Record<string, unknown> = {}): request.Test {
  return post(BASE, cookie).send({ tenant_id: tenantId, purpose: "customer_support", ...extra });
}

interface AuditRow {
  tenant_id: string | null;
  actor_user_id: string | null;
  actor_label: string | null;
  action: string;
  request_id: string | null;
  metadata: Record<string, unknown>;
}

async function rowsFor(requestId: RequestId): Promise<AuditRow[]> {
  const { rows } = await E().admin.query<AuditRow>(
    `SELECT tenant_id, actor_user_id, actor_label, action, request_id, metadata
       FROM audit_events WHERE request_id = $1 ORDER BY occurred_at, id`,
    [requestId],
  );
  return rows;
}

async function crossTenantRowFor(requestId: RequestId): Promise<AuditRow> {
  const rows = (await rowsFor(requestId)).filter((r) => r.action === "platform.cross_tenant.accessed");
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** Point the auth session's active tenant without a support session (the trigger admits platform admins). */
async function forceActiveTenant(cookie: Cookie, tenantId: Uuid): Promise<void> {
  const res = await get("/api/v1/context/me", cookie).expect(200);
  const userId = (res.body as { user: { id: string } }).user.id;
  await E().admin.query(
    `UPDATE sessions SET active_tenant_id = $1, active_store_id = NULL
      WHERE user_id = $2 AND revoked_at IS NULL`,
    [tenantId, userId],
  );
}

/** Move a support session's clock (identity columns are frozen by 0062's trigger). */
async function shiftSession(id: Uuid, sql: string): Promise<void> {
  const client = await E().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`UPDATE platform_support_sessions SET ${sql} WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

function body(res: request.Response): Record<string, unknown> {
  return res.body as Record<string, unknown>;
}
function errorCode(res: request.Response): string | undefined {
  return (res.body as { error?: { code?: string } }).error?.code;
}

// Contract validators for the stored metadata.
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
let validateChange: (v: unknown) => boolean;
let validateAccess: (v: unknown) => boolean;
let validateSession: (v: unknown) => boolean;
beforeAll(() => {
  const found = loadOpenApiContracts().find((c) => c.id === "platform-support-sessions.openapi")!;
  ajv.addSchema(found.document as object, "pss");
  validateChange = ajv.getSchema("pss#/components/schemas/SupportSessionAuditMetadata")!;
  validateAccess = ajv.getSchema("pss#/components/schemas/CrossTenantAccessAuditMetadata")!;
  validateSession = ajv.getSchema("pss#/components/schemas/SupportSession")!;
});

// ---------------------------------------------------------------------------
// Who may call the surface
// ---------------------------------------------------------------------------
describe("RT-414 support sessions — callers", () => {
  it("refuses a non-platform-admin with 403 on every operation", async () => {
    if (dockerSkipped) return;
    const staff = await signIn(STAFF);
    expect(errorCode(await open(staff, ACME).expect(403))).toBe("forbidden");
    expect(errorCode(await get(`${BASE}/current`, staff).expect(403))).toBe("forbidden");
    expect(errorCode(await post(`${BASE}/current/renew`, staff).expect(403))).toBe("forbidden");
    expect(errorCode(await post(`${BASE}/current/end`, staff).expect(403))).toBe("forbidden");
  });

  it("refuses a bearer token with 401", async () => {
    if (dockerSkipped) return;
    await http()
      .post(BASE)
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ tenant_id: ACME, purpose: "incident" })
      .expect(401);
  });

  it("refuses a POST without a trusted Origin (decision 5)", async () => {
    if (dockerSkipped) return;
    const admin = await signIn(ADMIN);
    const res = await http()
      .post(BASE)
      .set("Cookie", admin)
      .set("Host", "api.test")
      .send({ tenant_id: ACME, purpose: "incident" })
      .expect(403);
    expect(errorCode(res)).toBe("origin_rejected");
  });

  it("validates the body: purpose closed, ticket_ref bounded, no extra keys", async () => {
    if (dockerSkipped) return;
    const admin = await signIn(ADMIN);
    await post(BASE, admin).send({ tenant_id: ACME }).expect(400);
    await post(BASE, admin).send({ tenant_id: ACME, purpose: "curiosity" }).expect(400);
    await open(admin, ACME, { ticket_ref: "someone@example.com" }).expect(400);
    await open(admin, ACME, { ticket_ref: "has space" }).expect(400);
    await open(admin, ACME, { ticket_ref: "A".repeat(65) }).expect(400);
    await open(admin, ACME, { expires_at: "2099-01-01T00:00:00Z" }).expect(400);
    await post(BASE, admin).send({ tenant_id: "not-a-uuid", purpose: "incident" }).expect(400);
  });

  it("answers an unknown and a deleted tenant with the same 404", async () => {
    if (dockerSkipped) return;
    const admin = await signIn(ADMIN);
    const unknown = await open(admin, UNKNOWN).expect(404);
    const gone = await open(admin, GONE).expect(404);
    const strip = (r: request.Response): unknown => ({ ...body(r), error: { ...(body(r)["error"] as object), request_id: null } });
    expect(strip(gone)).toEqual(strip(unknown));
  });

  it("refuses a member platform admin with 409 already_member", async () => {
    if (dockerSkipped) return;
    const memberAdmin = await signIn(MEMBER_ADMIN);
    expect(errorCode(await open(memberAdmin, ACME).expect(409))).toBe("already_member");
  });
});

// ---------------------------------------------------------------------------
// Enforcement, audit and lifecycle
// ---------------------------------------------------------------------------
describe("RT-414 support sessions — enforcement and audit", () => {
  it("refuses switchActiveTenant for a non-member platform admin (403 support_session_required)", async () => {
    if (dockerSkipped) return;
    const admin = await signIn(ADMIN);
    const res = await post("/api/v1/context/tenant", admin).send({ tenant_id: ACME }).expect(403);
    expect(errorCode(res)).toBe("support_session_required");
  });

  it("refuses a tenant-scoped request without a support session, with one rejected row", async () => {
    if (dockerSkipped) return;
    const admin = await signIn(ADMIN);
    await forceActiveTenant(admin, ACME);
    const rid = randomUUID();
    const res = await get("/api/v1/stores", admin, rid).expect(403);
    expect(errorCode(res)).toBe("support_session_required");
    const row = await crossTenantRowFor(rid);
    expect(row.tenant_id).toBe(ACME);
    expect(row.actor_user_id).toBe(ADMIN);
    expect(row.actor_label).toBe("platform_support");
    expect(row.metadata).toEqual({
      actor_kind: "platform_admin",
      outcome: "rejected",
      reason: "support_session_required",
      support_session_id: null,
      purpose: null,
      method: "GET",
      route: "/api/v1/stores",
    });
    expect(validateAccess(row.metadata)).toBe(true);
  });

  // One support session through its whole life; the steps run in order and
  // share `admin`, `opened` and `sessionId`.
  describe("one support session, step by step", () => {
    let admin: Cookie;
    let opened: Record<string, unknown>;
    let sessionId: string;

    it("opens: 201 active, never renewed, 60 minutes, cap = opened + 8h, audited", async () => {
      if (dockerSkipped) return;
      admin = await signIn(ADMIN);
      const openRid = randomUUID();
      opened = body(
        await post(BASE, admin, openRid)
          .send({ tenant_id: ACME, purpose: "incident", ticket_ref: "ZD-4141" })
          .expect(201),
      );
      expect(validateSession(opened)).toBe(true);
      expect(opened).toMatchObject({ tenant_id: ACME, purpose: "incident", ticket_ref: "ZD-4141", status: "active", renewed_at: null });
      const openedAt = Date.parse(String(opened["opened_at"]));
      expect(Date.parse(String(opened["expires_at"])) - openedAt).toBe(60 * 60 * 1000);
      expect(Date.parse(String(opened["renewal_cap_at"])) - openedAt).toBe(8 * 60 * 60 * 1000);
      sessionId = String(opened["id"]);
      const openRows = await rowsFor(openRid);
      expect(openRows.map((r) => r.action)).toEqual(["platform.support_session.opened"]);
      expect(openRows[0]!.tenant_id).toBe(ACME);
      expect(openRows[0]!.metadata).toEqual({
        actor_kind: "platform_admin",
        outcome: "succeeded",
        support_session_id: sessionId,
        purpose: "incident",
        ticket_ref: "ZD-4141",
        expires_at: opened["expires_at"],
      });
      expect(validateChange(openRows[0]!.metadata)).toBe(true);
    });

    it("makes the tenant active and shows the session on the banner", async () => {
      if (dockerSkipped) return;
      const me = body(await get("/api/v1/context/me", admin).expect(200));
      expect((me["active_tenant"] as { id: string }).id).toBe(ACME);
      expect(me["support_session"]).toMatchObject({ id: sessionId, status: "active", purpose: "incident" });
      expect(body(await get(`${BASE}/current`, admin).expect(200))["support_session"]).toMatchObject({ id: sessionId });
    });

    it("admits a covered read with exactly one succeeded row", async () => {
      if (dockerSkipped) return;
      const readRid = randomUUID();
      await get("/api/v1/stores", admin, readRid).expect(200);
      const read = await crossTenantRowFor(readRid);
      expect(read.metadata).toEqual({
        actor_kind: "platform_admin",
        outcome: "succeeded",
        support_session_id: sessionId,
        purpose: "incident",
        method: "GET",
        route: "/api/v1/stores",
      });
      expect(validateAccess(read.metadata)).toBe(true);
    });

    it("covers switchActiveStore and the path tenant (this tenant only)", async () => {
      if (dockerSkipped) return;
      const storeRid = randomUUID();
      await post("/api/v1/context/store", admin, storeRid).send({ store_id: ACME_STORE }).expect(200);
      expect((await crossTenantRowFor(storeRid)).metadata["route"]).toBe("/api/v1/context/store");
      const membersRid = randomUUID();
      await get(`/api/v1/tenants/${ACME}/members`, admin, membersRid).expect(200);
      expect((await crossTenantRowFor(membersRid)).metadata["route"]).toBe("/api/v1/tenants/:id/members");
      const otherRid = randomUUID();
      expect(errorCode(await get(`/api/v1/tenants/${OTHER}/members`, admin, otherRid).expect(403))).toBe(
        "support_session_required",
      );
      expect((await crossTenantRowFor(otherRid)).tenant_id).toBe(OTHER);
    });

    it("refuses an admitted unsafe request with a foreign Origin (origin_rejected), audited", async () => {
      if (dockerSkipped) return;
      const originRid = randomUUID();
      const foreign = await http()
        .post("/api/v1/stores")
        .set("Cookie", admin)
        .set("Host", "api.test")
        .set("Origin", "https://evil.example")
        .set("x-request-id", originRid)
        .send({ code: "X1", name: "Nope" })
        .expect(403);
      expect(errorCode(foreign)).toBe("origin_rejected");
      const originRow = await crossTenantRowFor(originRid);
      expect(originRow.metadata).toMatchObject({ outcome: "rejected", reason: "origin_rejected", support_session_id: sessionId, method: "POST" });
      expect(validateAccess(originRow.metadata)).toBe(true);
    });

    it("renews explicitly, moving the expiry, audited", async () => {
      if (dockerSkipped) return;
      const renewRid = randomUUID();
      const renewed = body(await post(`${BASE}/current/renew`, admin, renewRid).expect(200));
      expect(renewed["renewed_at"]).not.toBeNull();
      expect(Date.parse(String(renewed["expires_at"]))).toBeGreaterThanOrEqual(Date.parse(String(opened["expires_at"])));
      const renewRows = await rowsFor(renewRid);
      expect(renewRows.map((r) => r.action)).toEqual(["platform.support_session.renewed"]);
      expect(validateChange(renewRows[0]!.metadata)).toBe(true);
    });

    it("refuses an expired session server-side; it cannot be renewed and shows as expired", async () => {
      if (dockerSkipped) return;
      await shiftSession(
        sessionId,
        `opened_at = now() - interval '2 hours', renewal_cap_at = now() + interval '6 hours',
         renewed_at = NULL, expires_at = now() - interval '1 minute'`,
      );
      const expiredRid = randomUUID();
      expect(errorCode(await get("/api/v1/stores", admin, expiredRid).expect(403))).toBe("support_session_expired");
      const expiredRow = await crossTenantRowFor(expiredRid);
      expect(expiredRow.metadata).toMatchObject({ reason: "support_session_expired", support_session_id: sessionId, purpose: "incident" });
      expect(validateAccess(expiredRow.metadata)).toBe(true);
      expect(errorCode(await post(`${BASE}/current/renew`, admin).expect(409))).toBe("support_session_expired");
      expect(body(await get(`${BASE}/current`, admin).expect(200))["support_session"]).toMatchObject({ status: "expired" });
      expect(body(await get("/api/v1/context/me", admin).expect(200))["support_session"]).toMatchObject({ status: "expired" });
    });

    it("ends an expired session, clears the active tenant, and leaves nothing to renew or end", async () => {
      if (dockerSkipped) return;
      const endRid = randomUUID();
      const ended = body(await post(`${BASE}/current/end`, admin, endRid).expect(200));
      expect(ended).toMatchObject({ id: sessionId, status: "ended", end_reason: "operator" });
      expect(validateSession(ended)).toBe(true);
      const endRows = await rowsFor(endRid);
      expect(endRows.map((r) => r.action)).toEqual(["platform.support_session.ended"]);
      expect(endRows[0]!.metadata).toMatchObject({ end_reason: "operator" });
      expect(validateChange(endRows[0]!.metadata)).toBe(true);
      expect(body(await get("/api/v1/context/me", admin).expect(200))["active_tenant"]).toBeNull();
      expect(body(await get(`${BASE}/current`, admin).expect(200))["support_session"]).toBeNull();
      expect(errorCode(await post(`${BASE}/current/renew`, admin).expect(409))).toBe("support_session_absent");
      expect(errorCode(await post(`${BASE}/current/end`, admin).expect(409))).toBe("support_session_absent");
    });
  });

  it("caps renewal at opened_at + 8 hours", async () => {
    if (dockerSkipped) return;
    const admin = await signIn(ADMIN);
    const id = String(body(await open(admin, ACME).expect(201))["id"]);
    await shiftSession(
      id,
      `opened_at = now() - interval '7 hours 30 minutes', renewal_cap_at = now() + interval '30 minutes',
       expires_at = now() + interval '10 minutes'`,
    );
    const renewed = body(await post(`${BASE}/current/renew`, admin).expect(200));
    expect(renewed["expires_at"]).toBe(renewed["renewal_cap_at"]);
    expect(errorCode(await post(`${BASE}/current/renew`, admin).expect(409))).toBe(
      "support_session_renewal_cap_reached",
    );
    await post(`${BASE}/current/end`, admin).expect(200);
  });

  it("ends the previous session when a new one is opened (replaced)", async () => {
    if (dockerSkipped) return;
    const admin = await signIn(ADMIN);
    const first = String(body(await open(admin, ACME).expect(201))["id"]);
    const rid = randomUUID();
    const second = body(await post(BASE, admin, rid).send({ tenant_id: OTHER, purpose: "onboarding" }).expect(201));
    const actions = (await rowsFor(rid)).map((r) => [r.action, r.metadata["support_session_id"], r.metadata["end_reason"]]);
    expect(actions).toEqual([
      ["platform.support_session.ended", first, "replaced"],
      ["platform.support_session.opened", second["id"], undefined],
    ]);
    const { rows } = await E().admin.query(
      `SELECT id, end_reason FROM platform_support_sessions WHERE id = ANY($1::uuid[]) ORDER BY opened_at`,
      [[first, second["id"]]],
    );
    expect(rows.map((r: { end_reason: string | null }) => r.end_reason)).toEqual(["replaced", null]);
    await post(`${BASE}/current/end`, admin).expect(200);
  });

  it("ends the session on a tenant switch and on sign-out", async () => {
    if (dockerSkipped) return;
    const memberAdmin = await signIn(MEMBER_ADMIN);
    const viaSwitch = String(body(await open(memberAdmin, OTHER).expect(201))["id"]);
    const switched = body(await post("/api/v1/context/tenant", memberAdmin).send({ tenant_id: ACME }).expect(200));
    expect(switched["support_session"]).toBeNull();
    const a = await E().admin.query(`SELECT end_reason FROM platform_support_sessions WHERE id = $1`, [viaSwitch]);
    expect(a.rows[0].end_reason).toBe("tenant_switched");

    const admin = await signIn(ADMIN);
    const viaSignOut = String(body(await open(admin, ACME).expect(201))["id"]);
    await post("/api/v1/auth/signout", admin).expect(204);
    const b = await E().admin.query(`SELECT end_reason FROM platform_support_sessions WHERE id = $1`, [viaSignOut]);
    expect(b.rows[0].end_reason).toBe("signed_out");
  });

  it("leaves a member platform admin unchanged: no support session, no row", async () => {
    if (dockerSkipped) return;
    const memberAdmin = await signIn(MEMBER_ADMIN);
    await post("/api/v1/context/tenant", memberAdmin).send({ tenant_id: ACME }).expect(200);
    const rid = randomUUID();
    await get("/api/v1/stores", memberAdmin, rid).expect(200);
    await get(`/api/v1/tenants/${ACME}/members`, memberAdmin, rid).expect(200);
    expect((await rowsFor(rid)).filter((r) => r.action === "platform.cross_tenant.accessed")).toEqual([]);
  });

  it("refuses an unresolvable path tenant like a non-member, with a platform-scoped row", async () => {
    if (dockerSkipped) return;
    const admin = await signIn(ADMIN);
    for (const segment of ["not-a-uuid", UNKNOWN]) {
      const rid = randomUUID();
      const res = await get(`/api/v1/tenants/${segment}/members`, admin, rid).expect(403);
      expect(errorCode(res)).toBe("support_session_required");
      const row = await crossTenantRowFor(rid);
      expect(row.tenant_id).toBeNull();
      expect(validateAccess(row.metadata)).toBe(true);
    }
  });

  it("opens a suspended tenant read-only, but lets the platform reactivate it (status-only PATCH)", async () => {
    if (dockerSkipped) return;
    const admin = await signIn(ADMIN);
    const id = String(body(await open(admin, PAUSED).expect(201))["id"]);
    await get("/api/v1/stores", admin).expect(200);

    const writeRid = randomUUID();
    const write = await post("/api/v1/stores", admin, writeRid).send({ code: "RO1", name: "Read only" }).expect(403);
    expect(errorCode(write)).toBe("support_session_read_only");
    const row = await crossTenantRowFor(writeRid);
    expect(row.metadata).toMatchObject({ outcome: "rejected", reason: "support_session_read_only", support_session_id: id, method: "POST" });
    expect(validateAccess(row.metadata)).toBe(true);

    // updateTenant changing anything but status is a write: refused, audited.
    const renameRid = randomUUID();
    const rename = await http()
      .patch(`/api/v1/tenants/${PAUSED}`)
      .set("Cookie", admin)
      .set(SAME_ORIGIN)
      .set("x-request-id", renameRid)
      .send({ status: "active", name: "Renamed" })
      .expect(403);
    expect(errorCode(rename)).toBe("support_session_read_only");
    expect((await crossTenantRowFor(renameRid)).metadata).toMatchObject({
      reason: "support_session_read_only",
      route: "/api/v1/tenants/:id",
      method: "PATCH",
    });

    // A status-only PATCH (reactivation) is admitted, and still audited.
    const reactivateRid = randomUUID();
    await http()
      .patch(`/api/v1/tenants/${PAUSED}`)
      .set("x-request-id", reactivateRid)
      .set("Cookie", admin)
      .set(SAME_ORIGIN)
      .send({ status: "active" })
      .expect(200);
    const { rows } = await E().admin.query(`SELECT status, name FROM tenants WHERE id = $1`, [PAUSED]);
    expect(rows[0]).toEqual({ status: "active", name: "Paused" });
    expect((await crossTenantRowFor(reactivateRid)).metadata).toMatchObject({
      outcome: "succeeded",
      support_session_id: id,
      method: "PATCH",
    });
    await post(`${BASE}/current/end`, admin).expect(200);
  });
});

// ---------------------------------------------------------------------------
// RT-430 Origin refusals on covered routes (decision 2: every verdict branch)
// ---------------------------------------------------------------------------
describe("RT-414 support sessions — Origin refusal audit", () => {
  function foreignPost(path: Path, cookie: Cookie, rid: RequestId): request.Test {
    return http()
      .post(path)
      .set("Cookie", cookie)
      .set("Host", "api.test")
      .set("Origin", "https://evil.example")
      .set("x-request-id", rid);
  }

  async function crossTenantRows(rid: RequestId): Promise<AuditRow[]> {
    return (await rowsFor(rid)).filter((r) => r.action === "platform.cross_tenant.accessed");
  }

  it("no support session for the tenant → support_session_required (the contract's order), audited", async () => {
    if (dockerSkipped) return;
    const admin = await signIn(ADMIN);
    await forceActiveTenant(admin, ACME);
    const rid = randomUUID();
    const res = await foreignPost("/api/v1/stores", admin, rid).send({ code: "O1", name: "x" }).expect(403);
    expect(errorCode(res)).toBe("support_session_required");
    const row = await crossTenantRowFor(rid);
    expect(row.metadata).toMatchObject({ reason: "support_session_required", support_session_id: null, method: "POST" });
    expect(validateAccess(row.metadata)).toBe(true);
  });

  it("an expired support session → support_session_expired, audited with the session", async () => {
    if (dockerSkipped) return;
    const admin = await signIn(ADMIN);
    const id = String(body(await open(admin, ACME).expect(201))["id"]);
    await shiftSession(
      id,
      `opened_at = now() - interval '2 hours', renewal_cap_at = now() + interval '6 hours',
       expires_at = now() - interval '1 minute'`,
    );
    const rid = randomUUID();
    const res = await foreignPost("/api/v1/stores", admin, rid).send({ code: "O2", name: "x" }).expect(403);
    expect(errorCode(res)).toBe("support_session_expired");
    expect((await crossTenantRowFor(rid)).metadata).toMatchObject({ reason: "support_session_expired", support_session_id: id });
    await post(`${BASE}/current/end`, admin).expect(200);
  });

  it("an unresolvable path tenant → support_session_required with a platform-scoped row", async () => {
    if (dockerSkipped) return;
    const admin = await signIn(ADMIN);
    const rid = randomUUID();
    const res = await http()
      .patch(`/api/v1/tenants/${UNKNOWN}`)
      .set("Cookie", admin)
      .set("Host", "api.test")
      .set("Origin", "https://evil.example")
      .set("x-request-id", rid)
      .send({ status: "active" })
      .expect(403);
    expect(errorCode(res)).toBe("support_session_required");
    expect((await crossTenantRowFor(rid)).tenant_id).toBeNull();
  });

  it("everyone else keeps the plain RT-430 refusal and writes no row", async () => {
    if (dockerSkipped) return;
    // A member platform admin.
    const memberAdmin = await signIn(MEMBER_ADMIN);
    await post("/api/v1/context/tenant", memberAdmin).send({ tenant_id: ACME }).expect(200);
    const memberRid = randomUUID();
    expect(errorCode(await foreignPost("/api/v1/stores", memberAdmin, memberRid).send({ code: "O3", name: "x" }).expect(403))).toBe(
      "origin_rejected",
    );
    expect(await crossTenantRows(memberRid)).toEqual([]);

    // A tenant member who is not a platform admin.
    const owner = await signIn(OWNER);
    await post("/api/v1/context/tenant", owner).send({ tenant_id: ACME }).expect(200);
    const ownerRid = randomUUID();
    expect(errorCode(await foreignPost("/api/v1/stores", owner, ownerRid).send({ code: "O4", name: "x" }).expect(403))).toBe(
      "origin_rejected",
    );
    expect(await crossTenantRows(ownerRid)).toEqual([]);

    // A platform admin on a route RT-414 does not cover.
    const admin = await signIn(ADMIN);
    const uncoveredRid = randomUUID();
    expect(
      errorCode(await foreignPost("/api/v1/context/tenant", admin, uncoveredRid).send({ tenant_id: ACME }).expect(403)),
    ).toBe("origin_rejected");
    expect(await crossTenantRows(uncoveredRid)).toEqual([]);

    // An unknown cookie.
    const unknownRid = randomUUID();
    expect(
      errorCode(await foreignPost("/api/v1/stores", "dp2_session=not-a-real-session", unknownRid).send({}).expect(403)),
    ).toBe("origin_rejected");
    expect(await crossTenantRows(unknownRid)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Visibility, PII and RLS
// ---------------------------------------------------------------------------
describe("RT-414 support sessions — visibility, PII and RLS", () => {
  it("shows every support row to the tenant's owner and tenant_admin, not to staff", async () => {
    if (dockerSkipped) return;
    for (const userId of [OWNER, TADMIN]) {
      const cookie = await signIn(userId);
      await post("/api/v1/context/tenant", cookie).send({ tenant_id: ACME }).expect(200);
      const res = await get("/api/v1/audit/events?action=platform.&limit=200", cookie).expect(200);
      const items = (res.body as { items: Array<{ action: string; actor_label: string; tenant_id: string }> }).items;
      const actions = new Set(items.map((i) => i.action));
      for (const action of [
        "platform.support_session.opened",
        "platform.support_session.renewed",
        "platform.support_session.ended",
        "platform.cross_tenant.accessed",
      ]) {
        expect(actions.has(action)).toBe(true);
      }
      expect(items.every((i) => i.tenant_id === ACME && i.actor_label === "platform_support")).toBe(true);
    }
    const staff = await signIn(STAFF);
    await post("/api/v1/context/tenant", staff).send({ tenant_id: ACME }).expect(200);
    await get("/api/v1/audit/events", staff).expect(403);
  });

  it("stores only allowlisted metadata: no email, token or cookie", async () => {
    if (dockerSkipped) return;
    const { rows } = await E().admin.query<AuditRow>(
      `SELECT tenant_id, actor_user_id, actor_label, action, request_id, metadata
         FROM audit_events WHERE action LIKE 'platform.%'`,
    );
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      const ok =
        row.action === "platform.cross_tenant.accessed"
          ? validateAccess(row.metadata)
          : validateChange(row.metadata);
      expect(ok).toBe(true);
      expect(JSON.stringify(row.metadata)).not.toMatch(/@|dp2_session|Bearer/);
    }
  });

  it("keeps platform_support_sessions platform-only, frozen and undeletable (0062)", async () => {
    if (dockerSkipped) return;
    const app_ = E().app;
    const tenantCtx = await app_.connect();
    try {
      await tenantCtx.query("BEGIN");
      await tenantCtx.query(`SELECT set_config('app.current_tenant', $1, true), set_config('app.is_platform_admin', 'false', true)`, [ACME]);
      const seen = await tenantCtx.query(`SELECT count(*)::int AS n FROM platform_support_sessions`);
      expect(seen.rows[0].n).toBe(0);
      await expect(
        tenantCtx.query(
          `INSERT INTO platform_support_sessions (id, auth_session_id, user_id, tenant_id, purpose, expires_at, renewal_cap_at)
           SELECT gen_random_uuid(), s.id, s.user_id, $1, 'incident', now() + interval '1 hour', now() + interval '8 hours'
             FROM sessions s LIMIT 1`,
          [ACME],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await tenantCtx.query("ROLLBACK").catch(() => undefined);
      tenantCtx.release();
    }

    const { rows } = await E().admin.query(`SELECT id FROM platform_support_sessions LIMIT 1`);
    const id = rows[0].id as string;
    await expect(E().admin.query(`DELETE FROM platform_support_sessions WHERE id = $1`, [id])).rejects.toMatchObject({ code: "42501" });
    await expect(E().admin.query(`TRUNCATE platform_support_sessions`)).rejects.toMatchObject({ code: "42501" });
    await expect(
      E().admin.query(`UPDATE platform_support_sessions SET purpose = 'onboarding' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
