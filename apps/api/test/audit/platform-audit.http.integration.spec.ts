/**
 * platform-audit.http.integration.spec.ts — RT-431 runtime
 * (`listPlatformAuditEvents`, audit.openapi.yaml 1.3.0-draft).
 *
 * End to end on real PostgreSQL (all migrations) and the production modules,
 * no guard overridden: the domain pool (PG_POOL) is the NOBYPASSRLS
 * `app_test` role, the pre-tenant lookup pool is the admin pool. Only Redis,
 * email and the async audit enqueuer are substituted. Pins RT-431 D1–D5:
 *
 *   - who may call it: platform-admin cookie only (401 for no cookie or a
 *     bearer; 403 for a tenant owner or staff, before query validation);
 *   - a platform admin with no active tenant gets 200; an active tenant or an
 *     open support session changes nothing, and no
 *     `platform.cross_tenant.accessed` row is written;
 *   - null-tenant rows only: tenant rows that match every filter never appear;
 *   - filters (literal prefix, kind, actor, inclusive from/to), the closed
 *     query set, and the RT-211 sub-millisecond keyset walk;
 *   - `actor_label` masking; every 200 body validates against
 *     `PlatformAuditEventList`.
 *
 * NOTE: CI runs Testcontainers (db-integration; never sets
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
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
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
type Query = Record<string, string>;

// Fixtures (hex-only UUID suffixes)
const ACME = "04310000-0000-4000-8000-0000000000a1";
const ROLE_OWNER = "04310000-0000-4000-8000-0000000001a1";
const ROLE_STAFF = "04310000-0000-4000-8000-0000000001a3";
/** Platform admin, member of no tenant. */
const ADMIN = "04310000-0000-4000-8000-0000000002a1";
const OWNER = "04310000-0000-4000-8000-0000000002a3";
const STAFF = "04310000-0000-4000-8000-0000000002a5";
/** A second actor on platform rows. */
const OTHER_ACTOR = "04310000-0000-4000-8000-0000000002b1";

const PASSWORD = "Rt431-Password-ok!";
const EMAIL: Record<Uuid, string> = {
  [ADMIN]: "admin.rt431@example.com",
  [OWNER]: "owner.rt431@example.com",
  [STAFF]: "staff.rt431@example.com",
  [OTHER_ACTOR]: "other.rt431@example.com",
};
const OWNER_TOKEN = generateRawToken();

const PATH = "/api/v1/platform/audit/events";
const PREFIX = "rt431.";
const READ_CODE = "cash_variance_policy.tenant_read";

// Platform rows (tenant_id NULL), newest first. N1..N3 share one millisecond
// (N2_HI / N2_LO tie at the same microsecond: id DESC breaks it); N4 is the
// previous millisecond, N5 a day earlier.
const N1 = "04310000-0000-4000-8000-0000000003c1";
const N2_HI = "04310000-0000-4000-8000-0000000003c3";
const N2_LO = "04310000-0000-4000-8000-0000000003c2";
const N3 = "04310000-0000-4000-8000-0000000003c0";
const N4 = "04310000-0000-4000-8000-0000000003b9";
const N5 = "04310000-0000-4000-8000-0000000003b8";
const EXPECTED_ORDER = [N1, N2_HI, N2_LO, N3, N4, N5];
const MS = "2026-10-20T12:00:00.123";
// Millisecond-exact: `from` / `to` parse to a JS Date (ms), as for listAuditEvents.
const N4_AT = "2026-10-20T12:00:00.122Z";
const N5_AT = "2026-10-19T12:00:00.000000Z";
/** A literal `_` in the action: `rt431_x` must not match a prefix of `rt431.`. */
const LITERAL = "04310000-0000-4000-8000-0000000003d1";
const LITERAL_DECOY = "04310000-0000-4000-8000-0000000003d2";
const READ_ROW = "04310000-0000-4000-8000-0000000003e1";
// Tenant rows that match every filter the platform rows match.
const T1 = "04310000-0000-4000-8000-0000000004a1";
const T2 = "04310000-0000-4000-8000-0000000004a2";

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

async function seedPrincipals(e: PgTestEnv): Promise<void> {
  const hash = await hashPassword(PASSWORD);
  for (const id of [ADMIN, OWNER, STAFF, OTHER_ACTOR]) {
    await e.admin.query(
      `INSERT INTO users (id, email, password_hash, is_platform_admin) VALUES ($1, $2, $3, $4)`,
      [id, EMAIL[id], hash, id === ADMIN],
    );
  }
  await e.admin.query(
    `INSERT INTO tenants (id, slug, name, status) VALUES ($1, 'rt431-acme', 'Acme', 'active')`,
    [ACME],
  );
  await e.admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $3, 'owner', 'Owner'), ($2, $3, 'store_staff', 'Staff')`,
    [ROLE_OWNER, ROLE_STAFF, ACME],
  );
  await e.admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       (gen_random_uuid(), $1, $2, $4, 'all'), (gen_random_uuid(), $1, $3, $5, 'all')`,
    [ACME, OWNER, STAFF, ROLE_OWNER, ROLE_STAFF],
  );
  await e.admin.query(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'dashboard_api', now() + interval '1 day')`,
    [hashToken(OWNER_TOKEN), ACME, OWNER],
  );
}

async function seedAudit(e: PgTestEnv): Promise<void> {
  const row = (
    id: Uuid,
    at: string,
    tenant: Uuid | null,
    action: string,
    actor: Uuid | null,
    label: string | null,
  ): Promise<unknown> =>
    e.admin.query(
      `INSERT INTO audit_events (id, occurred_at, tenant_id, actor_user_id, actor_label, action, metadata)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, '{}'::jsonb)`,
      [id, at, tenant, actor, label, action],
    );
  await row(N1, `${MS}900Z`, null, `${PREFIX}signin.ok`, ADMIN, "alice@example.com");
  await row(N2_HI, `${MS}500Z`, null, `${PREFIX}signin.ok`, ADMIN, "platform_support");
  await row(N2_LO, `${MS}500Z`, null, `${PREFIX}signin.ok`, ADMIN, null);
  await row(N3, `${MS}100Z`, null, `${PREFIX}signin.failed`, null, "typed@example.org");
  await row(N4, N4_AT, null, `${PREFIX}signin.ok`, ADMIN, null);
  await row(N5, N5_AT, null, `${PREFIX}signin.ok`, OTHER_ACTOR, null);
  await row(LITERAL, "2026-10-18T00:00:00Z", null, "rt431_x.literal", null, null);
  await row(LITERAL_DECOY, "2026-10-18T00:00:00Z", null, "rt431ax.literal", null, null);
  await row(READ_ROW, "2026-10-17T00:00:00Z", null, READ_CODE, ADMIN, null);
  // Tenant rows in the same millisecond, same action prefix, same actor.
  await row(T1, `${MS}700Z`, ACME, `${PREFIX}signin.ok`, ADMIN, "owner.rt431@example.com");
  await row(T2, `${MS}300Z`, ACME, READ_CODE, ADMIN, null);
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[platform-audit.http] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedPrincipals(env);
  await seedAudit(env);

  const moduleRef = await Test.createTestingModule({
    imports: [AuthModule, ContextModule, AuditModule, PlatformSupportSessionsModule],
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

// Helpers
const cookies = new Map<Uuid, Cookie>();
async function signIn(userId: Uuid): Promise<Cookie> {
  const cached = cookies.get(userId);
  if (cached) return cached;
  const res = await http()
    .post("/api/v1/auth/signin")
    .set(SAME_ORIGIN)
    .send({ email: EMAIL[userId], password: PASSWORD })
    .expect(200);
  const cookie = [res.headers["set-cookie"] ?? []].flat().find((c: string) => c.startsWith("dp2_session="))!.split(";")[0]!;
  cookies.set(userId, cookie);
  return cookie;
}

function list(cookie: Cookie, query: Query = {}, requestId: Uuid = randomUUID()): request.Test {
  return http().get(PATH).query(query).set("Cookie", cookie).set("x-request-id", requestId);
}

interface Item {
  id: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  actor_label: string | null;
  action: string;
  kind: string;
}
interface Page {
  items: Item[];
  next_cursor: string | null;
}

let validatePage: (v: unknown) => boolean;
beforeAll(() => {
  const found = loadOpenApiContracts().find((c) => c.id === "audit.openapi")!;
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(found.document as object, "audit");
  validatePage = ajv.getSchema("audit#/components/schemas/PlatformAuditEventList")!;
});

/** GET as the platform admin, expect 200, validate against the contract. */
async function adminPage(query: Query = {}, requestId?: Uuid): Promise<Page> {
  const res = await list(await signIn(ADMIN), query, requestId).expect(200);
  expect(validatePage(res.body)).toBe(true);
  return res.body as Page;
}
function ids(page: Page): string[] {
  return page.items.map((i) => i.id);
}
function errorCode(res: request.Response): string | undefined {
  return (res.body as { error?: { code?: string } }).error?.code;
}
async function crossTenantRows(requestId: Uuid): Promise<number> {
  const { rows } = await E().admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_events
      WHERE request_id = $1 AND action = 'platform.cross_tenant.accessed'`,
    [requestId],
  );
  return Number(rows[0]!.n);
}
/** Point the session's active tenant at ACME without a support session. */
async function forceActiveTenant(userId: Uuid, tenantId: Uuid | null): Promise<void> {
  await E().admin.query(
    `UPDATE sessions SET active_tenant_id = $1, active_store_id = NULL
      WHERE user_id = $2 AND revoked_at IS NULL`,
    [tenantId, userId],
  );
}

describe("RT-431 platform audit — callers", () => {
  it("refuses a request with no cookie with 401", async () => {
    if (dockerSkipped) return;
    expect((await http().get(PATH)).status).toBe(401);
  });

  it("refuses a dashboard_api bearer of a tenant owner with 401", async () => {
    if (dockerSkipped) return;
    const res = await http().get(PATH).set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it.each([
    ["a tenant owner", OWNER],
    ["a store staff member", STAFF],
  ])("refuses %s with 403 forbidden", async (_name, userId) => {
    if (dockerSkipped) return;
    const res = await list(await signIn(userId)).expect(403);
    expect(errorCode(res)).toBe("forbidden");
  });

  it("refuses a non-admin with 403 before validating the query", async () => {
    if (dockerSkipped) return;
    const res = await list(await signIn(OWNER), { tenant_id: ACME, limit: "0" }).expect(403);
    expect(errorCode(res)).toBe("forbidden");
  });

  it("serves a platform admin with no active tenant", async () => {
    if (dockerSkipped) return;
    await forceActiveTenant(ADMIN, null);
    const page = await adminPage({ action: PREFIX });
    expect(ids(page)).toEqual(EXPECTED_ORDER);
  });
});

describe("RT-431 platform audit — not tenant-scoped (RT-414)", () => {
  it("returns the same rows with an active tenant and writes no cross-tenant row", async () => {
    if (dockerSkipped) return;
    await signIn(ADMIN);
    await forceActiveTenant(ADMIN, ACME);
    const requestId = randomUUID();
    const page = await adminPage({ action: PREFIX }, requestId);
    expect(ids(page)).toEqual(EXPECTED_ORDER);
    expect(await crossTenantRows(requestId)).toBe(0);
    await forceActiveTenant(ADMIN, null);
  });

  it("returns the same rows with an open support session and writes no cross-tenant row", async () => {
    if (dockerSkipped) return;
    const cookie = await signIn(ADMIN);
    await http()
      .post("/api/v1/platform/support-sessions")
      .set("Cookie", cookie)
      .set(SAME_ORIGIN)
      .send({ tenant_id: ACME, purpose: "customer_support" })
      .expect(201);
    const requestId = randomUUID();
    const page = await adminPage({ action: PREFIX }, requestId);
    expect(ids(page)).toEqual(EXPECTED_ORDER);
    expect(await crossTenantRows(requestId)).toBe(0);
    await http()
      .post("/api/v1/platform/support-sessions/current/end")
      .set("Cookie", cookie)
      .set(SAME_ORIGIN)
      .expect(200);
    await forceActiveTenant(ADMIN, null);
  });
});

describe("RT-431 platform audit — isolation and projection", () => {
  it("never returns a tenant row, whatever the filter", async () => {
    if (dockerSkipped) return;
    for (const query of [{}, { action: PREFIX }, { actor_user_id: ADMIN }, { kind: "read" }]) {
      const page = await adminPage({ ...query, limit: "200" });
      expect(page.items.every((i) => i.tenant_id === null)).toBe(true);
      expect(ids(page)).not.toEqual(expect.arrayContaining([T1]));
      expect(ids(page)).not.toEqual(expect.arrayContaining([T2]));
    }
  });

  it("masks email labels and returns other labels and the actor id as stored", async () => {
    if (dockerSkipped) return;
    const byId = new Map((await adminPage({ action: PREFIX })).items.map((i) => [i.id, i]));
    expect(byId.get(N1)!.actor_label).toBe("a***@example.com");
    expect(byId.get(N1)!.actor_user_id).toBe(ADMIN);
    expect(byId.get(N3)!.actor_label).toBe("t***@example.org");
    expect(byId.get(N2_HI)!.actor_label).toBe("platform_support");
    expect(byId.get(N2_LO)!.actor_label).toBeNull();
  });
});

describe("RT-431 platform audit — filters", () => {
  it("matches the action prefix literally", async () => {
    if (dockerSkipped) return;
    expect(ids(await adminPage({ action: "rt431_" }))).toEqual([LITERAL]);
  });

  it("filters by kind", async () => {
    if (dockerSkipped) return;
    const read = await adminPage({ kind: "read" });
    expect(ids(read)).toEqual([READ_ROW]);
    expect(read.items[0]!.kind).toBe("read");
    const change = await adminPage({ kind: "change", limit: "200" });
    expect(ids(change)).not.toContain(READ_ROW);
    expect(change.items.every((i) => i.kind === "change")).toBe(true);
  });

  it("filters by actor; an anonymous row never matches", async () => {
    if (dockerSkipped) return;
    expect(ids(await adminPage({ actor_user_id: OTHER_ACTOR }))).toEqual([N5]);
    expect(ids(await adminPage({ action: PREFIX, actor_user_id: ADMIN }))).not.toContain(N3);
  });

  it("treats from and to as inclusive bounds", async () => {
    if (dockerSkipped) return;
    expect(ids(await adminPage({ action: PREFIX, from: N4_AT, to: N4_AT }))).toEqual([N4]);
    expect(ids(await adminPage({ action: PREFIX, to: N5_AT }))).toEqual([N5]);
  });

  it.each([
    ["tenant_id", { tenant_id: ACME }],
    ["store_id", { store_id: ACME }],
    ["an unknown parameter", { foo: "bar" }],
    ["an unknown kind", { kind: "other" }],
    ["limit 0", { limit: "0" }],
    ["limit 201", { limit: "201" }],
    ["a malformed cursor", { cursor: "!!" }],
  ])("refuses %s with 400 validation_error", async (_name, query) => {
    if (dockerSkipped) return;
    const res = await list(await signIn(ADMIN), query).expect(400);
    expect(errorCode(res)).toBe("validation_error");
  });
});

describe("RT-431 platform audit — keyset paging (RT-211)", () => {
  it.each([1, 2, 4])("walks every platform row once with limit %i", async (limit) => {
    if (dockerSkipped) return;
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const query: Query = { action: PREFIX, limit: String(limit) };
      if (cursor) query["cursor"] = cursor;
      const page = await adminPage(query);
      seen.push(...ids(page));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(EXPECTED_ORDER);
  });

  it("continues after the first page and ends with a null cursor", async () => {
    if (dockerSkipped) return;
    const first = await adminPage({ action: PREFIX, limit: "1" });
    expect(first.next_cursor).not.toBeNull();
    const page = await adminPage({ action: PREFIX, limit: "6", cursor: first.next_cursor! });
    expect(ids(page)).toEqual(EXPECTED_ORDER.slice(1));
    expect(page.next_cursor).toBeNull();
  });
});
