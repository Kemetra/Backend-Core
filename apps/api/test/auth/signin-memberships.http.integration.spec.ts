/**
 * RT-343 — `POST /api/v1/auth/signin` returns the user's memberships, as
 * `auth.openapi.yaml` describes (`MembershipSummary`): the Admin Console uses
 * the list to pick its next step (auto-select a single tenant, chooser, or
 * no-access). It used to be a hard-coded `[]`.
 *
 * Runs on the non-superuser, NOBYPASSRLS app role (single connection), as in
 * production, so the membership read is proven under row-level security.
 */
import "reflect-metadata";

import { hashPassword } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { Pool } from "pg";
import request from "supertest";

import { AuthModule, PG_POOL } from "../../src/auth/auth.module";
import { EMAIL_JOB_ENQUEUER, NoOpEmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { LoggingInterceptor } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import {
  APP_ROLE_NAME,
  APP_ROLE_PASSWORD,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

delete process.env["REDIS_URL"]; // AuthModule falls back to its in-process Redis stub

const PASSWORD = "Rt343-Password-123!";
const USER_ID = "11111111-3430-4343-8343-111111111111";
const USER_EMAIL = "rt343-member@example.com";
const LONER_ID = "22222222-3430-4343-8343-222222222222";
const LONER_EMAIL = "rt343-loner@example.com";
const OTHER_ID = "33333333-3430-4343-8343-333333333333";

const T_NORTH = "aaaaaaaa-3430-4343-8343-aaaaaaaaaaa1";
const T_HELIOS = "aaaaaaaa-3430-4343-8343-aaaaaaaaaaa2";
const T_REVOKED = "aaaaaaaa-3430-4343-8343-aaaaaaaaaaa3";
const T_DELETED = "aaaaaaaa-3430-4343-8343-aaaaaaaaaaa4";
const T_OTHER = "aaaaaaaa-3430-4343-8343-aaaaaaaaaaa5";

let env: PgTestEnv | null = null;
let singleConnectionPool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

function appRoleUri(adminUri: string): string {
  const url = new URL(adminUri);
  url.username = APP_ROLE_NAME;
  url.password = APP_ROLE_PASSWORD;
  return url.toString();
}

/** One tenant with an owner and a store_staff role; returns the role ids. */
async function tenant(admin: Pool, id: string, name: string, deleted = false): Promise<[string, string]> {
  const suffix = id.slice(-2);
  await admin.query(
    `INSERT INTO tenants (id, slug, name, deleted_at) VALUES ($1, $2, $3, $4)`,
    [id, `rt343-${suffix}`, name, deleted ? new Date() : null],
  );
  const owner = `cccccccc-3430-4343-8343-cccccccccc${suffix}`;
  const staff = `dddddddd-3430-4343-8343-dddddddddd${suffix}`;
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $3, 'owner', 'Owner'), ($2, $3, 'store_staff', 'Store Staff')`,
    [owner, staff, id],
  );
  return [owner, staff];
}

async function membership(
  admin: Pool,
  id: string,
  tenantId: string,
  userId: string,
  roleId: string,
  kind: "all" | "specific",
  revoked = false,
): Promise<void> {
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, tenantId, userId, roleId, kind, revoked ? new Date() : null],
  );
}

async function seed(admin: Pool): Promise<void> {
  const hash = await hashPassword(PASSWORD);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3), ($4, $5, $3), ($6, 'rt343-other@example.com', $3)`,
    [USER_ID, USER_EMAIL, hash, LONER_ID, LONER_EMAIL, OTHER_ID],
  );
  const [northOwner] = await tenant(admin, T_NORTH, "Northstar Retail");
  const [, heliosStaff] = await tenant(admin, T_HELIOS, "Helios Markets");
  const [revokedOwner] = await tenant(admin, T_REVOKED, "Revoked Co");
  const [deletedOwner] = await tenant(admin, T_DELETED, "Deleted Co", true);
  const [otherOwner] = await tenant(admin, T_OTHER, "Someone Else Inc");

  await membership(admin, "eeeeeeee-3430-4343-8343-eeeeeeeeee01", T_NORTH, USER_ID, northOwner, "all");
  await membership(admin, "eeeeeeee-3430-4343-8343-eeeeeeeeee02", T_HELIOS, USER_ID, heliosStaff, "specific");
  await membership(admin, "eeeeeeee-3430-4343-8343-eeeeeeeeee03", T_REVOKED, USER_ID, revokedOwner, "all", true);
  await membership(admin, "eeeeeeee-3430-4343-8343-eeeeeeeeee04", T_DELETED, USER_ID, deletedOwner, "all");
  await membership(admin, "eeeeeeee-3430-4343-8343-eeeeeeeeee05", T_OTHER, OTHER_ID, otherOwner, "all");
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      console.warn(`\n[signin-memberships.http.integration.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seed(env.admin);

  singleConnectionPool = new Pool({ connectionString: appRoleUri(env.adminUri), max: 1 });

  const moduleRef = await Test.createTestingModule({ imports: [AuthModule] })
    .overrideProvider(PG_POOL)
    .useValue(singleConnectionPool)
    .overrideProvider(EMAIL_JOB_ENQUEUER)
    .useValue(new NoOpEmailJobEnqueuer())
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.use(cookieParser());
  app.useGlobalInterceptors(
    new RequestIdInterceptor(),
    new LoggingInterceptor(createLogger({ service: "api-test", level: "silent" })),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (singleConnectionPool) await singleConnectionPool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

function signIn(email: string): request.Test {
  return request(app!.getHttpServer()).post("/api/v1/auth/signin").send({ email, password: PASSWORD });
}

type Summary = { tenant_id: string; tenant_name: string };
const byTenantName = (a: Summary, b: Summary): number => a.tenant_name.localeCompare(b.tenant_name);

describe("POST /api/v1/auth/signin returns the user's memberships (RT-343)", () => {
  it("lists each active membership with the contract's MembershipSummary fields", async () => {
    if (dockerSkipped) return;
    const res = await signIn(USER_EMAIL).expect(200);

    expect([...res.body.memberships].sort(byTenantName)).toEqual([
      { tenant_id: T_HELIOS, tenant_name: "Helios Markets", role_code: "store_staff", store_access_kind: "specific" },
      { tenant_id: T_NORTH, tenant_name: "Northstar Retail", role_code: "owner", store_access_kind: "all" },
    ]);
  });

  it("leaves out revoked memberships, deleted tenants and other users' memberships", async () => {
    if (dockerSkipped) return;
    const res = await signIn(USER_EMAIL).expect(200);

    const tenantIds = res.body.memberships.map((m: Summary) => m.tenant_id);
    expect(tenantIds).toContain(T_NORTH); // non-empty, so the exclusions below mean something
    expect(tenantIds).not.toContain(T_REVOKED);
    expect(tenantIds).not.toContain(T_DELETED);
    expect(tenantIds).not.toContain(T_OTHER);
  });

  it("returns an empty list for a user without memberships", async () => {
    if (dockerSkipped) return;
    const res = await signIn(LONER_EMAIL).expect(200);

    expect(res.body).toEqual({
      user: { id: LONER_ID, email: LONER_EMAIL, display_name: null, is_platform_admin: false },
      memberships: [],
    });
  });

  it("still sets the session cookie", async () => {
    if (dockerSkipped) return;
    const res = await signIn(USER_EMAIL).expect(200);

    const raw = res.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    expect(list.some((c: string) => c.startsWith("dp2_session="))).toBe(true);
  });
});
