/**
 * void-approval-fixture.ts — RT-530.
 *
 * Seeds the approver population a manager-approved void is checked against
 * (users, per-tenant roles, memberships, store access) and builds a void body
 * that carries a valid bound approval. NOT a spec file.
 *
 * Population (tenant A unless noted; the harness store is STORE_A_X):
 *   - APPROVER_MANAGER        store_manager, access to STORE_A_X     -> eligible
 *   - APPROVER_TENANT_ADMIN   tenant_admin,  access to all stores    -> eligible
 *   - APPROVER_OWNER          owner,         access to all stores    -> eligible
 *   - APPROVER_CASHIER        store_staff,   access to all stores    -> NOT a manager
 *   - APPROVER_NO_STORE       store_manager, access to STORE_A_Y only -> no store access
 *   - APPROVER_REVOKED        store_manager, membership revoked      -> inactive
 *   - APPROVER_OTHER_TENANT   store_manager of TENANT_B              -> not a tenant A user
 *   - HARNESS_REQUESTER       store_staff, access to STORE_A_X       -> the harness actor
 *                             (`DEVICE_USER_ID`), who captures the sales and so is the
 *                             default requester of a void; a requester must be a store user
 */
import type { Pool } from "pg";

import {
  STORE_A_X,
  STORE_A_Y,
  TENANT_A,
  TENANT_B,
  STORE_B_X,
} from "../../__support__/isolation-harness";

export const APPROVER_MANAGER = "0a000000-0000-7000-8000-0000000530a1";
export const APPROVER_TENANT_ADMIN = "0a000000-0000-7000-8000-0000000530a2";
export const APPROVER_OWNER = "0a000000-0000-7000-8000-0000000530a3";
export const APPROVER_CASHIER = "0a000000-0000-7000-8000-0000000530a4";
export const APPROVER_NO_STORE = "0a000000-0000-7000-8000-0000000530a5";
export const APPROVER_REVOKED = "0a000000-0000-7000-8000-0000000530a6";
export const APPROVER_OTHER_TENANT = "0b000000-0000-7000-8000-0000000530b1";

/** The capture harness's actor (`DEVICE_USER_ID`); the same literal, to avoid an import cycle. */
export const HARNESS_REQUESTER = "0d000000-0000-7000-8000-0000000005d1";

export const APPROVAL_ID = "0a000000-0000-7000-8000-0000000530c1";

interface Seeded {
  readonly userId: string;
  readonly email: string;
  readonly tenantId: string;
  readonly roleCode: string;
  readonly access: "all" | "specific";
  readonly stores: readonly string[];
  readonly revoked?: boolean;
}

const POPULATION: readonly Seeded[] = [
  { userId: APPROVER_MANAGER, email: "rt530-manager@example.test", tenantId: TENANT_A, roleCode: "store_manager", access: "specific", stores: [STORE_A_X] },
  { userId: APPROVER_TENANT_ADMIN, email: "rt530-admin@example.test", tenantId: TENANT_A, roleCode: "tenant_admin", access: "all", stores: [] },
  { userId: APPROVER_OWNER, email: "rt530-owner@example.test", tenantId: TENANT_A, roleCode: "owner", access: "all", stores: [] },
  { userId: APPROVER_CASHIER, email: "rt530-cashier@example.test", tenantId: TENANT_A, roleCode: "store_staff", access: "all", stores: [] },
  { userId: APPROVER_NO_STORE, email: "rt530-nostore@example.test", tenantId: TENANT_A, roleCode: "store_manager", access: "specific", stores: [STORE_A_Y] },
  { userId: APPROVER_REVOKED, email: "rt530-revoked@example.test", tenantId: TENANT_A, roleCode: "store_manager", access: "specific", stores: [STORE_A_X], revoked: true },
  { userId: APPROVER_OTHER_TENANT, email: "rt530-other@example.test", tenantId: TENANT_B, roleCode: "store_manager", access: "specific", stores: [STORE_B_X] },
  { userId: HARNESS_REQUESTER, email: "rt530-requester@example.test", tenantId: TENANT_A, roleCode: "store_staff", access: "specific", stores: [STORE_A_X] },
];

async function roleId(admin: Pool, tenantId: string, code: string): Promise<string> {
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name)
     VALUES (gen_random_uuid(), $1, $2, $2)
     ON CONFLICT DO NOTHING`,
    [tenantId, code],
  );
  const r = await admin.query<{ id: string }>(
    `SELECT id::text AS id FROM roles WHERE tenant_id = $1 AND code = $2`,
    [tenantId, code],
  );
  return r.rows[0]!.id;
}

async function seedOne(admin: Pool, p: Seeded): Promise<void> {
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [p.userId, p.email]);
  const rid = await roleId(admin, p.tenantId, p.roleCode);
  const membership = await admin.query<{ id: string }>(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind, revoked_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     RETURNING id::text AS id`,
    [p.tenantId, p.userId, rid, p.access, p.revoked === true ? new Date().toISOString() : null],
  );
  await Promise.all(
    p.stores.map((storeId) =>
      admin.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`, [
        membership.rows[0]!.id,
        storeId,
        p.tenantId,
      ]),
    ),
  );
}

/**
 * Seed the approver population. Call once after the isolation fixture. Roles
 * are created first (one per tenant and code), then each user in parallel.
 */
export async function seedVoidApprovers(admin: Pool): Promise<void> {
  const roleKeys = new Set(POPULATION.map((p) => `${p.tenantId}|${p.roleCode}`));
  await Promise.all(
    [...roleKeys].map((key) => {
      const [tenantId, roleCode] = key.split("|") as [string, string];
      return roleId(admin, tenantId, roleCode);
    }),
  );
  await Promise.all(POPULATION.map((p) => seedOne(admin, p)));
}

export interface ApprovedVoidOverrides {
  /** Top-level body fields (sourceSystem, externalId, businessDate, ...). */
  readonly body?: Record<string, unknown>;
  /** Fields of the `approval` object; `null` for a key removes it. */
  readonly approval?: Record<string, unknown>;
  /** Omit the whole `approval` object. */
  readonly omitApproval?: boolean;
}

/**
 * A void body for `saleRef` carrying a VALID bound approval, built from the
 * sale as stored: its exact `pos_total`, its `business_date`, its `created_by`
 * as the requester (the harness actor made the sale), and an eligible
 * manager as approver. Override any part to build a negative case.
 */
export async function approvedVoidBody(
  admin: Pool,
  saleRef: string,
  overrides: ApprovedVoidOverrides = {},
): Promise<Record<string, unknown>> {
  const sale = await admin.query<{ amount: string; business_date: string; created_by: string }>(
    `SELECT pos_total::text AS amount, business_date::text AS business_date, created_by::text AS created_by
       FROM sales WHERE id = $1`,
    [saleRef],
  );
  const row = sale.rows[0];
  const amount = row?.amount ?? "0.0000";
  const approval: Record<string, unknown> = {
    approvalId: APPROVAL_ID,
    action: "sale.void",
    saleRef,
    amount,
    requesterUserId: row?.created_by ?? APPROVER_CASHIER,
    approverUserId: APPROVER_MANAGER,
    policyVersion: "rt114-2026-10-07",
    approvedAt: new Date().toISOString(),
    ...overrides.approval,
  };
  for (const [k, v] of Object.entries(approval)) {
    if (v === null) delete approval[k];
  }
  const body: Record<string, unknown> = {
    sourceSystem: "pos-1",
    externalId: "void-evt-001",
    businessDate: row?.business_date ?? "2026-05-01",
    ...(overrides.omitApproval === true ? {} : { approval }),
    ...overrides.body,
  };
  return body;
}
