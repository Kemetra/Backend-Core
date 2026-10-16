/**
 * RT-562 — fixture for the console sales read spec.
 *
 * Builds on the RT-192 read-store-scope seed (tenants A/B; STORE_A_X granted
 * to the `specific` owner and tenant_admin; STORE_A_Y never granted;
 * S_DELETED granted to the `specific` owner, then soft-deleted; the `all`
 * owner with and without STORE_A_X active) and adds:
 *
 *   Members (tenant A, `console-members.ts`):
 *     SES_MANAGER          store_manager, `specific` X + Y, no active store
 *     SES_MANAGER_ACTIVE   the same manager with Y active (narrowed to Y)
 *     SES_STAFF            store_staff, `all` (not an allowed role → 404)
 *     SES_ADMIN_EMPTY      tenant_admin, `specific`, only the deleted store
 *     SES_PLATFORM         platform admin, no membership, no active store
 *     SES_PLATFORM_ACTIVE  the same platform admin with X active
 *   Bearers that must all be 401: the manager's `dashboard_api` token, a POS
 *   `pos_operator` token and the till's device token.
 *
 *   Sales. STORE_A_X is `Africa/Cairo`; every business date is the capture
 *   expression `(occurred_at AT TIME ZONE stores.timezone)::date`. X sales in
 *   October 2026, newest first by (businessDate, occurredAt, saleRef):
 *     X_OCT31    10-31  10:00Z
 *     X_TIE_B    10-06  12:00:00.000001Z  (same occurredAt as X_TIE_A; id B > A)
 *     X_TIE_A    10-06  12:00:00.000001Z
 *     X_LATE     10-05  2026-10-04T23:30Z → the NEXT Cairo business date
 *     X_LEGACY   10-04  pre-RT-77: no device, tender-unknown, no snapshot,
 *                       no posting row, failed-needs-repair
 *     X_PARTIAL  10-03  10:00Z  one of two lines returned; posting failed_transient
 *     X_FULL     10-03  09:00Z  every line returned; posting permanently_rejected
 *     X_VOID     10-02  approved void; sale posted, reversal pending
 *     X_OCT01    10-01  complete receipt snapshot (X-0001); posted SINV-0001
 *   Outside the range: X_SEP30 (09-30) and X_NOV01 (11-01).
 *   Y_OCT02 (STORE_A_Y, UTC), DEL_OCT02 (S_DELETED), B_OCT02 (tenant B).
 *   Bulk: BULK_COUNT plain STORE_A_Y sales in September, then the two oldest:
 *   BULK_VOID (voided) and BULK_REPAIR (failed-needs-repair, receipt
 *   BULK_REPAIR_NUMBER). Any filter over the bulk reads a bounded page first.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `0562`
 * mnemonic (hex only).
 */
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import type { Pool } from "pg";

import type { PgTestEnv } from "../../_helpers/postgres-container";
import { seedConsoleMember } from "../../_helpers/console-members";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import {
  registerTestSession,
  S_DELETED,
  seedReadStoreScope,
} from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";

const id = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export const X_SEP30 = id("562a01");
export const X_OCT01 = id("562a02");
export const X_VOID = id("562a03");
export const X_FULL = id("562a04");
export const X_PARTIAL = id("562a05");
export const X_LEGACY = id("562a06");
export const X_LATE = id("562a07");
export const X_TIE_A = id("562a08");
export const X_TIE_B = id("562a09");
export const X_OCT31 = id("562a0a");
export const X_NOV01 = id("562a0b");
export const Y_OCT02 = id("562b01");
export const BULK_VOID = id("562b02");
export const BULK_REPAIR = id("562b03");
export const BULK_REPAIR_NUMBER = "Y-0001";
export const DEL_OCT02 = id("562c01");
export const B_OCT02 = "0b000000-0000-7000-8000-000000562d01";
export const NO_SALE = id("562aff");

/** STORE_A_X, 2026-10-01..2026-10-31, in list order. */
export const X_OCTOBER = [X_OCT31, X_TIE_B, X_TIE_A, X_LATE, X_LEGACY, X_PARTIAL, X_FULL, X_VOID, X_OCT01];

export const BULK_COUNT = 520;
export const BULK_RANGE = { from: "2026-09-01", to: "2026-09-20" } as const;

export const X_OCT01_SALE_NUMBER = "X-0001";
export const SALE_DOC = "SINV-0001";
export const VOID_SALE_DOC = "SINV-0002";

// ---------------------------------------------------------------------------
// People, devices, sessions, bearers
// ---------------------------------------------------------------------------

export const CASHIER = id("562e01");
export const APPROVER = id("562e02");
const USER_MANAGER = id("562e03");
const USER_STAFF = id("562e04");
const USER_ADMIN_EMPTY = id("562e05");
export const USER_PLATFORM = id("562e06");
export const DEVICE_X = id("562f01");

export const SES_MANAGER = id("5621a1");
export const SES_MANAGER_ACTIVE = id("5621a2");
export const SES_STAFF = id("5621a3");
export const SES_ADMIN_EMPTY = id("5621a4");
export const SES_PLATFORM = id("5621a5");
export const SES_PLATFORM_ACTIVE = id("5621a6");
export { USER_MANAGER };

export const DASHBOARD_TOKEN = generateRawToken();
export const OPERATOR_TOKEN = generateRawToken();
export const DEVICE_TOKEN = generateRawToken();

const ZERO_HASH = "0".repeat(64);

interface SeedSale {
  readonly id: string;
  readonly tenantId?: string;
  readonly storeId?: string;
  readonly occurredAt: string;
  readonly device?: string | null;
  /** The receipt sale number; a receipt snapshot is written when set. */
  readonly saleNumber?: string;
  readonly lineSeq?: boolean;
  /** false: tender-unknown (tender_count 0, no tender rows). */
  readonly tendered?: boolean;
  readonly syncStatus?: string;
}

/** A sale with two lines (Widget 5.00, Gadget 7.50) and, when tendered, one cash tender. */
async function seedSale(admin: Pool, s: SeedSale): Promise<void> {
  const tenantId = s.tenantId ?? TENANT_A;
  const storeId = s.storeId ?? STORE_A_X;
  const snapshot = s.saleNumber !== undefined;
  const tendered = s.tendered ?? true;
  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by, sync_status, device_id, tender_count,
        receipt_sale_number, receipt_terminal_label, receipt_operator_display_name, receipt_settled_at,
        receipt_branch_name, receipt_branch_address, receipt_tax_registration_id, receipt_change_given)
     SELECT $1, $2, $3, 'EGP', 12.50, $4::timestamptz, ($4::timestamptz AT TIME ZONE st.timezone)::date,
            'rt562-seed', $18, $5, $6, $7, $8, $9,
            $10, $11, $12, $13::timestamptz, $14, $15, $16, $17::numeric
       FROM stores st WHERE st.id = $3`,
    [
      s.id,
      tenantId,
      storeId,
      s.occurredAt,
      ZERO_HASH,
      CASHIER,
      s.syncStatus ?? "synced",
      s.device === undefined ? (storeId === STORE_A_X ? DEVICE_X : null) : s.device,
      tendered ? 1 : 0,
      s.saleNumber ?? null,
      snapshot ? "till-1 (printed)" : null,
      snapshot ? "Cashier One (printed)" : null,
      snapshot ? s.occurredAt : null,
      snapshot ? "Nile Branch" : null,
      snapshot ? "1 Nile St, Cairo" : null,
      snapshot ? "123-456-789" : null,
      snapshot ? "2.50" : null,
      `rt562-${s.id}`,
    ],
  );
  const seqs = s.lineSeq === true ? [1, 2] : [null, null];
  await admin.query(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity, line_amount, unit, line_seq)
     VALUES (gen_random_uuid(), $1, $2, $3, 'Widget', 5.00, 'EGP', 1, 5.00, 'unit', $4),
            (gen_random_uuid(), $1, $2, $3, 'Gadget', 7.50, 'EGP', 1, 7.50, 'unit', $5)`,
    [s.id, tenantId, storeId, seqs[0], seqs[1]],
  );
  if (tendered) {
    await admin.query(
      `INSERT INTO sale_tenders (id, sale_id, tenant_id, store_id, method, amount, currency_code, sequence)
       VALUES (gen_random_uuid(), $1, $2, $3, 'cash', 12.50, 'EGP', 1)`,
      [s.id, tenantId, storeId],
    );
  }
}

async function seedPosting(admin: Pool, saleId: string, kind: "sale_post" | "reversal", sourceRefId: string, status: string, documentRef: string | null): Promise<void> {
  await admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status, document_ref)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'rt562-seed', $6, $7, $8, $9)`,
    [TENANT_A, STORE_A_X, saleId, kind, sourceRefId, `post-${kind}-${sourceRefId}`, ZERO_HASH, status, documentRef],
  );
}

async function seedApprovedVoid(admin: Pool, saleId: string): Promise<void> {
  const voidId = id("562a33");
  await admin.query(
    `INSERT INTO sale_voids
       (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash,
        created_by, approval_id, approved_by_user_id, requested_by_user_id, approval_policy_version,
        approved_at, void_business_date)
     VALUES ($1, $2, $3, $4, '2026-10-02', 'rt562-seed', $5, $6, $7, gen_random_uuid(), $8, $7, 'rt530-v1',
             '2026-10-02T12:00:00Z', '2026-10-02')`,
    [voidId, saleId, TENANT_A, STORE_A_X, `void-${voidId}`, ZERO_HASH, CASHIER, USER_MANAGER],
  );
  await seedPosting(admin, saleId, "reversal", voidId, "pending", null);
}

/** Return the named lines of `saleId` in full (one return). */
async function seedReturn(admin: Pool, saleId: string, returnId: string, lineNames: readonly string[]): Promise<void> {
  await admin.query(
    `INSERT INTO sale_returns
       (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code, return_total,
        source_system, external_id, payload_hash, created_by)
     SELECT $1, $2, $3, $4, 1, '2026-10-03', 'EGP', sum(line_amount), 'rt562-seed', $8, $5, $6
       FROM sale_lines WHERE sale_id = $2 AND line_name = ANY($7::text[])`,
    [returnId, saleId, TENANT_A, STORE_A_X, ZERO_HASH, USER_MANAGER, lineNames, `rt562-return-${returnId}`],
  );
  await admin.query(
    `INSERT INTO sale_return_lines
       (id, return_id, sale_line_id, tenant_id, store_id, quantity, line_amount, returned_quantity_after)
     SELECT gen_random_uuid(), $1, sl.id, sl.tenant_id, sl.store_id, sl.quantity, sl.line_amount, sl.quantity
       FROM sale_lines sl WHERE sl.sale_id = $2 AND sl.line_name = ANY($3::text[])`,
    [returnId, saleId, lineNames],
  );
}

export const RETURN_PARTIAL = id("562a51");
const RETURN_FULL = id("562a52");

async function seedSales(admin: Pool): Promise<void> {
  const x: SeedSale[] = [
    { id: X_SEP30, occurredAt: "2026-09-30T10:00:00Z" },
    { id: X_OCT01, occurredAt: "2026-10-01T09:00:00Z", saleNumber: X_OCT01_SALE_NUMBER, lineSeq: true },
    { id: X_VOID, occurredAt: "2026-10-02T09:00:00Z" },
    { id: X_FULL, occurredAt: "2026-10-03T09:00:00Z" },
    { id: X_PARTIAL, occurredAt: "2026-10-03T10:00:00Z" },
    { id: X_LEGACY, occurredAt: "2026-10-04T08:00:00Z", device: null, tendered: false, syncStatus: "failed-needs-repair" },
    { id: X_LATE, occurredAt: "2026-10-04T23:30:00Z" },
    { id: X_TIE_A, occurredAt: "2026-10-06T12:00:00.000001Z" },
    { id: X_TIE_B, occurredAt: "2026-10-06T12:00:00.000001Z" },
    { id: X_OCT31, occurredAt: "2026-10-31T10:00:00Z" },
    { id: X_NOV01, occurredAt: "2026-11-01T10:00:00Z" },
    { id: Y_OCT02, storeId: STORE_A_Y, occurredAt: "2026-10-02T09:00:00Z" },
    { id: DEL_OCT02, storeId: S_DELETED, occurredAt: "2026-10-02T09:00:00Z" },
    { id: B_OCT02, tenantId: TENANT_B, storeId: STORE_B_X, occurredAt: "2026-10-02T09:00:00Z" },
    { id: BULK_VOID, storeId: STORE_A_Y, occurredAt: "2026-09-01T00:30:00Z" },
    {
      id: BULK_REPAIR,
      storeId: STORE_A_Y,
      occurredAt: "2026-09-01T00:20:00Z",
      saleNumber: BULK_REPAIR_NUMBER,
      syncStatus: "failed-needs-repair",
    },
  ];
  for (const sale of x) await seedSale(admin, sale);

  await seedPosting(admin, X_OCT01, "sale_post", X_OCT01, "posted", SALE_DOC);
  await seedPosting(admin, X_VOID, "sale_post", X_VOID, "posted", VOID_SALE_DOC);
  await seedPosting(admin, X_PARTIAL, "sale_post", X_PARTIAL, "failed_transient", null);
  await seedPosting(admin, X_FULL, "sale_post", X_FULL, "permanently_rejected", null);
  await seedApprovedVoid(admin, X_VOID);
  await seedReturn(admin, X_PARTIAL, RETURN_PARTIAL, ["Gadget"]);
  await seedReturn(admin, X_FULL, RETURN_FULL, ["Widget", "Gadget"]);

  // BULK_VOID is the oldest of the September bulk, so a voided filter reaches it last.
  await admin.query(
    `INSERT INTO sale_voids
       (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, '2026-09-01', 'rt562-seed', 'void-bulk', $4, $5)`,
    [BULK_VOID, TENANT_A, STORE_A_Y, ZERO_HASH, CASHIER],
  );
  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by, sync_status, tender_count)
     SELECT gen_random_uuid(), $1, $2, 'EGP', 1.00, t, (t AT TIME ZONE 'UTC')::date,
            'rt562-bulk', 'bulk-' || g, $3, $4, 'synced', 0
       FROM generate_series(1, $5::int) AS g,
            LATERAL (SELECT timestamptz '2026-09-01T01:00:00Z' + (g * interval '50 minutes') AS t) ts`,
    [TENANT_A, STORE_A_Y, ZERO_HASH, CASHIER, BULK_COUNT],
  );
}

// ---------------------------------------------------------------------------
// Members, platform admin, bearers
// ---------------------------------------------------------------------------

async function seedPeople(admin: Pool): Promise<void> {
  await admin.query(
    `INSERT INTO users (id, email, display_name) VALUES
       ($1, 'rt562-cashier@example.test', 'Cashier One'), ($2, 'rt562-approver@example.test', 'Approver')`,
    [CASHIER, APPROVER],
  );
  await admin.query(`INSERT INTO devices (id, tenant_id, store_id, token_hash, label) VALUES ($1, $2, $3, $4, 'till-1')`, [
    DEVICE_X,
    TENANT_A,
    STORE_A_X,
    hashToken(DEVICE_TOKEN),
  ]);
  const members = [
    { userId: USER_MANAGER, roleCode: "store_manager", stores: [STORE_A_X, STORE_A_Y], sessions: { [SES_MANAGER]: null, [SES_MANAGER_ACTIVE]: STORE_A_Y } },
    { userId: USER_STAFF, roleCode: "store_staff", stores: "all" as const, sessions: { [SES_STAFF]: null } },
    { userId: USER_ADMIN_EMPTY, roleCode: "tenant_admin", stores: [S_DELETED], sessions: { [SES_ADMIN_EMPTY]: null } },
  ];
  for (const [i, m] of members.entries()) {
    await seedConsoleMember(admin, {
      tenantId: TENANT_A,
      userId: m.userId,
      email: `rt562-member-${i}@example.test`,
      membershipId: id(`5622a${i}`),
      roleId: id(`5623a${i}`),
      roleCode: m.roleCode,
      stores: m.stores,
      sessions: m.sessions,
    });
  }
  await admin.query(
    `INSERT INTO users (id, email, is_platform_admin) VALUES ($1, 'rt562-platform@example.test', true)`,
    [USER_PLATFORM],
  );
  await admin.query(
    `INSERT INTO sessions (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
     VALUES ($1, $3, $4, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
            ($2, $3, $4, $5,   now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
    [SES_PLATFORM, SES_PLATFORM_ACTIVE, USER_PLATFORM, TENANT_A, STORE_A_X],
  );
  registerTestSession(SES_PLATFORM, USER_PLATFORM);
  registerTestSession(SES_PLATFORM_ACTIVE, USER_PLATFORM);

  await admin.query(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'dashboard_api', now() + interval '1 hour')`,
    [hashToken(DASHBOARD_TOKEN), TENANT_A, USER_MANAGER],
  );
  await admin.query(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, device_id, store_id, scope, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pos_operator', now() + interval '1 hour')`,
    [hashToken(OPERATOR_TOKEN), TENANT_A, USER_MANAGER, DEVICE_X, STORE_A_X],
  );
}

/** Seed the RT-192 read fixture, Cairo time for STORE_A_X, the members and the sales. */
export async function seedConsoleSalesFixture(env: PgTestEnv): Promise<void> {
  await seedReadStoreScope(env);
  await env.admin.query(`UPDATE stores SET timezone = 'Africa/Cairo' WHERE id = $1`, [STORE_A_X]);
  await seedPeople(env.admin);
  await seedSales(env.admin);
  await env.admin.query(`ANALYZE sales`);
}

/** Insert one more plain STORE_A_X sale (the walk-stability test); returns a cleanup. */
export async function insertArrival(admin: Pool, saleId: string, occurredAt: string): Promise<() => Promise<void>> {
  await seedSale(admin, { id: saleId, occurredAt });
  return async () => {
    await admin.query(`DELETE FROM sale_tenders WHERE sale_id = $1`, [saleId]);
    await admin.query(`DELETE FROM sale_lines WHERE sale_id = $1`, [saleId]);
    await admin.query(`DELETE FROM sales WHERE id = $1`, [saleId]);
  };
}
