/**
 * RT-430 — CSRF: a cookie-authenticated unsafe request needs a trusted Origin.
 *
 * End to end through the real guards and real Postgres. The app keeps Nest's
 * default body parsers, including `urlencoded`, so a plain HTML form POST
 * from a same-site sibling origin (which still carries the `SameSite=Lax`
 * session cookie) really does reach the routing layer. It must be refused
 * with 403 `origin_rejected` before any handler runs or any row changes.
 *
 * Pinned here (owner decision on RT-430, 2026-10-12):
 *   - a sibling-origin or `null`-origin form POST, and a write with no
 *     Origin, are refused on representative routes (stores, tenants,
 *     context, sign-out);
 *   - the API's own origin (from `Host`) and an `ALLOWED_ORIGINS` entry pass;
 *   - safe methods are unaffected;
 *   - sign-in refuses a foreign Origin and admits a missing one;
 *   - a bearer-authenticated write is not checked (not an ambient credential).
 *
 * Skip: `MIGRATION_TEST_ALLOW_SKIP=1` soft-skips when Docker is unavailable;
 * otherwise a container failure fails the suite.
 */
import "reflect-metadata";

import { generateRawToken, hashPassword, hashToken } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Pool } from "pg";
import request from "supertest";

import {
  AUTH_LOOKUP_POOL,
  AuthModule,
  PG_POOL,
  REDIS_CLIENT,
} from "../../src/auth/auth.module";
import {
  EMAIL_JOB_ENQUEUER,
  NoOpEmailJobEnqueuer,
} from "../../src/auth/email-job.enqueuer";
import type { RedisLike } from "../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { LoggingInterceptor } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { ContextInterceptor } from "../../src/context/context.interceptor";
import { ContextModule } from "../../src/context/context.module";
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

// ---- Fixture IDs ---------------------------------------------------------

const BOB_ID = "43000000-0000-4000-8000-0000000000b1"; // tenant_admin of Acme
const BOB_EMAIL = "bob.rt430@example.com";
const BOB_PASSWORD = "Bob-Password-430!";

const ACME_ID = "43000000-0000-4000-8000-0000000000c1";
const ROLE_TENANT_ADMIN = "43000000-0000-4000-8000-0000000000d1";
const MEMBERSHIP_BOB = "43000000-0000-4000-8000-0000000000e1";
const STORE_BR1 = "43000000-0000-4000-8000-0000000000f1";

const BOB_DASHBOARD_TOKEN = generateRawToken();

const HOST = SAME_ORIGIN.Host;
const SIBLING = "http://evil.api.test";
const CONSOLE_DEV = "http://console.test:5173";

// ---- Bootstrap -------------------------------------------------------------

let env: PgTestEnv | null = null;
let admin: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

async function seed(): Promise<void> {
  const pg = admin!;
  await pg.query(
    `INSERT INTO users (id, email, password_hash, is_platform_admin) VALUES ($1, $2, $3, false)`,
    [BOB_ID, BOB_EMAIL, await hashPassword(BOB_PASSWORD)],
  );
  await pg.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'acme-rt430', 'Acme')`, [ACME_ID]);
  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'tenant_admin', 'Tenant Admin')`,
    [ROLE_TENANT_ADMIN, ACME_ID],
  );
  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1, $2, $3, $4, 'all')`,
    [MEMBERSHIP_BOB, ACME_ID, BOB_ID, ROLE_TENANT_ADMIN],
  );
  await pg.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'BR-01', 'Acme Branch 1')`,
    [STORE_BR1, ACME_ID],
  );
  await pg.query(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'dashboard_api', now() + interval '1 hour')`,
    [hashToken(BOB_DASHBOARD_TOKEN), ACME_ID, BOB_ID],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    admin = env.admin; // superuser — seed + raw assertions only
    await seed();

    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, TenantsModule, StoresModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(env.app) // non-superuser app role — RLS enforced
      .overrideProvider(AUTH_LOOKUP_POOL)
      .useValue(env.admin)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new AlwaysAllowRedis())
      .overrideProvider(EMAIL_JOB_ENQUEUER)
      .useValue(new NoOpEmailJobEnqueuer())
      .compile();

    // Default body parsers stay on (json + urlencoded), as in main.ts.
    app = moduleRef.createNestApplication({ bufferLogs: true });
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[origin-check.http.integration] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

const envBackup = { ...process.env };
afterEach(() => {
  process.env = { ...envBackup };
});

function http() {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[origin-check.http.integration] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

function sessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.find((c: string) => c.startsWith("dp2_session="))!.split(";")[0]!;
}

/** Bob, signed in from the Console's origin, with Acme as the active tenant. */
async function bobSession(): Promise<string> {
  const res = await http()
    .post("/api/v1/auth/signin")
    .set(SAME_ORIGIN)
    .send({ email: BOB_EMAIL, password: BOB_PASSWORD })
    .expect(200);
  const cookie = sessionCookie(res);
  await http()
    .post("/api/v1/context/tenant")
    .set(SAME_ORIGIN)
    .set("Cookie", cookie)
    .send({ tenant_id: ACME_ID })
    .expect(200);
  return cookie;
}

async function storeCount(): Promise<number> {
  const { rows } = await admin!.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM stores WHERE tenant_id = $1",
    [ACME_ID],
  );
  return Number(rows[0]!.n);
}

async function tenantName(): Promise<string> {
  const { rows } = await admin!.query<{ name: string }>("SELECT name FROM tenants WHERE id = $1", [ACME_ID]);
  return rows[0]!.name;
}

function expectOriginRejected(res: request.Response): void {
  expect(res.status).toBe(403);
  expect(res.body).toMatchObject({ error: { code: "origin_rejected" } });
}

// ===== refused =============================================================

describe("RT-430 — cookie-authenticated writes from an untrusted Origin are refused", () => {
  it("a sibling-origin HTML form POST /stores → 403 origin_rejected, no store created", async () => {
    if (maybeSkip()) return;
    const cookie = await bobSession();
    const before = await storeCount();
    const res = await http()
      .post("/api/v1/stores")
      .set("Host", HOST)
      .set("Origin", SIBLING)
      .set("Cookie", cookie)
      .type("form")
      .send("code=BR-EVIL&name=Evil+Branch");
    expectOriginRejected(res);
    expect(await storeCount()).toBe(before);
  });

  it("a form POST with the opaque `null` Origin (sandboxed frame) → 403 origin_rejected", async () => {
    if (maybeSkip()) return;
    const cookie = await bobSession();
    const before = await storeCount();
    const res = await http()
      .post("/api/v1/stores")
      .set("Host", HOST)
      .set("Origin", "null")
      .set("Cookie", cookie)
      .type("form")
      .send("code=BR-NULL&name=Null+Branch");
    expectOriginRejected(res);
    expect(await storeCount()).toBe(before);
  });

  it("a write with no Origin → 403 origin_rejected (fail closed)", async () => {
    if (maybeSkip()) return;
    const cookie = await bobSession();
    const res = await http()
      .patch(`/api/v1/tenants/${ACME_ID}`)
      .set("Host", HOST)
      .set("Cookie", cookie)
      .send({ name: "Pwned" });
    expectOriginRejected(res);
    expect(await tenantName()).toBe("Acme");
  });

  it("a sibling-origin DELETE /stores/:id → 403 origin_rejected, store not deleted", async () => {
    if (maybeSkip()) return;
    const cookie = await bobSession();
    const res = await http()
      .delete(`/api/v1/stores/${STORE_BR1}`)
      .set("Host", HOST)
      .set("Origin", SIBLING)
      .set("Cookie", cookie);
    expectOriginRejected(res);
    const { rows } = await admin!.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM stores WHERE id = $1",
      [STORE_BR1],
    );
    expect(rows[0]!.deleted_at).toBeNull();
  });

  it("a sibling-origin form POST /context/store → 403 origin_rejected", async () => {
    if (maybeSkip()) return;
    const cookie = await bobSession();
    const res = await http()
      .post("/api/v1/context/store")
      .set("Host", HOST)
      .set("Origin", SIBLING)
      .set("Cookie", cookie)
      .type("form")
      .send(`store_id=${STORE_BR1}`);
    expectOriginRejected(res);
  });

  it("a sibling-origin POST /auth/signout → 403, and the session stays live", async () => {
    if (maybeSkip()) return;
    const cookie = await bobSession();
    const res = await http()
      .post("/api/v1/auth/signout")
      .set("Host", HOST)
      .set("Origin", SIBLING)
      .set("Cookie", cookie);
    expectOriginRejected(res);
    await http().get("/api/v1/context/me").set("Cookie", cookie).expect(200);
  });

  it("an http Origin is not the API's https origin outside test/development", async () => {
    if (maybeSkip()) return;
    const cookie = await bobSession();
    process.env["NODE_ENV"] = "production";
    const res = await http()
      .patch(`/api/v1/tenants/${ACME_ID}`)
      .set(SAME_ORIGIN)
      .set("Cookie", cookie)
      .send({ name: "Pwned" });
    expectOriginRejected(res);
    expect(await tenantName()).toBe("Acme");
  });
});

// ===== admitted ============================================================

describe("RT-430 — trusted origins, safe methods and bearer writes still work", () => {
  it("a same-origin form POST /stores → 201", async () => {
    if (maybeSkip()) return;
    const cookie = await bobSession();
    const before = await storeCount();
    await http()
      .post("/api/v1/stores")
      .set(SAME_ORIGIN)
      .set("Cookie", cookie)
      .type("form")
      .send("code=BR-SAME&name=Same+Origin")
      .expect(201);
    expect(await storeCount()).toBe(before + 1);
  });

  it("the API's own https origin passes outside test/development", async () => {
    if (maybeSkip()) return;
    const cookie = await bobSession();
    process.env["NODE_ENV"] = "production";
    await http()
      .post("/api/v1/stores")
      .set("Host", HOST)
      .set("Origin", `https://${HOST}`)
      .set("Cookie", cookie)
      .send({ code: "BR-TLS", name: "Https Origin" })
      .expect(201);
  });

  it("an ALLOWED_ORIGINS entry passes", async () => {
    if (maybeSkip()) return;
    const cookie = await bobSession();
    process.env["ALLOWED_ORIGINS"] = `https://other.test,${CONSOLE_DEV}`;
    await http()
      .post("/api/v1/stores")
      .set("Host", HOST)
      .set("Origin", CONSOLE_DEV)
      .set("Cookie", cookie)
      .send({ code: "BR-DEV", name: "Dev Console" })
      .expect(201);
  });

  it("a GET with a foreign Origin is unaffected", async () => {
    if (maybeSkip()) return;
    const cookie = await bobSession();
    await http()
      .get("/api/v1/stores")
      .set("Host", HOST)
      .set("Origin", SIBLING)
      .set("Cookie", cookie)
      .expect(200);
  });

  it("a bearer-authenticated write is not Origin-checked", async () => {
    if (maybeSkip()) return;
    await http()
      .post("/api/v1/stores")
      .set("Host", HOST)
      .set("Origin", SIBLING)
      .set("Authorization", `Bearer ${BOB_DASHBOARD_TOKEN}`)
      .send({ code: "BR-BEARER", name: "Bearer Branch" })
      .expect(201);
    await http()
      .post("/api/v1/stores")
      .set("Host", HOST)
      .set("Authorization", `Bearer ${BOB_DASHBOARD_TOKEN}`)
      .send({ code: "BR-NOORIGIN", name: "No Origin Bearer" })
      .expect(201);
  });
});

// ===== sign-in (login CSRF) ================================================

describe("RT-430 — sign-in", () => {
  it("a sibling-origin sign-in → 403 origin_rejected, no session cookie", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/v1/auth/signin")
      .set("Host", HOST)
      .set("Origin", SIBLING)
      .type("form")
      .send(`email=${encodeURIComponent(BOB_EMAIL)}&password=${encodeURIComponent(BOB_PASSWORD)}`);
    expectOriginRejected(res);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("a sign-in with no Origin is admitted", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: BOB_EMAIL, password: BOB_PASSWORD })
      .expect(200);
    expect(sessionCookie(res)).toMatch(/^dp2_session=/);
  });
});
