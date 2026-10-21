/**
 * Shared Testcontainers harness for the RT-788 (RT-114 MA-BC2)
 * approver-eligibility integration spec.
 *
 *   - Real PostgreSQL with every migration applied.
 *   - The real PosApproversModule: the real PosDeviceAuthGuard +
 *     DeviceRepository (on the RLS-bypassing lookup pool, as in production)
 *     and the eligibility read on the NOBYPASSRLS `app_test` domain pool, so
 *     it runs under the tenant GUC and the RLS policies.
 *   - Response bodies are checked against the merged OpenAPI contract with AJV.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { hashToken } from "@data-pulse-2/auth";
import { Pool } from "pg";
import request from "supertest";

import { PosApproversModule } from "../../../src/pos-approvers/pos-approvers.module";
import { bootDeviceModuleApp, startPgEnvOrSkip } from "../../_helpers/device-module-app";
import { stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import { schemaChecker } from "../../_helpers/scoped-http-harness";

/** A UUID: a user, tenant, store, role, membership, device or request id. */
export type Uuid = string;
/** A 4-hex-digit fixture suffix, e.g. "0001". */
type FixtureSuffix = string;
/** The spec name a skip warning is reported under. */
type SuiteLabel = string;

// ---------------------------------------------------------------------------
// Fixture identifiers (hex-only suffixes; UUID v4 shape)
// ---------------------------------------------------------------------------
export const TENANT_A = "07880000-0000-4000-8000-0000000a0001";
export const TENANT_B = "07880000-0000-4000-8000-0000000b0001";
export const STORE_A1 = "07880000-0000-4000-8000-0000000a5001";
export const STORE_A2 = "07880000-0000-4000-8000-0000000a5002";
export const STORE_B1 = "07880000-0000-4000-8000-0000000b5001";

type RoleCode = "owner" | "tenant_admin" | "store_manager" | "store_staff";

const ROLES_A: Readonly<Record<RoleCode, Uuid>> = {
  owner: "07880000-0000-4000-8000-0000000a7001",
  tenant_admin: "07880000-0000-4000-8000-0000000a7002",
  store_manager: "07880000-0000-4000-8000-0000000a7003",
  store_staff: "07880000-0000-4000-8000-0000000a7004",
};
const ROLE_B_MANAGER = "07880000-0000-4000-8000-0000000b7003";

export interface FixtureUser {
  readonly id: Uuid;
  readonly membership: Uuid;
}

function user(suffix: FixtureSuffix): FixtureUser {
  return {
    id: `07880000-0000-4000-8000-0000000c${suffix}`,
    membership: `07880000-0000-4000-8000-0000000d${suffix}`,
  };
}

/** owner, all stores of tenant A. */
export const OWNER = user("0001");
/** tenant_admin, all stores. */
export const TENANT_ADMIN = user("0002");
/** store_manager, all stores. */
export const MANAGER = user("0003");
/** store_manager, specific access to STORE_A1 only. */
export const MANAGER_A1 = user("0004");
/** store_manager, specific access to STORE_A2 only (not A1). */
export const MANAGER_A2 = user("0005");
/** store_staff (cashier), all stores: not a manager-eligible role. */
export const STAFF = user("0006");
/** store_manager, soft-deleted user. */
export const DELETED = user("0007");
/** store_manager, revoked membership. */
export const REVOKED = user("0008");
/** store_manager, soft-deleted membership. */
export const MEMBERSHIP_DELETED = user("0009");
/** store_manager, specific access to A1; tests remove that access (reset after each test). */
export const MUTABLE = user("000a");
/** store_manager of TENANT_B, all stores. */
export const MANAGER_B = user("000b");

export interface FixtureDevice {
  readonly id: Uuid;
  readonly token: string;
}

function device(n: FixtureSuffix): FixtureDevice {
  return { id: `07880000-0000-4000-8000-0000000e${n}`, token: `rt788-device-token-${n}-aaaaaaaaaaaaaaaa` };
}

export const DEV_A1 = device("0001");
export const DEV_A2 = device("0002");
export const DEV_B1 = device("0003");
export const DEV_REVOKED = device("0004");

export const ELIGIBILITY = "/api/pos/v1/approvers/eligibility";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
export interface Harness {
  env: PgTestEnv;
  admin: Pool;
  app: INestApplication;
}

let harness: Harness | null = null;

export function h(): Harness {
  if (!harness) throw new Error("harness not started");
  return harness;
}

export function skipped(): boolean {
  if (harness) return false;
  // eslint-disable-next-line no-console
  console.warn("[pos-approvers] skipping — Docker unavailable");
  return true;
}

export async function startHarness(label: SuiteLabel): Promise<void> {
  const env = await startPgEnvOrSkip(label);
  if (env === null) return;
  const admin = new Pool({ connectionString: env.adminUri });
  await seed(admin);
  const app = await bootDeviceModuleApp(PosApproversModule, { domain: env.app, lookup: admin });
  harness = { env, admin, app };
}

export async function stopHarness(): Promise<void> {
  if (!harness) return;
  await harness.app.close().catch(() => undefined);
  await harness.admin.end().catch(() => undefined);
  await stopPgEnv(harness.env);
  harness = null;
}

/** Restore the fixture a test mutated. */
export async function resetState(): Promise<void> {
  if (!harness) return;
  await harness.admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [MUTABLE.membership, STORE_A1, TENANT_A],
  );
}

/** Remove MUTABLE's access to STORE_A1 (the "store removed" predicate). */
export async function removeMutableStoreAccess(): Promise<void> {
  await h().admin.query("DELETE FROM store_access WHERE membership_id = $1", [MUTABLE.membership]);
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
interface MemberSeed {
  readonly user: FixtureUser;
  readonly tenantId: Uuid;
  readonly roleId: Uuid;
  readonly access: "all" | "specific";
}

async function seed(admin: Pool): Promise<void> {
  await admin.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt788-a', 'RT-788 A'), ($2, 'rt788-b', 'RT-788 B')`,
    [TENANT_A, TENANT_B],
  );
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $6, 'owner', 'Owner'), ($2, $6, 'tenant_admin', 'Admin'),
       ($3, $6, 'store_manager', 'Manager'), ($4, $6, 'store_staff', 'Staff'),
       ($5, $7, 'store_manager', 'Manager B')`,
    [ROLES_A.owner, ROLES_A.tenant_admin, ROLES_A.store_manager, ROLES_A.store_staff, ROLE_B_MANAGER, TENANT_A, TENANT_B],
  );
  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $4, 'A1', 'Store A1'), ($2, $4, 'A2', 'Store A2'), ($3, $5, 'B1', 'Store B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  const tenantA: Array<[FixtureUser, RoleCode, "all" | "specific"]> = [
    [OWNER, "owner", "all"],
    [TENANT_ADMIN, "tenant_admin", "all"],
    [MANAGER, "store_manager", "all"],
    [MANAGER_A1, "store_manager", "specific"],
    [MANAGER_A2, "store_manager", "specific"],
    [STAFF, "store_staff", "all"],
    [DELETED, "store_manager", "all"],
    [REVOKED, "store_manager", "all"],
    [MEMBERSHIP_DELETED, "store_manager", "all"],
    [MUTABLE, "store_manager", "specific"],
  ];
  for (const [u, role, access] of tenantA) {
    await seedMember(admin, { user: u, tenantId: TENANT_A, roleId: ROLES_A[role], access });
  }
  await seedMember(admin, { user: MANAGER_B, tenantId: TENANT_B, roleId: ROLE_B_MANAGER, access: "all" });
  await admin.query("UPDATE users SET deleted_at = now() WHERE id = $1", [DELETED.id]);
  await admin.query("UPDATE memberships SET revoked_at = now() WHERE id = $1", [REVOKED.membership]);
  await admin.query("UPDATE memberships SET deleted_at = now() WHERE id = $1", [MEMBERSHIP_DELETED.membership]);
  await admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES
       ($1, $4, $6), ($2, $5, $6), ($3, $4, $6)`,
    [MANAGER_A1.membership, MANAGER_A2.membership, MUTABLE.membership, STORE_A1, STORE_A2, TENANT_A],
  );
  const devices: Array<[FixtureDevice, Uuid, Uuid]> = [
    [DEV_A1, TENANT_A, STORE_A1],
    [DEV_A2, TENANT_A, STORE_A2],
    [DEV_B1, TENANT_B, STORE_B1],
    [DEV_REVOKED, TENANT_A, STORE_A1],
  ];
  for (const [d, tenant, store] of devices) {
    await admin.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'till', $4)`,
      [d.id, tenant, store, hashToken(d.token)],
    );
  }
  await admin.query("UPDATE devices SET revoked_at = now() WHERE id = $1", [DEV_REVOKED.id]);
}

async function seedMember(admin: Pool, m: MemberSeed): Promise<void> {
  const u = m.user;
  await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
    u.id,
    `${u.id}@rt788.example`,
    `User ${u.id.slice(-4)}`,
  ]);
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, $5)`,
    [u.membership, m.tenantId, u.id, m.roleId, m.access],
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
export function http(): ReturnType<typeof request> {
  return request(h().app.getHttpServer());
}

export function checkAs(d: FixtureDevice, body: unknown, requestId: Uuid = randomUUID()) {
  return http()
    .post(ELIGIBILITY)
    .set("authorization", `Bearer ${d.token}`)
    .set("x-request-id", requestId)
    .send(body as object);
}

/** The `results` of a 200, validated against the contract. */
export function results(res: { status: number; body: unknown; headers: Record<string, string> }): Array<{
  user_id: string;
  eligible: boolean;
}> {
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectSchema("PosApproverEligibilityResponse", res.body);
  return (res.body as { results: Array<{ user_id: string; eligible: boolean }> }).results;
}

/** Eligibility of each id, as one device sees it. */
export async function eligibilityOf(d: FixtureDevice, userIds: readonly Uuid[]): Promise<boolean[]> {
  const res = await checkAs(d, { user_ids: userIds });
  return results(res).map((r) => r.eligible);
}

// ---------------------------------------------------------------------------
// DB probes (admin pool: superuser, bypasses RLS)
// ---------------------------------------------------------------------------
export async function auditCountFor(requestId: Uuid): Promise<number> {
  const r = await h().admin.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM audit_events WHERE request_id = $1",
    [requestId],
  );
  return Number(r.rows[0]!.n);
}

// ---------------------------------------------------------------------------
// OpenAPI response validation
// ---------------------------------------------------------------------------
export type ContractSchema = "PosApproverEligibilityResponse" | "Error";

let conforms: ((name: string, body: unknown) => void) | null = null;

/** Throws with the AJV errors when `body` does not match the contract schema. */
export function expectSchema(schema: ContractSchema, body: unknown): void {
  conforms ??= schemaChecker("pos-approvers.openapi");
  conforms(schema, body);
}
