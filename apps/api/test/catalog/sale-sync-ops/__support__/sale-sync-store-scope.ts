/**
 * RT-193 — fixture for the 032 sale-sync-ops store-scope spec.
 *
 * Builds on the RT-192 read-store-scope seed (tenant A/B, STORE_A_X granted to
 * the `specific` owner and tenant_admin, STORE_A_Y never granted, S_DELETED
 * granted then soft-deleted, the `all` owner with and without an active store)
 * and adds:
 *
 *   NEEDS_REPAIR sales with an OPEN `needs-repair` dead-letter, ids ascending in
 *   insertion order (the list is newest-first on the UUIDv7 id):
 *     SS_X1 (STORE_A_X)  SS_Y1 (STORE_A_Y)  SS_X2 (X)  SS_Y2 (Y)  SS_X3 (X)
 *     SS_DEL (S_DELETED)                   SS_B (tenant B, STORE_B_X)
 *   An `empty`-scope tenant_admin: a `specific` membership whose only grant is
 *   the soft-deleted store, so it resolves to no store at all.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `0193`
 * mnemonic (hex only) and are valid UUIDv7 (the list cursor format).
 */
import type { Pool } from "pg";

import type { PgTestEnv } from "../../../_helpers/postgres-container";
import {
  ACTOR_A,
  ACTOR_B,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
} from "../../__support__/isolation-harness";
import {
  registerTestSession,
  S_DELETED,
  seedReadStoreScope,
} from "../../erpnext-reconciliation/__support__/read-store-scope";
import { SALES_SOURCE_SYSTEM } from "../../sales/__support__/seed-sales";

export const SS_X1 = "0a000000-0000-7000-8000-0000019301a1";
export const SS_Y1 = "0a000000-0000-7000-8000-0000019301a2";
export const SS_X2 = "0a000000-0000-7000-8000-0000019301a3";
export const SS_Y2 = "0a000000-0000-7000-8000-0000019301a4";
export const SS_X3 = "0a000000-0000-7000-8000-0000019301a5";
export const SS_DEL = "0a000000-0000-7000-8000-0000019301a6";
export const SS_B = "0b000000-0000-7000-8000-0000019301b1";
export const SS_MISSING = "0a000000-0000-7000-8000-0000019301ff";

const USER_ADMIN_EMPTY = "0a000000-0000-7000-8000-0000019302a1";
const MEM_ADMIN_EMPTY = "0a000000-0000-7000-8000-0000019303a1";
/** tenant_admin, `specific` membership whose only grant is the soft-deleted store. */
export const SES_ADMIN_EMPTY = "0a000000-0000-7000-8000-0000019304a1";

interface SaleRow {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
}

/** Tenant A sales in ascending id order (= the order they were seeded). */
const NEEDS_REPAIR_SALES: readonly SaleRow[] = [
  { id: SS_X1, tenantId: TENANT_A, storeId: STORE_A_X },
  { id: SS_Y1, tenantId: TENANT_A, storeId: STORE_A_Y },
  { id: SS_X2, tenantId: TENANT_A, storeId: STORE_A_X },
  { id: SS_Y2, tenantId: TENANT_A, storeId: STORE_A_Y },
  { id: SS_X3, tenantId: TENANT_A, storeId: STORE_A_X },
  { id: SS_DEL, tenantId: TENANT_A, storeId: S_DELETED },
  { id: SS_B, tenantId: TENANT_B, storeId: STORE_B_X },
];

async function insertNeedsRepairSale(admin: Pool, row: SaleRow): Promise<void> {
  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by, sync_status)
     VALUES ($1, $2, $3, 'USD', 1.0000, now(), '2026-05-01', $4, $5, $6, $7, 'failed-needs-repair')`,
    [
      row.id, row.tenantId, row.storeId, SALES_SOURCE_SYSTEM, `rt193-${row.id}`, "a".repeat(64),
      row.tenantId === TENANT_A ? ACTOR_A : ACTOR_B,
    ],
  );
  await admin.query(
    `INSERT INTO sale_sync_deadletters
       (sale_id, tenant_id, store_id, classification, reason_code, source_system, external_id)
     VALUES ($1, $2, $3, 'needs-repair', 'validation_failure', $4, $5)`,
    [row.id, row.tenantId, row.storeId, SALES_SOURCE_SYSTEM, `rt193-${row.id}`],
  );
}

async function seedEmptyScopeMember(admin: Pool): Promise<void> {
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt193-admin-empty@example.test')`, [
    USER_ADMIN_EMPTY,
  ]);
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     SELECT $1, $2, $3, id, 'specific' FROM roles WHERE tenant_id = $2 AND code = 'tenant_admin'`,
    [MEM_ADMIN_EMPTY, TENANT_A, USER_ADMIN_EMPTY],
  );
  await admin.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`, [
    MEM_ADMIN_EMPTY,
    S_DELETED,
    TENANT_A,
  ]);
  await admin.query(
    `INSERT INTO sessions (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
     VALUES ($1, $2, $3, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
    [SES_ADMIN_EMPTY, USER_ADMIN_EMPTY, TENANT_A],
  );
  registerTestSession(SES_ADMIN_EMPTY, USER_ADMIN_EMPTY);
}

/** Seed the RT-192 read fixture, the NEEDS_REPAIR sales and the empty-scope member. */
export async function seedSaleSyncStoreScope(env: PgTestEnv): Promise<void> {
  await seedReadStoreScope(env);
  for (const row of NEEDS_REPAIR_SALES) await insertNeedsRepairSale(env.admin, row);
  await seedEmptyScopeMember(env.admin);
}

/** The persisted repair state of one sale (admin pool, RLS bypass). */
export interface SaleRepairState {
  readonly syncStatus: string;
  readonly openDeadletters: number;
  readonly retryCount: number;
}

export async function saleRepairState(admin: Pool, saleId: string): Promise<SaleRepairState> {
  const r = await admin.query<{ sync_status: string; open: string; retries: string }>(
    `SELECT s.sync_status,
            (SELECT count(*) FROM sale_sync_deadletters d
              WHERE d.sale_id = s.id AND d.resolved_at IS NULL)::text AS open,
            (SELECT coalesce(sum(retry_count), 0) FROM sale_sync_deadletters d
              WHERE d.sale_id = s.id)::text AS retries
       FROM sales s WHERE s.id = $1`,
    [saleId],
  );
  const row = r.rows[0]!;
  return { syncStatus: row.sync_status, openDeadletters: Number(row.open), retryCount: Number(row.retries) };
}
