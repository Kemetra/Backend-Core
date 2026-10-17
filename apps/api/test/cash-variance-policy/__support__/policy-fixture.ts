/**
 * RT-387 — fixture for the shift variance policy HTTP specs.
 *
 * On top of the RT-192 read-store-scope seed (tenants A / B; STORE_A_X granted
 * to the `specific` owner and tenant_admin; the `all` owner; S_DELETED), adds:
 *
 *   tenant A  SES_ADMIN_ALL   tenant_admin, `all`
 *             SES_MANAGER     store_manager, `specific` STORE_A_X
 *             SES_STAFF       store_staff, `all` (not an allowed role → 404)
 *   tenant B  SES_OWNER_B     owner, `all`
 *   devices   DEV_X (STORE_A_X), DEV_Y (STORE_A_Y), DEV_B (STORE_B_X), each
 *             with a real pairing token (the `device` bearer).
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `0387`
 * mnemonic (hex only).
 */
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import type { Pool } from "pg";

import type { PgTestEnv } from "../../_helpers/postgres-container";
import { seedConsoleMember } from "../../_helpers/console-members";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import { seedReadStoreScope } from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";

const id = (n: string): string => `0a000000-0000-7000-8000-00000387${n}`;
const idB = (n: string): string => `0b000000-0000-7000-8000-00000387${n}`;

export const SES_ADMIN_ALL = id("01a1");
export const SES_MANAGER = id("01a2");
export const SES_STAFF = id("01a3");
export const SES_OWNER_B = idB("01b1");

export const USER_ADMIN_ALL = id("02a1");
export const USER_MANAGER = id("02a2");
export const USER_STAFF = id("02a3");
export const USER_OWNER_B = idB("02b1");

export const DEV_X = id("03a1");
export const DEV_Y = id("03a2");
export const DEV_B = idB("03b1");
export const TOKEN_X = generateRawToken();
export const TOKEN_Y = generateRawToken();
export const TOKEN_B = generateRawToken();

/** The `all` owner of tenant A (the RT-192 seed's USER_OWNER_ALL). */
export const USER_OWNER_ALL = "0a000000-0000-7000-8000-0000019202a3";
export const USER_ADMIN_SPEC = "0a000000-0000-7000-8000-0000019202a2";

async function seedMembers(admin: Pool): Promise<void> {
  await seedConsoleMember(admin, {
    tenantId: TENANT_A,
    userId: USER_ADMIN_ALL,
    email: "rt387-admin-all@example.test",
    membershipId: id("04a1"),
    roleId: id("05a1"),
    roleCode: "tenant_admin",
    stores: "all",
    sessions: { [SES_ADMIN_ALL]: null },
  });
  await seedConsoleMember(admin, {
    tenantId: TENANT_A,
    userId: USER_MANAGER,
    email: "rt387-manager@example.test",
    membershipId: id("04a2"),
    roleId: id("05a2"),
    roleCode: "store_manager",
    stores: [STORE_A_X],
    sessions: { [SES_MANAGER]: null },
  });
  await seedConsoleMember(admin, {
    tenantId: TENANT_A,
    userId: USER_STAFF,
    email: "rt387-staff@example.test",
    membershipId: id("04a3"),
    roleId: id("05a3"),
    roleCode: "store_staff",
    stores: "all",
    sessions: { [SES_STAFF]: null },
  });
  await seedConsoleMember(admin, {
    tenantId: TENANT_B,
    userId: USER_OWNER_B,
    email: "rt387-owner-b@example.test",
    membershipId: idB("04b1"),
    roleId: idB("05b1"),
    roleCode: "owner",
    stores: "all",
    sessions: { [SES_OWNER_B]: null },
  });
}

async function seedDevices(admin: Pool): Promise<void> {
  const devices = [
    { id: DEV_X, tenantId: TENANT_A, storeId: STORE_A_X, token: TOKEN_X },
    { id: DEV_Y, tenantId: TENANT_A, storeId: STORE_A_Y, token: TOKEN_Y },
    { id: DEV_B, tenantId: TENANT_B, storeId: STORE_B_X, token: TOKEN_B },
  ];
  await admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, expires_at)
     SELECT d.id, d.tenant_id, d.store_id, 'RT-387 till', d.token_hash, now() + interval '30 days'
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::bytea[]) AS d(id, tenant_id, store_id, token_hash)`,
    [
      devices.map((d) => d.id),
      devices.map((d) => d.tenantId),
      devices.map((d) => d.storeId),
      devices.map((d) => hashToken(d.token)),
    ],
  );
}

export async function seedPolicyFixture(env: PgTestEnv): Promise<void> {
  await seedReadStoreScope(env);
  await seedMembers(env.admin);
  await seedDevices(env.admin);
}

/** Admin-pool count of policy revisions of tenant A (optionally one store's). */
export async function countRevisions(admin: Pool, storeId?: string): Promise<number> {
  const r = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM cash_variance_policy_revisions
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR store_id = $2::uuid)`,
    [TENANT_A, storeId ?? null],
  );
  return Number(r.rows[0]!.n);
}

/** Admin-pool audit rows of one action, oldest first. */
export async function auditRows(
  admin: Pool,
  action: string,
): Promise<Array<{ actor_user_id: string | null; tenant_id: string; store_id: string | null; target_id: string; metadata: Record<string, unknown> }>> {
  const r = await admin.query(
    `SELECT actor_user_id, tenant_id, store_id, target_id, metadata
       FROM audit_events WHERE action = $1 ORDER BY occurred_at, id`,
    [action],
  );
  return r.rows;
}
