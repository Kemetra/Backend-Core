/**
 * RT-664 — fixture for the AI entitlements HTTP spec, on top of the AI DB
 * fixture (restricted 0055 grants, the test catalogue, a platform admin).
 *
 *   tenant A  SES_OWNER        owner, `all`
 *             SES_OWNER_REVOKE owner, `all` (revoked mid-spec, T8)
 *             SES_ADMIN        tenant_admin, `all`
 *             SES_MANAGER      store_manager, `specific` STORE_A1
 *             SES_STAFF        store_staff, `all` (no route)
 *             SES_PA_ADMIN     platform admin who is a tenant_admin member
 *   tenant B  SES_OWNER_B      owner, `all`
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. Ids use the `0664`
 * mnemonic (hex only).
 */
import type { Pool } from "pg";

import { seedConsoleMember } from "../../_helpers/console-members";
import type { PgTestEnv } from "../../_helpers/postgres-container";
import { restrictAiGrants, seedCatalog, seedPlatformAdmin } from "./ai-fixture";

const id = (n: string): string => `0a000000-0000-7000-8000-00000664${n}`;
const idB = (n: string): string => `0b000000-0000-7000-8000-00000664${n}`;

export const TENANT_A = id("0001");
export const TENANT_B = idB("0001");
export const STORE_A1 = id("0101");
export const STORE_A2 = id("0102");
export const STORE_B1 = idB("0101");

export const SES_OWNER = id("01a1");
export const SES_OWNER_REVOKE = id("01a2");
export const SES_ADMIN = id("01a3");
export const SES_MANAGER = id("01a4");
export const SES_STAFF = id("01a5");
export const SES_PA_ADMIN = id("01a6");
export const SES_OWNER_B = idB("01b1");

export const USER_OWNER = id("02a1");
export const USER_OWNER_REVOKE = id("02a2");
export const USER_ADMIN = id("02a3");
export const USER_PA_ADMIN = id("02a6");
export const MEMBERSHIP_OWNER_REVOKE = id("04a2");

async function seedTenants(admin: Pool): Promise<void> {
  await admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'rt664-a', 'RT-664 A', 'USD'), ($2, 'rt664-b', 'RT-664 B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $4, 'A1', 'A1'), ($2, $4, 'A2', 'A2'), ($3, $5, 'B1', 'B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
}

const MEMBERS = [
  { tenantId: TENANT_A, userId: USER_OWNER, n: "a1", roleCode: "owner", stores: "all", session: SES_OWNER },
  { tenantId: TENANT_A, userId: USER_OWNER_REVOKE, n: "a2", roleCode: "owner", stores: "all", session: SES_OWNER_REVOKE },
  { tenantId: TENANT_A, userId: USER_ADMIN, n: "a3", roleCode: "tenant_admin", stores: "all", session: SES_ADMIN },
  { tenantId: TENANT_A, userId: id("02a4"), n: "a4", roleCode: "store_manager", stores: [STORE_A1], session: SES_MANAGER },
  { tenantId: TENANT_A, userId: id("02a5"), n: "a5", roleCode: "store_staff", stores: "all", session: SES_STAFF },
  { tenantId: TENANT_A, userId: USER_PA_ADMIN, n: "a6", roleCode: "tenant_admin", stores: "all", session: SES_PA_ADMIN },
  { tenantId: TENANT_B, userId: idB("02b1"), n: "b1", roleCode: "owner", stores: "all", session: SES_OWNER_B },
] as const;

export async function seedAiHttpFixture(env: PgTestEnv): Promise<void> {
  await restrictAiGrants(env.admin);
  await seedCatalog(env.admin);
  await seedPlatformAdmin(env.admin);
  await seedTenants(env.admin);
  for (const m of MEMBERS) {
    const make = m.tenantId === TENANT_A ? id : idB;
    await seedConsoleMember(env.admin, {
      tenantId: m.tenantId,
      userId: m.userId,
      email: `rt664-${m.n}@example.test`,
      membershipId: make(`04${m.n}`),
      roleId: make(`05${m.roleCode === "owner" ? "01" : m.roleCode === "tenant_admin" ? "02" : m.roleCode === "store_manager" ? "03" : "04"}`),
      roleCode: m.roleCode,
      stores: m.stores,
      sessions: { [m.session]: null },
    });
  }
  await env.admin.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [USER_PA_ADMIN]);
}
