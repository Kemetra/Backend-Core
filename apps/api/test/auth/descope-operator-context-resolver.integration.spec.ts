/**
 * RT-791 — the operator-context resolver (sale / settlement / shift envelope
 * path) with the Descope adapter, against real Postgres.
 *
 * The REAL `DescopeIdentityProviderAdapter` + REAL `DescopeJwksVerifier` (local
 * JWKS, no Descope traffic) drive the unchanged `PgOperatorContextResolver`.
 * An ACTIVE `descope` link resolves the user to the device's tenant/store; the
 * same subject under a `clerk` link only, a disabled `descope` link, or a token
 * the verifier refuses all fail closed.
 */
import "reflect-metadata";

import { hashToken } from "@data-pulse-2/auth";
import { Pool } from "pg";

import { DescopeIdentityProviderAdapter } from "../../src/auth/descope-identity-provider.adapter";
import { PgOperatorContextResolver } from "../../src/auth/operator-context-resolver";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import { startFakeDescopeProject, type FakeDescopeProject } from "../_helpers/descope-jwks";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const TENANT_ID = "0c791000-0000-4000-8000-000000000001";
const STORE_ID = "0c791000-0000-4000-8000-0000000000a1";
const ROLE_ID = "0c791000-0000-4000-8000-0000000000b1";
const DEVICE_ID = "0c791000-0000-4000-8000-0000000000e1";
const DEVICE_ATTESTATION = "rt791-resolver-device-attestation";

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let descope: FakeDescopeProject | null = null;
let resolver: PgOperatorContextResolver;
let seq = 0;

const skip = (): boolean => env === null;

async function seedUser(link: { provider: string; status: "active" | "disabled" }): Promise<{ userId: string; sub: string }> {
  seq += 1;
  const userId = `0c791000-0000-4000-8000-0000000c${String(seq).padStart(4, "0")}`;
  const sub = `U2rt791Resolver${seq}`;
  const p = pool!;
  await p.query(`INSERT INTO users (id, email, clerk_user_id) VALUES ($1, $2, $3)`, [
    userId,
    `resolver${seq}@rt791.example`,
    sub,
  ]);
  await p.query(
    `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status, disabled_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'disabled' THEN now() END)`,
    [link.provider, descope!.issuer, sub, userId, link.status],
  );
  await p.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, 'all')`,
    [`0c791000-0000-4000-8000-0000000d${String(seq).padStart(4, "0")}`, TENANT_ID, userId, ROLE_ID],
  );
  return { userId, sub };
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[descope-operator-context-resolver.integration.spec] Docker NOT AVAILABLE: ${msg}\n`);
      env = null;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  pool = new Pool({ connectionString: env.adminUri });
  descope = await startFakeDescopeProject("P2rt791Resolver");
  await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt791-resolver', 'R')`, [TENANT_ID]);
  await pool.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'store_manager', 'Manager')`,
    [ROLE_ID, TENANT_ID],
  );
  await pool.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S1', 'S1')`, [
    STORE_ID,
    TENANT_ID,
  ]);
  await pool.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'till', $4)`,
    [DEVICE_ID, TENANT_ID, STORE_ID, hashToken(DEVICE_ATTESTATION)],
  );
  const adapter = new DescopeIdentityProviderAdapter(descope.verifier, pool, descope.issuer);
  resolver = new PgOperatorContextResolver(pool, adapter, new DeviceRepository(pool, env.app), undefined, pool);
}, 180_000);

afterAll(async () => {
  if (descope) await descope.close();
  if (pool) await pool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

describe("RT-791 operator-context resolver with a descope link", () => {
  it("an active descope link resolves to the device's tenant and store", async () => {
    if (skip()) return;
    const u = await seedUser({ provider: "descope", status: "active" });
    const result = await resolver.resolve(await descope!.mint(u.sub), DEVICE_ATTESTATION);
    expect(result).toMatchObject({
      kind: "ok",
      context: { userId: u.userId, tenantId: TENANT_ID, storeId: STORE_ID, source: "token" },
    });
  });

  it("the same subject under a clerk link only → user_unmapped", async () => {
    if (skip()) return;
    const u = await seedUser({ provider: "clerk", status: "active" });
    await expect(resolver.resolve(await descope!.mint(u.sub), DEVICE_ATTESTATION)).resolves.toEqual({
      kind: "refused",
      reason: "user_unmapped",
    });
  });

  it("a disabled descope link (rolled back) → user_unmapped", async () => {
    if (skip()) return;
    const u = await seedUser({ provider: "descope", status: "disabled" });
    await expect(resolver.resolve(await descope!.mint(u.sub), DEVICE_ATTESTATION)).resolves.toEqual({
      kind: "refused",
      reason: "user_unmapped",
    });
  });

  it("a token the verifier refuses → the generic token refusal", async () => {
    if (skip()) return;
    const u = await seedUser({ provider: "descope", status: "active" });
    const forged = await descope!.mint(u.sub, { foreignKey: true });
    await expect(resolver.resolve(forged, DEVICE_ATTESTATION)).resolves.toEqual({
      kind: "refused",
      reason: "identity_token_invalid",
    });
  });
});
