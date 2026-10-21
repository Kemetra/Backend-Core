/**
 * RT-791 — POS manager/admin sign-in with a Descope session JWT, over HTTP.
 *
 * Real Postgres (Testcontainers, full schema) and the REAL Descope verifier
 * (`jose` + a remote JWKS served by a local HTTP server — no Descope traffic)
 * bound at the OPERATOR_TOKEN_VERIFIER seam, exactly where the production factory puts
 * it with IDENTITY_PROVIDER=descope. After the approach-A cutover
 * `users.clerk_user_id` holds the Descope user id, so sign-in resolves it
 * unchanged and returns it as `operator.id`.
 *
 * A valid token for a linked user signs in; a wrong issuer, a bad signature,
 * an expired token and an unlinked subject each get the same generic 401.
 */
import "reflect-metadata";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import { Pool } from "pg";
import request from "supertest";

import { AUTH_LOOKUP_POOL, PG_POOL } from "../../src/auth/auth.module";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { LoggingInterceptor } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { OPERATOR_TOKEN_VERIFIER } from "../../src/auth/operator-token-verifier";
import { PosOperatorsModule } from "../../src/pos-operators/pos-operators.module";
import { startFakeDescopeProject, type FakeDescopeProject } from "../_helpers/descope-jwks";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const TENANT_ID = "0b791000-0000-4000-8000-000000000001";
const STORE_ID = "0b791000-0000-4000-8000-0000000000a1";
const ROLE_ID = "0b791000-0000-4000-8000-0000000000b1";
const USER_ID = "0b791000-0000-4000-8000-0000000000c1";
const MEMBERSHIP_ID = "0b791000-0000-4000-8000-0000000000d1";
const DEVICE_ID = "0b791000-0000-4000-8000-0000000000e1";
const DEVICE_ATTESTATION = "rt791-descope-device-attestation";
const DESCOPE_SUB = "U2rt791DescopeAdmin";

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let descope: FakeDescopeProject | null = null;
let dockerSkipped = false;

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[descope-sign-in.http.integration.spec] skipping (Docker unavailable)");
  }
  return dockerSkipped;
}

async function seed(p: Pool, issuer: string): Promise<void> {
  await p.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt791-tenant', 'RT-791')`, [TENANT_ID]);
  await p.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'tenant_admin', 'Admin')`,
    [ROLE_ID, TENANT_ID],
  );
  await p.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S1', 'Store 1')`, [
    STORE_ID,
    TENANT_ID,
  ]);
  // Post-cutover state: clerk_user_id holds the Descope user id + active descope link.
  await p.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES ($1, 'admin@rt791.example', 'Descope Admin', $2)`,
    [USER_ID, DESCOPE_SUB],
  );
  await p.query(
    `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status)
     VALUES ('descope', $1, $2, $3, 'active')`,
    [issuer, DESCOPE_SUB, USER_ID],
  );
  await p.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, 'all')`,
    [MEMBERSHIP_ID, TENANT_ID, USER_ID, ROLE_ID],
  );
  await p.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'till-1', $4)`,
    [DEVICE_ID, TENANT_ID, STORE_ID, hashToken(DEVICE_ATTESTATION)],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[descope-sign-in.http.integration.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  pool = new Pool({ connectionString: env.adminUri });
  descope = await startFakeDescopeProject("P2rt791SignIn");
  await seed(pool, descope.issuer);

  const moduleRef = await Test.createTestingModule({ imports: [PosOperatorsModule] })
    .overrideProvider(PG_POOL)
    .useValue(env.app)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(pool)
    .overrideProvider(OPERATOR_TOKEN_VERIFIER)
    .useValue(descope.verifier)
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
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
  if (descope) await descope.close();
  if (pool) await pool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (pool) await pool.query(`DELETE FROM auth_tokens WHERE scope = 'pos_operator'`).catch(() => undefined);
});

function signIn(jwt: string) {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer())
    .post("/api/pos/v1/operators/sign-in")
    .set("Authorization", `Bearer ${jwt}`)
    .send({ kind: "manager_admin", device_token_attestation: DEVICE_ATTESTATION });
}

describe("RT-791 sign-in with a Descope session JWT", () => {
  it("a valid token for a linked user signs in; operator.id is the Descope user id", async () => {
    if (maybeSkip()) return;
    const res = await signIn(await descope!.mint(DESCOPE_SUB));
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("signed_in");
    expect(res.body.operator).toMatchObject({
      id: DESCOPE_SUB,
      user_id: USER_ID,
      role: "admin",
      tenant_id: TENANT_ID,
      branch_id: STORE_ID,
    });
  });

  it.each<[string, () => Promise<string>]>([
    ["a wrong issuer", () => descope!.mint(DESCOPE_SUB, { issuer: "https://api.descope.com/P2other" })],
    ["a bad signature", () => descope!.mint(DESCOPE_SUB, { foreignKey: true })],
    ["an expired token", () => descope!.mint(DESCOPE_SUB, { expired: true })],
    ["an unlinked subject", () => descope!.mint("U2rt791NobodyHere")],
    ["another project's audience", () => descope!.mint(DESCOPE_SUB, { audience: "P2otherProject" })],
  ])("%s → generic 401, no session row", async (_label, make) => {
    if (maybeSkip()) return;
    const res = await signIn(await make());
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "unauthorized" } });
    expect(JSON.stringify(res.body)).not.toContain(DESCOPE_SUB);
    const r = await pool!.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM auth_tokens WHERE scope = 'pos_operator'`,
    );
    expect(r.rows[0]!.n).toBe("0");
  });
});
