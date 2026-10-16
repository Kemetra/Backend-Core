/**
 * Seeds Console members for HTTP specs that run on the RT-192 scoped app
 * (`bootScopedApp`): one user, one membership with a role, store grants and
 * any number of dashboard sessions, each registered for the `x-test-session`
 * header stand-in. Roles are created on first use per tenant and code.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import type { Pool } from "pg";

import { registerTestSession } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";

export interface ConsoleMemberSeed {
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
  readonly membershipId: string;
  readonly roleId: string;
  /** e.g. `store_manager`, `store_staff`. */
  readonly roleCode: string;
  /** `all`, or the granted store ids (`specific`). */
  readonly stores: "all" | readonly string[];
  /** Session id → the session's active store (null = none). */
  readonly sessions: Readonly<Record<string, string | null>>;
}

async function ensureRole(admin: Pool, seed: ConsoleMemberSeed): Promise<string> {
  const existing = await admin.query<{ id: string }>(`SELECT id FROM roles WHERE tenant_id = $1 AND code = $2`, [
    seed.tenantId,
    seed.roleCode,
  ]);
  if (existing.rows[0]) return existing.rows[0].id;
  await admin.query(`INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, $3, $3)`, [
    seed.roleId,
    seed.tenantId,
    seed.roleCode,
  ]);
  return seed.roleId;
}

export async function seedConsoleMember(admin: Pool, seed: ConsoleMemberSeed): Promise<void> {
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [seed.userId, seed.email]);
  const roleId = await ensureRole(admin, seed);
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, $5)`,
    [seed.membershipId, seed.tenantId, seed.userId, roleId, seed.stores === "all" ? "all" : "specific"],
  );
  for (const storeId of seed.stores === "all" ? [] : seed.stores) {
    await admin.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`, [
      seed.membershipId,
      storeId,
      seed.tenantId,
    ]);
  }
  for (const [sessionId, activeStoreId] of Object.entries(seed.sessions)) {
    await admin.query(
      `INSERT INTO sessions (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
      [sessionId, seed.userId, seed.tenantId, activeStoreId],
    );
    registerTestSession(sessionId, seed.userId);
  }
}
