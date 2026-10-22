/**
 * RT-327 shared fixture for the device health integration specs: real
 * Postgres (every migration, the NOBYPASSRLS `app_test` pool) behind the real
 * `DeviceHealthModule` guard chain, over `scopedHttpHarness`. Only cookie
 * authentication is faked (a header names the session); a device bearer token
 * resolves for real through `PosDeviceAuthGuard`.
 *
 *   Tenant A  stores A1, A2   owner (all stores), store_manager of A1 only,
 *                             store_manager of A2 only, store_staff
 *   Tenant B  store B1        owner
 *   Platform  a platform admin (no membership, no active tenant)
 *
 *   Devices   A1a, A1b (store A1), A2a (store A2), B1a (tenant B),
 *             REVOKED (A1, revoked), RETIRED (A1, retired)
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. Ids are hex only.
 */
import { hashToken } from "@data-pulse-2/auth";
import type { Pool } from "pg";

import { registerTestSession } from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";
import type { PgTestEnv } from "../../_helpers/postgres-container";

const uid = (group: string, n: number): string => `03270000-0000-4000-8000-${group}${n.toString(16).padStart(8, "0")}`;

export const TENANT_A = uid("0a01", 1);
export const TENANT_B = uid("0b01", 1);
export const STORE_A1 = uid("0a02", 1);
export const STORE_A2 = uid("0a02", 2);
export const STORE_B1 = uid("0b02", 1);

export interface FixtureUser {
  readonly id: string;
  readonly session: string;
}
const user = (n: number): FixtureUser => ({ id: uid("0c01", n), session: uid("0c02", n) });

export const OWNER_A = user(1);
export const MANAGER_A1 = user(2);
export const MANAGER_A2 = user(3);
export const STAFF_A = user(4);
export const OWNER_B = user(5);
export const PLATFORM_ADMIN = user(6);

export interface FixtureDevice {
  readonly id: string;
  readonly token: string;
}
const device = (n: number): FixtureDevice => ({ id: uid("0e01", n), token: `rt327-device-token-${n}-aaaaaaaaaaaaaaaa` });

export const DEV_A1A = device(1);
export const DEV_A1B = device(2);
export const DEV_A2A = device(3);
export const DEV_B1A = device(4);
export const DEV_REVOKED = device(5);
export const DEV_RETIRED = device(6);

/** The tenant A devices a tenant-wide owner sees by default (retired ones are left out), by id. */
export const TENANT_A_DEFAULT_ORDER: readonly string[] = [DEV_A1A.id, DEV_A1B.id, DEV_A2A.id, DEV_REVOKED.id];

const ROLE = (tenant: "a" | "b", n: number): string => uid(tenant === "a" ? "0a03" : "0b03", n);
const ROLE_OWNER_A = ROLE("a", 1);
const ROLE_MANAGER_A = ROLE("a", 2);
const ROLE_STAFF_A = ROLE("a", 3);
const ROLE_OWNER_B = ROLE("b", 1);

const MEMBERSHIP = (n: number): string => uid("0c03", n);

async function seedTenants(admin: Pool): Promise<void> {
  await admin.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt327-a', 'RT-327 A'), ($2, 'rt327-b', 'RT-327 B')`, [
    TENANT_A,
    TENANT_B,
  ]);
  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $4, 'A1', 'Store A1'), ($2, $4, 'A2', 'Store A2'), ($3, $5, 'B1', 'Store B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $5, 'owner', 'Owner'), ($2, $5, 'store_manager', 'Manager'), ($3, $5, 'store_staff', 'Staff'),
       ($4, $6, 'owner', 'Owner B')`,
    [ROLE_OWNER_A, ROLE_MANAGER_A, ROLE_STAFF_A, ROLE_OWNER_B, TENANT_A, TENANT_B],
  );
}

interface MemberSeed {
  readonly user: FixtureUser;
  readonly tenantId: string;
  readonly roleId: string;
  readonly access: "all" | "specific";
  readonly stores: readonly string[];
  readonly membership: string;
}

async function seedMember(admin: Pool, m: MemberSeed): Promise<void> {
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [m.user.id, `${m.user.id}@rt327.example`]);
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, $5)`,
    [m.membership, m.tenantId, m.user.id, m.roleId, m.access],
  );
  for (const store of m.stores) {
    await admin.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`, [m.membership, store, m.tenantId]);
  }
  await seedSession(admin, m.user, m.tenantId);
}

async function seedSession(admin: Pool, u: FixtureUser, activeTenantId: string | null): Promise<void> {
  await admin.query(
    `INSERT INTO sessions (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
     VALUES ($1, $2, $3, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
    [u.session, u.id, activeTenantId],
  );
  registerTestSession(u.session, u.id);
}

async function seedMembers(admin: Pool): Promise<void> {
  await seedMember(admin, { user: OWNER_A, tenantId: TENANT_A, roleId: ROLE_OWNER_A, access: "all", stores: [], membership: MEMBERSHIP(1) });
  await seedMember(admin, { user: MANAGER_A1, tenantId: TENANT_A, roleId: ROLE_MANAGER_A, access: "specific", stores: [STORE_A1], membership: MEMBERSHIP(2) });
  await seedMember(admin, { user: MANAGER_A2, tenantId: TENANT_A, roleId: ROLE_MANAGER_A, access: "specific", stores: [STORE_A2], membership: MEMBERSHIP(3) });
  await seedMember(admin, { user: STAFF_A, tenantId: TENANT_A, roleId: ROLE_STAFF_A, access: "all", stores: [], membership: MEMBERSHIP(4) });
  await seedMember(admin, { user: OWNER_B, tenantId: TENANT_B, roleId: ROLE_OWNER_B, access: "all", stores: [], membership: MEMBERSHIP(5) });
  await admin.query(`INSERT INTO users (id, email, is_platform_admin) VALUES ($1, $2, true)`, [PLATFORM_ADMIN.id, `${PLATFORM_ADMIN.id}@rt327.example`]);
  await seedSession(admin, PLATFORM_ADMIN, null);
}

async function seedDevices(admin: Pool): Promise<void> {
  const rows: Array<[FixtureDevice, string, string, string]> = [
    [DEV_A1A, TENANT_A, STORE_A1, "till a1a"],
    [DEV_A1B, TENANT_A, STORE_A1, "till a1b"],
    [DEV_A2A, TENANT_A, STORE_A2, "till a2a"],
    [DEV_B1A, TENANT_B, STORE_B1, "till b1a"],
    [DEV_REVOKED, TENANT_A, STORE_A1, "till revoked"],
    [DEV_RETIRED, TENANT_A, STORE_A1, "till retired"],
  ];
  for (const [d, tenant, store, label] of rows) {
    await admin.query(`INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, $4, $5)`, [
      d.id,
      tenant,
      store,
      label,
      hashToken(d.token),
    ]);
  }
  await admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEV_REVOKED.id]);
  await admin.query(`UPDATE devices SET revoked_at = now(), retired_at = now(), retire_reason = 'decommissioned' WHERE id = $1`, [DEV_RETIRED.id]);
}

/** Seed tenants, stores, members, sessions and devices. No policy and no heartbeat: each spec adds its own. */
export async function seedDeviceHealthFixture(env: PgTestEnv): Promise<void> {
  await seedTenants(env.admin);
  await seedMembers(env.admin);
  await seedDevices(env.admin);
}

/** Replace a channel's policy directly (admin pool, bypassing RLS), for specs that need one in place. */
export async function setPolicy(
  admin: Pool,
  channel: "lab" | "canary" | "stable",
  versions: { latest: string; recommended: string; min: string },
  graceUntil = "2026-12-01T00:00:00.000Z",
): Promise<void> {
  await admin.query(
    `INSERT INTO pos_version_policy
       (channel, latest_version, recommended_version, min_supported_version, min_supported_grace_until, revision, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 1, $6)
     ON CONFLICT (channel) DO UPDATE SET
       latest_version = EXCLUDED.latest_version, recommended_version = EXCLUDED.recommended_version,
       min_supported_version = EXCLUDED.min_supported_version,
       min_supported_grace_until = EXCLUDED.min_supported_grace_until,
       revision = pos_version_policy.revision + 1`,
    [channel, versions.latest, versions.recommended, versions.min, graceUntil, PLATFORM_ADMIN.id],
  );
}
