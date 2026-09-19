import { hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import { Pool } from "pg";

import { verifyDatabasePoolBoundary } from "../../src/auth/database-pools";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const TENANT_A = "a1000000-0000-4000-8000-000000000001";
const TENANT_B = "b1000000-0000-4000-8000-000000000001";
const STORE_A = "a1000000-0000-4000-8000-000000000002";
const STORE_B = "b1000000-0000-4000-8000-000000000002";
const DEVICE_A = "a1000000-0000-4000-8000-000000000003";
const DEVICE_B = "b1000000-0000-4000-8000-000000000003";
const LOOKUP_ROLE = "auth_lookup_test";
const LOOKUP_PASSWORD = "auth_lookup_test";

let env: PgTestEnv | null = null;
let lookup: Pool | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await env.admin.query(`
      CREATE ROLE ${LOOKUP_ROLE} LOGIN PASSWORD '${LOOKUP_PASSWORD}' BYPASSRLS;
      GRANT USAGE ON SCHEMA public TO ${LOOKUP_ROLE};
      GRANT SELECT ON users, sessions, auth_tokens, devices, stores,
        external_identity_links, connector_registration, pairing_codes TO ${LOOKUP_ROLE};
      GRANT INSERT, UPDATE ON sessions, auth_tokens TO ${LOOKUP_ROLE};
      GRANT UPDATE ON users TO ${LOOKUP_ROLE};
    `);

    const host = env.container.getHost();
    const port = env.container.getMappedPort(5432);
    lookup = new Pool({
      connectionString: `postgres://${LOOKUP_ROLE}:${LOOKUP_PASSWORD}@${host}:${port}/test`,
    });

    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1, 'pool-a', 'Pool A'), ($2, 'pool-b', 'Pool B')`,
      [TENANT_A, TENANT_B],
    );
    await env.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $2, 'A', 'Store A'), ($3, $4, 'B', 'Store B')`,
      [STORE_A, TENANT_A, STORE_B, TENANT_B],
    );
    await env.admin.query(
      `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES
         ($1, $2, $3, $4), ($5, $6, $7, $8)`,
      [
        DEVICE_A,
        TENANT_A,
        STORE_A,
        hashToken("device-a"),
        DEVICE_B,
        TENANT_B,
        STORE_B,
        hashToken("device-b"),
      ],
    );
  } catch (error) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      return;
    }
    throw error;
  }
}, 180_000);

afterAll(async () => {
  await lookup?.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
});

describe("production database pool separation", () => {
  it("keeps bootstrap resolution available while the domain pool remains RLS-bound", async () => {
    if (dockerSkipped || !env || !lookup) return;

    await expect(verifyDatabasePoolBoundary(env.app, lookup)).resolves.toBeUndefined();

    const device = await new DeviceRepository(lookup).findActiveByAttestation("device-b");
    expect(device?.id).toBe(DEVICE_B);

    const visibleToTenantA = await runWithTenantContext(
      env.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      (client) => client.query<{ id: string }>("SELECT id FROM devices ORDER BY id"),
    );
    expect(visibleToTenantA.rows.map((row) => row.id)).toEqual([DEVICE_A]);

    await expect(lookup.query("SELECT * FROM sales LIMIT 1")).rejects.toThrow(
      /permission denied/i,
    );
  });
});
