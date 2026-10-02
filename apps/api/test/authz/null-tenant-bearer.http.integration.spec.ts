/**
 * RT-149 (RT-132 S1 / D6) — null-tenant bearer principals fail closed.
 *
 * Platform authority comes ONLY from a server-authenticated session user
 * with `users.is_platform_admin = true`. A bearer token with
 * `auth_tokens.tenant_id IS NULL` must never imply platform admin, for
 * any bearer scope (`dashboard_api`, `pos`, `pos_operator`, `connector`).
 * `auth_tokens.tenant_id` is nullable with no scope CHECK today (that
 * constraint is RT-132 S1b, separate/gated), so such a row is seedable —
 * which is exactly the latent A8 path this spec pins closed.
 *
 * Real Postgres via Testcontainers, all migrations applied. The Nest app's
 * domain pool (PG_POOL) is the non-superuser `app_test` role (RLS enforced);
 * AUTH_LOOKUP_POOL is the RLS-exempt superuser pool, standing in for the
 * production auth-lookup role that resolves bearer tokens before any tenant
 * GUC exists. The superuser pool also seeds rows and asserts raw DB state.
 *
 * The bearer tokens below belong to ALICE, who IS a platform admin in
 * `users` — so a pass here proves the token itself confers nothing, not
 * merely that the user lacks the flag. The same user signed in with a
 * session cookie is the preserved-behaviour control.
 *
 * Skip: `MIGRATION_TEST_ALLOW_SKIP=1` soft-skips when Docker is
 * unavailable; otherwise a container failure fails the suite.
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

class AlwaysAllowRedis implements RedisLike {
  async incr(): Promise<number> { return 1; }
  async pexpireNx(): Promise<number> { return 1; }
  async pttl(): Promise<number> { return -1; }
  async decr(): Promise<number> { return 0; }
  async del(): Promise<number> { return 0; }
}

// ---- Fixture IDs ---------------------------------------------------------

const ALICE_ID = "14900000-0000-4000-8000-0000000000a1"; // is_platform_admin = true
const ALICE_EMAIL = "alice.rt149@example.com";
const ALICE_PASSWORD = "Alice-Password-149!";

const ACME_ID = "14900000-0000-4000-8000-0000000000c1";
const GLOBEX_ID = "14900000-0000-4000-8000-0000000000c2";
const STORE_ACME_ID = "14900000-0000-4000-8000-0000000000d1";
const DEVICE_ACME_ID = "14900000-0000-4000-8000-0000000000e1";

type BearerScope = "dashboard_api" | "pos" | "pos_operator" | "connector";

/** Raw bearer secrets for null-tenant tokens, one per bearer scope. */
const NULL_TENANT_TOKENS: Record<BearerScope, string> = {
  dashboard_api: generateRawToken(),
  pos: generateRawToken(),
  pos_operator: generateRawToken(),
  connector: generateRawToken(),
};
/** A tenant-bound dashboard_api token for the same platform-admin user. */
const TENANT_BOUND_DASHBOARD_TOKEN = generateRawToken();

// ---- Bootstrap -------------------------------------------------------------

let env: PgTestEnv | null = null;
let admin: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

async function insertToken(
  raw: string,
  scope: BearerScope,
  tenantId: string | null,
): Promise<void> {
  // auth_tokens_principal_by_scope: pos_operator carries user + device;
  // `pos` is device-bound; other scopes are user-bound.
  const userId = scope === "pos" ? null : ALICE_ID;
  const deviceId = scope === "pos" || scope === "pos_operator" ? DEVICE_ACME_ID : null;
  await admin!.query(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, device_id, scope, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now() + interval '1 hour')`,
    [hashToken(raw), tenantId, userId, deviceId, scope],
  );
}

async function seed(): Promise<void> {
  const pg = admin!;
  await pg.query(
    `INSERT INTO users (id, email, password_hash, is_platform_admin)
     VALUES ($1, $2, $3, true)`,
    [ALICE_ID, ALICE_EMAIL, await hashPassword(ALICE_PASSWORD)],
  );
  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'acme-rt149', 'Acme'),
       ($2, 'globex-rt149', 'Globex')`,
    [ACME_ID, GLOBEX_ID],
  );
  await pg.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'BR-01', 'Acme Branch 1')`,
    [STORE_ACME_ID, ACME_ID],
  );
  await pg.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash)
     VALUES ($1, $2, $3, 'till-1', $4)`,
    [DEVICE_ACME_ID, ACME_ID, STORE_ACME_ID, hashToken(generateRawToken())],
  );
  for (const scope of Object.keys(NULL_TENANT_TOKENS) as BearerScope[]) {
    await insertToken(NULL_TENANT_TOKENS[scope], scope, null);
  }
  await insertToken(TENANT_BOUND_DASHBOARD_TOKEN, "dashboard_api", ACME_ID);
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
      // RLS-exempt credential lookup, as the production auth-lookup role
      // (same wiring as envelope-auth.http.integration.spec.ts).
      .overrideProvider(AUTH_LOOKUP_POOL)
      .useValue(env.admin)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new AlwaysAllowRedis())
      .overrideProvider(EMAIL_JOB_ENQUEUER)
      .useValue(new NoOpEmailJobEnqueuer())
      .compile();

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
      console.warn(`\n[null-tenant-bearer.http.integration] Docker NOT AVAILABLE: ${msg}\n`);
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

function http() {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[null-tenant-bearer.http.integration] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

function bearer(raw: string): string {
  return `Bearer ${raw}`;
}

async function signInWithTenant(tenantId: string): Promise<string> {
  const res = await http()
    .post("/api/v1/auth/signin")
    .send({ email: ALICE_EMAIL, password: ALICE_PASSWORD })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = list.find((c: string) => c.startsWith("dp2_session="))!.split(";")[0]!;
  await http()
    .post("/api/v1/context/tenant")
    .set("Cookie", cookie)
    .send({ tenant_id: tenantId })
    .expect(200);
  return cookie;
}

async function tenantRow(id: string): Promise<{ name: string; deleted_at: Date | null }> {
  const { rows } = await admin!.query<{ name: string; deleted_at: Date | null }>(
    "SELECT name, deleted_at FROM tenants WHERE id = $1",
    [id],
  );
  return rows[0]!;
}

async function tenantCount(): Promise<number> {
  const { rows } = await admin!.query<{ n: string }>("SELECT count(*)::text AS n FROM tenants");
  return Number(rows[0]!.n);
}

async function storeCount(tenantId: string): Promise<number> {
  const { rows } = await admin!.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM stores WHERE tenant_id = $1",
    [tenantId],
  );
  return Number(rows[0]!.n);
}

// ===== null-tenant dashboard_api (the only scope DashboardAuthGuard admits) =

describe("null-tenant dashboard_api token (user is_platform_admin) — fails closed", () => {
  const token = () => bearer(NULL_TENANT_TOKENS.dashboard_api);

  it("authenticates, but GET /tenants is NOT the platform-admin listAll (empty: user has no memberships)", async () => {
    if (maybeSkip()) return;
    const res = await http().get("/api/v1/tenants").set("Authorization", token()).expect(200);
    expect(res.body).toEqual([]);
  });

  it("GET /tenants/:id → 404 (no platform-admin read path)", async () => {
    if (maybeSkip()) return;
    await http().get(`/api/v1/tenants/${ACME_ID}`).set("Authorization", token()).expect(404);
  });

  it("@PlatformAdminOnly POST /tenants → 403 and no tenant row is created", async () => {
    if (maybeSkip()) return;
    const before = await tenantCount();
    await http()
      .post("/api/v1/tenants")
      .set("Authorization", token())
      .send({ slug: "evil-rt149", name: "Evil" })
      .expect(403);
    expect(await tenantCount()).toBe(before);
  });

  it("@PlatformAdminOnly DELETE /tenants/:id → 403 and the tenant is not soft-deleted", async () => {
    if (maybeSkip()) return;
    await http().delete(`/api/v1/tenants/${GLOBEX_ID}`).set("Authorization", token()).expect(403);
    expect((await tenantRow(GLOBEX_ID)).deleted_at).toBeNull();
  });

  it("@RolesFromParam PATCH /tenants/:id → 404 and the tenant is unchanged", async () => {
    if (maybeSkip()) return;
    await http()
      .patch(`/api/v1/tenants/${ACME_ID}`)
      .set("Authorization", token())
      .send({ name: "Pwned" })
      .expect(404);
    expect((await tenantRow(ACME_ID)).name).toBe("Acme");
  });

  it("@RolesFromParam GET /tenants/:id/members → 404", async () => {
    if (maybeSkip()) return;
    await http()
      .get(`/api/v1/tenants/${ACME_ID}/members`)
      .set("Authorization", token())
      .expect(404);
  });

  it("tenant-scoped GET /stores (TenantContextGuard) → 401", async () => {
    if (maybeSkip()) return;
    await http().get("/api/v1/stores").set("Authorization", token()).expect(401);
  });

  it("tenant-scoped @Roles POST /stores → 401 and no store is created", async () => {
    if (maybeSkip()) return;
    const before = await storeCount(ACME_ID);
    await http()
      .post("/api/v1/stores")
      .set("Authorization", token())
      .send({ code: "BR-X", name: "Evil Branch" })
      .expect(401);
    expect(await storeCount(ACME_ID)).toBe(before);
  });
});

// ===== null-tenant pos / pos_operator / connector ===========================

describe.each(["pos", "pos_operator", "connector"] as const)(
  "null-tenant %s token — fails closed on tenant / platform-admin routes",
  (scope) => {
    const token = () => bearer(NULL_TENANT_TOKENS[scope]);

    it.each([
      ["GET", "/api/v1/tenants"],
      ["POST", "/api/v1/tenants"],
      ["DELETE", `/api/v1/tenants/${GLOBEX_ID}`],
      ["PATCH", `/api/v1/tenants/${ACME_ID}`],
      ["GET", "/api/v1/stores"],
    ])("%s %s → 401", async (method, path) => {
      if (maybeSkip()) return;
      const req =
        method === "GET" ? http().get(path)
        : method === "POST" ? http().post(path).send({ slug: `x-${scope}`, name: "X" })
        : method === "PATCH" ? http().patch(path).send({ name: "Pwned" })
        : http().delete(path);
      await req.set("Authorization", token()).expect(401);
    });

    it("leaves tenants untouched", async () => {
      if (maybeSkip()) return;
      expect((await tenantRow(ACME_ID)).name).toBe("Acme");
      expect((await tenantRow(GLOBEX_ID)).deleted_at).toBeNull();
    });
  },
);

// ===== tenant-bound token of a platform-admin user: no implied bypass ======

describe("tenant-bound dashboard_api token whose user is_platform_admin", () => {
  it("@Roles POST /stores → 403 (platform authority is session-only); no store created", async () => {
    if (maybeSkip()) return;
    const before = await storeCount(ACME_ID);
    await http()
      .post("/api/v1/stores")
      .set("Authorization", bearer(TENANT_BOUND_DASHBOARD_TOKEN))
      .send({ code: "BR-T", name: "Token Branch" })
      .expect(403);
    expect(await storeCount(ACME_ID)).toBe(before);
  });

  it("@PlatformAdminOnly POST /tenants → 403", async () => {
    if (maybeSkip()) return;
    await http()
      .post("/api/v1/tenants")
      .set("Authorization", bearer(TENANT_BOUND_DASHBOARD_TOKEN))
      .send({ slug: "token-rt149", name: "Token" })
      .expect(403);
  });
});

// ===== control: session platform admin is unchanged ========================

describe("session platform admin (control — behaviour preserved)", () => {
  it("GET /tenants lists every tenant", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(ACME_ID);
    const res = await http().get("/api/v1/tenants").set("Cookie", cookie).expect(200);
    const ids = (res.body as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([ACME_ID, GLOBEX_ID]));
  });

  it("GET /stores in a tenant with no membership → 200 (platform-admin context)", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(ACME_ID);
    const res = await http().get("/api/v1/stores").set("Cookie", cookie).expect(200);
    expect((res.body as Array<{ id: string }>).map((s) => s.id)).toContain(STORE_ACME_ID);
  });

  it("@Roles POST /stores → 201 via the platform-admin bypass", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(ACME_ID);
    await http()
      .post("/api/v1/stores")
      .set("Cookie", cookie)
      .send({ code: "BR-S", name: "Session Branch" })
      .expect(201);
  });

  it("@PlatformAdminOnly POST /tenants → 201", async () => {
    if (maybeSkip()) return;
    const cookie = await signInWithTenant(ACME_ID);
    await http()
      .post("/api/v1/tenants")
      .set("Cookie", cookie)
      .send({ slug: "session-rt149", name: "Session Tenant" })
      .expect(201);
  });
});
