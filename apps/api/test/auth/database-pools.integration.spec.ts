import { hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Logger } from "@data-pulse-2/shared";
import { Pool } from "pg";

import { verifyDatabasePoolBoundary } from "../../src/auth/database-pools";
import { MembershipRepository } from "../../src/context/membership.repository";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import { PosShiftsService } from "../../src/pos-shifts/pos-shifts.service";
import { TenantsRepository } from "../../src/tenants/tenants.repository";
import { TenantsService } from "../../src/tenants/tenants.service";
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
const USER_A = "a1000000-0000-4000-8000-000000000004";
const ROLE_A = "a1000000-0000-4000-8000-000000000005";
const MEMBERSHIP_A = "a1000000-0000-4000-8000-000000000006";

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
      `INSERT INTO users (id, email, clerk_user_id) VALUES ($1, 'pool-user@example.test', 'pool-clerk-user')`,
      [USER_A],
    );
    await env.admin.query(
      `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'store_manager', 'Store Manager')`,
      [ROLE_A, TENANT_A],
    );
    await env.admin.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
       VALUES ($1, $2, $3, $4, 'all')`,
      [MEMBERSHIP_A, TENANT_A, USER_A, ROLE_A],
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
    if (dockerSkipped) return;
    const { app } = env!;
    const lookupPool = lookup!;

    await expect(verifyDatabasePoolBoundary(app, lookupPool)).resolves.toBeUndefined();

    const device = await new DeviceRepository(lookupPool).findActiveByAttestation("device-b");
    expect(device?.id).toBe(DEVICE_B);

    const visibleToTenantA = await runWithTenantContext(
      app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      (client) => client.query<{ id: string }>("SELECT id FROM devices ORDER BY id"),
    );
    expect(visibleToTenantA.rows.map((row) => row.id)).toEqual([DEVICE_A]);

    await expect(lookupPool.query("SELECT * FROM sales LIMIT 1")).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("lists only the caller's tenants and admits an authorized stuck-shifts lookup", async () => {
    if (dockerSkipped) return;
    const { app } = env!;
    const tenants = new TenantsService(
      app,
      new TenantsRepository(),
      new MembershipRepository(app),
    );
    const principal = { kind: "session" as const, sessionId: USER_A, userId: USER_A };

    expect((await tenants.list(principal)).map((row) => row.id)).toEqual([TENANT_A]);
    await expect(tenants.read(principal, TENANT_B)).rejects.toMatchObject({ status: 404 });

    const shifts = new PosShiftsService(
      app,
      { verify: async () => ({ sub: "pool-clerk-user" }) },
      { warn: () => undefined } as unknown as Logger,
    );
    await expect(shifts.getStuck("verified-jwt", STORE_A, null)).resolves.toEqual({
      kind: "ok",
      body: { kind: "ok", shifts: [] },
    });
    await expect(shifts.getStuck("verified-jwt", STORE_B, null)).resolves.toEqual({
      kind: "refused",
    });
  });
});
