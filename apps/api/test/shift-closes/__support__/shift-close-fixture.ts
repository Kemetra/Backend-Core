/**
 * RT-383 — fixture for the admin shift-close read spec.
 *
 * Builds on the RT-192 read-store-scope seed (tenants A/B; STORE_A_X granted
 * to the `specific` owner and tenant_admin; STORE_A_Y never granted;
 * S_DELETED granted to the `specific` owner, then soft-deleted; the `all`
 * owner with and without an active store) and adds:
 *
 *   Members (tenant A):
 *     SES_MANAGER         store_manager, `specific` STORE_A_X + STORE_A_Y, no active store
 *     SES_MANAGER_ACTIVE  the same manager with STORE_A_Y active (narrowed to Y)
 *     SES_STAFF           store_staff, `all` (not an allowed role → 404)
 *     SES_ADMIN_EMPTY     tenant_admin, `specific`, only grant the deleted store → no store
 *
 *   Recorded closes, written through the production `ShiftCashUpRepository`
 *   (open → movements → close), newest first by (closedAt, shiftId):
 *     CLOSE_DEL  S_DELETED  2026-10-05T10:00:00Z        EGP  normal  0.00
 *     CLOSE_Y6   STORE_A_Y  2026-10-04T10:00:00.000002Z EGP  normal  +3.00
 *     CLOSE_Y5   STORE_A_Y  2026-10-04T10:00:00.000001Z USD  normal  -20.00
 *     CLOSE_X4   STORE_A_X  2026-10-03T10:00:00Z        EGP  normal  -100.00  approved
 *     CLOSE_X3   STORE_A_X  2026-10-03T10:00:00Z        EGP  forced  +12.50   (2 movements, 1 refund claim)
 *     CLOSE_Y2   STORE_A_Y  2026-10-02T10:00:00Z        EGP  normal  -5.00    approved
 *     CLOSE_X1   STORE_A_X  2026-10-01T10:00:00Z        EGP  normal  0.00
 *     CLOSE_B    tenant B   2026-10-06T10:00:00Z        EGP  normal  -1.00
 *   X3 and X4 share `closedAt` (tie broken by shiftId: X4 > X3); Y5 and Y6
 *   share the millisecond and differ in the microsecond.
 *
 *   Shifts with no recorded close: OPEN_X (cash-up, open) and LEGACY_X (an
 *   audit-ingest row), both on STORE_A_X.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `0383`
 * mnemonic (hex only).
 */
import { createHash } from "node:crypto";

import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import type { DeviceScope } from "../../../src/pos-cashier-admissions/device-scope";
import {
  ShiftCashUpRepository,
  type CashUpShiftRow,
  type NewCashMovement,
} from "../../../src/pos-shifts/shift-cash-up.repository";
import type { PgTestEnv } from "../../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import {
  registerTestSession,
  S_DELETED,
  seedReadStoreScope,
} from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

export const CLOSE_X1 = "0a000000-0000-7000-8000-0000038301a1";
export const CLOSE_Y2 = "0a000000-0000-7000-8000-0000038301a2";
export const CLOSE_X3 = "0a000000-0000-7000-8000-0000038301a3";
export const CLOSE_X4 = "0a000000-0000-7000-8000-0000038301a4";
export const CLOSE_Y5 = "0a000000-0000-7000-8000-0000038301a5";
export const CLOSE_Y6 = "0a000000-0000-7000-8000-0000038301a6";
export const CLOSE_DEL = "0a000000-0000-7000-8000-0000038301a7";
export const CLOSE_B = "0b000000-0000-7000-8000-0000038301b1";
export const OPEN_X = "0a000000-0000-7000-8000-0000038301e1";
export const LEGACY_X = "0a000000-0000-7000-8000-0000038301e2";
export const NO_SHIFT = "0a000000-0000-7000-8000-0000038301ff";

/** Tenant A closes, newest first by (closedAt, shiftId). */
export const TENANT_A_ORDER = [CLOSE_DEL, CLOSE_Y6, CLOSE_Y5, CLOSE_X4, CLOSE_X3, CLOSE_Y2, CLOSE_X1];

export const MOVEMENT_X3_PAY_IN = "0a000000-0000-7000-8000-0000038306a2";
export const MOVEMENT_X3_PAY_OUT = "0a000000-0000-7000-8000-0000038306a1";
export const RETURN_X3 = "0a000000-0000-7000-8000-0000038307a1";
const SALE_X3 = "0a000000-0000-7000-8000-0000038307b1";

export const CASHIER_A = "0a000000-0000-7000-8000-0000038302c1";
export const APPROVER_A = "0a000000-0000-7000-8000-0000038302c2";
const CASHIER_B = "0b000000-0000-7000-8000-0000038302c1";
const USER_MANAGER = "0a000000-0000-7000-8000-0000038302a1";
const USER_STAFF = "0a000000-0000-7000-8000-0000038302a2";
const USER_ADMIN_EMPTY = "0a000000-0000-7000-8000-0000038302a3";

const ROLE_MANAGER = "0a000000-0000-7000-8000-0000038303a1";
const ROLE_STAFF = "0a000000-0000-7000-8000-0000038303a2";
const MEM_MANAGER = "0a000000-0000-7000-8000-0000038304a1";
const MEM_STAFF = "0a000000-0000-7000-8000-0000038304a2";
const MEM_ADMIN_EMPTY = "0a000000-0000-7000-8000-0000038304a3";

export const SES_MANAGER = "0a000000-0000-7000-8000-0000038305a1";
export const SES_MANAGER_ACTIVE = "0a000000-0000-7000-8000-0000038305a2";
export const SES_STAFF = "0a000000-0000-7000-8000-0000038305a3";
export const SES_ADMIN_EMPTY = "0a000000-0000-7000-8000-0000038305a4";

const DEVICE_AX = "0a000000-0000-7000-8000-0000038308a1";
const DEVICE_AX_OPEN = "0a000000-0000-7000-8000-0000038308a2";
const DEVICE_AY = "0a000000-0000-7000-8000-0000038308a3";
const DEVICE_DEL = "0a000000-0000-7000-8000-0000038308a4";
const DEVICE_BX = "0b000000-0000-7000-8000-0000038308b1";

export const SCOPE_AX: DeviceScope = { tenantId: TENANT_A, storeId: STORE_A_X, deviceId: DEVICE_AX };
export const SCOPE_AY: DeviceScope = { tenantId: TENANT_A, storeId: STORE_A_Y, deviceId: DEVICE_AY };
const SCOPE_AX_OPEN: DeviceScope = { tenantId: TENANT_A, storeId: STORE_A_X, deviceId: DEVICE_AX_OPEN };
const SCOPE_DEL: DeviceScope = { tenantId: TENANT_A, storeId: S_DELETED, deviceId: DEVICE_DEL };
const SCOPE_BX: DeviceScope = { tenantId: TENANT_B, storeId: STORE_B_X, deviceId: DEVICE_BX };

// ---------------------------------------------------------------------------
// Close builder
// ---------------------------------------------------------------------------

const repo = new ShiftCashUpRepository();
const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Amounts in minor units (cents); the fixture's currencies all have two. */
interface CloseAmounts {
  readonly opening: number;
  readonly sales: number;
  readonly refunds: number;
  readonly payIn: number;
  readonly payOut: number;
  readonly counted: number;
}

const cents = (minor: number): string => {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

export interface SeedClose {
  readonly shiftId: string;
  readonly scope: DeviceScope;
  readonly closedAt: string;
  readonly currencyCode?: string;
  readonly amounts: CloseAmounts;
  readonly closeKind?: "normal" | "forced";
  readonly forcedReason?: string;
  readonly approverId?: string;
  readonly closingUserId?: string;
  readonly movements?: ReadonlyArray<Omit<NewCashMovement, "payloadHash" | "recordedByUserId">>;
  readonly refundRefs?: ReadonlyArray<string>;
}

function inTenant<T>(app: Pool, tenantId: string, work: (c: PoolClient) => Promise<T>): Promise<T> {
  return runWithTenantContext(app, { tenantId, isPlatformAdmin: false }, work);
}

async function openShift(app: Pool, seed: Pick<SeedClose, "shiftId" | "scope" | "currencyCode" | "closingUserId"> & {
  readonly openedAt: string;
  readonly openingFloat: string;
}): Promise<CashUpShiftRow> {
  const user = seed.closingUserId ?? CASHIER_A;
  const outcome = await inTenant(app, seed.scope.tenantId, (c) =>
    repo.insertShift(c, seed.scope, {
      shiftId: seed.shiftId,
      openedAt: seed.openedAt,
      openingUserId: user,
      currencyCode: seed.currencyCode ?? "EGP",
      openingFloat: seed.openingFloat,
      recordedByUserId: user,
      payloadHash: digest(`open:${seed.shiftId}`),
    }),
  );
  if (outcome.kind !== "inserted") throw new Error(`open ${seed.shiftId} failed: ${outcome.kind}`);
  return outcome.shift;
}

/** Open, record the movements and close one shift, as the POS routes do. */
export async function seedClose(app: Pool, seed: SeedClose): Promise<void> {
  const a = seed.amounts;
  const expected = a.opening + a.sales - a.refunds + a.payIn - a.payOut;
  const user = seed.closingUserId ?? CASHIER_A;
  const openedAt = new Date(Date.parse(seed.closedAt) - 8 * 3_600_000).toISOString();
  const shift = await openShift(app, { ...seed, openedAt, openingFloat: cents(a.opening) });
  for (const m of seed.movements ?? []) {
    await inTenant(app, seed.scope.tenantId, (c) =>
      repo.insertMovement(c, shift, { ...m, recordedByUserId: user, payloadHash: digest(`movement:${m.movementId}`) }),
    );
  }
  await inTenant(app, seed.scope.tenantId, (c) =>
    repo.insertClose(c, shift, {
      closedAt: seed.closedAt,
      closingUserId: user,
      closeKind: seed.closeKind ?? "normal",
      forcedReason: seed.closeKind === "forced" ? (seed.forcedReason ?? "Forced") : null,
      openingFloat: cents(a.opening),
      cashSalesTotal: cents(a.sales),
      cashRefundsTotal: cents(a.refunds),
      payInTotal: cents(a.payIn),
      payOutTotal: cents(a.payOut),
      expectedCash: cents(expected),
      countedCash: cents(a.counted),
      variance: cents(a.counted - expected),
      saleCount: 7,
      cashRefundReturnRefs: seed.refundRefs ?? [],
      varianceApprovedByUserId: seed.approverId ?? null,
      recordedByUserId: user,
      payloadHash: digest(`close:${seed.shiftId}`),
    }),
  );
}

/** opening 500.00, sales 1000.00, nothing else; `counted` sets the variance. */
const plain = (counted: number): CloseAmounts => ({
  opening: 50_000,
  sales: 100_000,
  refunds: 0,
  payIn: 0,
  payOut: 0,
  counted,
});

const CLOSES: readonly SeedClose[] = [
  { shiftId: CLOSE_X1, scope: SCOPE_AX, closedAt: "2026-10-01T10:00:00Z", amounts: plain(150_000) },
  {
    shiftId: CLOSE_Y2,
    scope: SCOPE_AY,
    closedAt: "2026-10-02T10:00:00Z",
    amounts: plain(149_500),
    approverId: APPROVER_A,
  },
  {
    shiftId: CLOSE_X3,
    scope: SCOPE_AX,
    closedAt: "2026-10-03T10:00:00Z",
    // 500.00 + 1000.00 − 25.00 + 50.00 − 20.00 = 1505.00; counted 1517.50 → +12.50
    amounts: { opening: 50_000, sales: 100_000, refunds: 2_500, payIn: 5_000, payOut: 2_000, counted: 151_750 },
    closeKind: "forced",
    forcedReason: "Cashier left without closing",
    // Same occurredAt: ordered by id (PAY_OUT's id sorts first).
    movements: [
      {
        movementId: MOVEMENT_X3_PAY_IN,
        kind: "pay_in",
        amount: "50.00",
        reasonCode: "float_top_up",
        note: null,
        occurredAt: "2026-10-03T06:00:00Z",
      },
      {
        movementId: MOVEMENT_X3_PAY_OUT,
        kind: "pay_out",
        amount: "20.00",
        reasonCode: "petty_expense",
        note: "Cleaning supplies",
        occurredAt: "2026-10-03T06:00:00Z",
      },
    ],
    refundRefs: [RETURN_X3],
  },
  {
    shiftId: CLOSE_X4,
    scope: SCOPE_AX,
    closedAt: "2026-10-03T10:00:00Z",
    amounts: plain(140_000),
    approverId: APPROVER_A,
  },
  {
    shiftId: CLOSE_Y5,
    scope: SCOPE_AY,
    closedAt: "2026-10-04T10:00:00.000001Z",
    currencyCode: "USD",
    amounts: plain(148_000),
  },
  { shiftId: CLOSE_Y6, scope: SCOPE_AY, closedAt: "2026-10-04T10:00:00.000002Z", amounts: plain(150_300) },
  { shiftId: CLOSE_DEL, scope: SCOPE_DEL, closedAt: "2026-10-05T10:00:00Z", amounts: plain(150_000) },
  {
    shiftId: CLOSE_B,
    scope: SCOPE_BX,
    closedAt: "2026-10-06T10:00:00Z",
    amounts: plain(149_900),
    closingUserId: CASHIER_B,
  },
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function seedUsersAndDevices(admin: Pool): Promise<void> {
  await admin.query(
    `INSERT INTO users (id, email) VALUES
       ($1, 'rt383-cashier-a@example.test'), ($2, 'rt383-approver-a@example.test'),
       ($3, 'rt383-cashier-b@example.test')`,
    [CASHIER_A, APPROVER_A, CASHIER_B],
  );
  await admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES
       ($1, $6, $7, decode(repeat('a1', 32), 'hex')),
       ($2, $6, $7, decode(repeat('a2', 32), 'hex')),
       ($3, $6, $8, decode(repeat('a3', 32), 'hex')),
       ($4, $6, $9, decode(repeat('a4', 32), 'hex')),
       ($5, $10, $11, decode(repeat('b1', 32), 'hex'))`,
    [DEVICE_AX, DEVICE_AX_OPEN, DEVICE_AY, DEVICE_DEL, DEVICE_BX, TENANT_A, STORE_A_X, STORE_A_Y, S_DELETED, TENANT_B, STORE_B_X],
  );
}

/** A cash-refunded EGP return on STORE_A_X, claimed by CLOSE_X3. */
async function seedRefundReturn(admin: Pool): Promise<void> {
  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 100, '2026-10-03T05:00:00Z', '2026-10-03', 'pos', 'rt383-sale', $4, $5)`,
    [SALE_X3, TENANT_A, STORE_A_X, "b".repeat(64), CASHIER_A],
  );
  await admin.query(
    `INSERT INTO sale_returns
       (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code, return_total,
        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4, 1, '2026-10-03', 'EGP', 25, 'pos', 'rt383-return', $5, $6)`,
    [RETURN_X3, SALE_X3, TENANT_A, STORE_A_X, "c".repeat(64), CASHIER_A],
  );
  await admin.query(
    `INSERT INTO sale_return_tenders (return_id, tenant_id, store_id, ordinal, method, amount)
     VALUES ($1, $2, $3, 0, 'cash', 25)`,
    [RETURN_X3, TENANT_A, STORE_A_X],
  );
}

async function seedMembers(admin: Pool): Promise<void> {
  await admin.query(
    `INSERT INTO users (id, email) VALUES
       ($1, 'rt383-manager@example.test'), ($2, 'rt383-staff@example.test'),
       ($3, 'rt383-admin-empty@example.test')`,
    [USER_MANAGER, USER_STAFF, USER_ADMIN_EMPTY],
  );
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $3, 'store_manager', 'Store Manager'), ($2, $3, 'store_staff', 'Store Staff')`,
    [ROLE_MANAGER, ROLE_STAFF, TENANT_A],
  );
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $3, $4, $5, 'specific'),
       ($2, $3, $6, $7, 'all')`,
    [MEM_MANAGER, MEM_STAFF, TENANT_A, USER_MANAGER, ROLE_MANAGER, USER_STAFF, ROLE_STAFF],
  );
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     SELECT $1, $2, $3, id, 'specific' FROM roles WHERE tenant_id = $2 AND code = 'tenant_admin'`,
    [MEM_ADMIN_EMPTY, TENANT_A, USER_ADMIN_EMPTY],
  );
  await admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES
       ($1, $3, $5), ($1, $4, $5), ($2, $6, $5)`,
    [MEM_MANAGER, MEM_ADMIN_EMPTY, STORE_A_X, STORE_A_Y, TENANT_A, S_DELETED],
  );
  await admin.query(
    `INSERT INTO sessions (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
     VALUES
       ($1, $2, $8, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($3, $2, $8, $9,   now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($4, $5, $8, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($6, $7, $8, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
    [
      SES_MANAGER, USER_MANAGER, SES_MANAGER_ACTIVE, SES_STAFF, USER_STAFF, SES_ADMIN_EMPTY, USER_ADMIN_EMPTY,
      TENANT_A, STORE_A_Y,
    ],
  );
  registerTestSession(SES_MANAGER, USER_MANAGER);
  registerTestSession(SES_MANAGER_ACTIVE, USER_MANAGER);
  registerTestSession(SES_STAFF, USER_STAFF);
  registerTestSession(SES_ADMIN_EMPTY, USER_ADMIN_EMPTY);
}

/** Shifts without a recorded close: an open cash-up shift and a legacy row. */
async function seedUnclosedShifts(env: PgTestEnv): Promise<void> {
  await openShift(env.app, {
    shiftId: OPEN_X,
    scope: SCOPE_AX_OPEN,
    openedAt: "2026-10-05T08:00:00Z",
    openingFloat: "500.00",
  });
  await env.admin.query(
    `INSERT INTO shifts
       (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
     VALUES ($1, $2, $3, $4, $5, '2026-10-04T08:00:00Z')`,
    [LEGACY_X, TENANT_A, STORE_A_X, CASHIER_A, DEVICE_AX_OPEN],
  );
}

/**
 * Seed the RT-192 read fixture, the members, and the closes. The read
 * fixture soft-deletes S_DELETED, so it is restored for the S_DELETED close's
 * open (the open reads the store's timezone) and deleted again after.
 */
export async function seedShiftCloseFixture(env: PgTestEnv): Promise<void> {
  await seedReadStoreScope(env);
  await seedUsersAndDevices(env.admin);
  await seedRefundReturn(env.admin);
  await seedMembers(env.admin);
  await env.admin.query(`UPDATE stores SET deleted_at = NULL WHERE id = $1`, [S_DELETED]);
  for (const close of CLOSES) await seedClose(env.app, close);
  await env.admin.query(`UPDATE stores SET deleted_at = now() WHERE id = $1`, [S_DELETED]);
  await seedUnclosedShifts(env);
}
