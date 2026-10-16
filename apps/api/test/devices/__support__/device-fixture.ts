/**
 * RT-365 — fixture for the Console device registry spec.
 *
 * Builds on the RT-192 read-store-scope seed (tenants A/B; STORE_A_X granted
 * to the `specific` owner and tenant_admin; STORE_A_Y never granted to them;
 * the `all` owner) and adds:
 *
 *   Members (tenant A):
 *     SES_MANAGER         store_manager, `specific` STORE_A_X + STORE_A_Y
 *     SES_MANAGER_ACTIVE  the same manager with STORE_A_Y active (narrowed to Y)
 *     SES_STAFF           store_staff, `all` (not an allowed role → 404)
 *
 *   Devices (tenant A unless noted), with the exception-first order the
 *   `all` owner sees at seed time:
 *     rank 0  D_EXC      X  revoked (stolen) with SHIFT_EXC still open  exp 2027-01-05
 *     rank 1  D_SOON     X  active                                       exp 2026-11-01
 *     rank 1  D_LATE_Y   Y  active                                       exp 2027-01-01
 *     rank 1  D_NEW      X  active, paired by a code replacing D_OLD     exp 2027-01-02
 *     rank 1  R_PLAIN    X  active, no shift; operator tokens; codes     exp 2027-02-01
 *     rank 1  R_SEC      X  active, open cash-up shift SHIFT_SEC         exp 2027-02-02
 *     rank 1  R_REC      X  active, open cash-up shift SHIFT_REC         exp 2027-02-03
 *     rank 1  R_BLOCK    X  active, open LEGACY shift SHIFT_BLOCK        exp 2027-02-04
 *     rank 1  R_Y        Y  active, no shift                             exp 2027-02-05
 *     rank 2  D_OLD      X  revoked before RT-365 (no reason, no actor)  exp 2026-12-01
 *     rank 3  D_RETIRED  Y  revoked and retired                          exp 2026-10-20
 *     tenant B: D_B on STORE_B_X.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `0365`
 * mnemonic (hex only).
 */
import { createHash } from "node:crypto";

import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import type { DeviceScope } from "../../../src/pos-cashier-admissions/device-scope";
import { ShiftCashUpRepository } from "../../../src/pos-shifts/shift-cash-up.repository";
import type { PgTestEnv } from "../../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import {
  registerTestSession,
  SES_OWNER_ALL,
  seedReadStoreScope,
} from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

const id = (n: string): string => `0a000000-0000-7000-8000-00000365${n}`;

export const D_EXC = id("01a1");
export const D_SOON = id("01a2");
export const D_LATE_Y = id("01a3");
export const D_NEW = id("01a4");
export const D_OLD = id("01a5");
export const D_RETIRED = id("01a6");
export const R_PLAIN = id("02a1");
export const R_SEC = id("02a2");
export const R_REC = id("02a3");
export const R_BLOCK = id("02a4");
export const R_Y = id("02a5");
export const D_B = "0b000000-0000-7000-8000-0000036501b1";
export const NO_DEVICE = id("01ff");

export const SHIFT_EXC = id("03a1");
export const SHIFT_SEC = id("03a2");
export const SHIFT_REC = id("03a3");
export const SHIFT_BLOCK = id("03a4");
const MOVEMENT_SEC = id("03b2");

export const CASHIER_A = id("04c1");
const USER_MANAGER = id("04a1");
const USER_STAFF = id("04a2");
const ROLE_MANAGER = id("05a1");
const ROLE_STAFF = id("05a2");
const MEM_MANAGER = id("06a1");
const MEM_STAFF = id("06a2");

export const SES_MANAGER = id("07a1");
export const SES_MANAGER_ACTIVE = id("07a2");
export const SES_STAFF = id("07a3");
export { USER_MANAGER };

/** Pairing codes around R_PLAIN, D_OLD / D_NEW and an unrelated device. */
export const CODE_PLAIN_TERMINAL = id("08a1");
export const CODE_PLAIN_REPLACEMENT = id("08a2");
export const CODE_OTHER_PENDING = id("08a3");
const CODE_USED_REPLACE = id("08a4");

/** Operator tokens: the live and the expired one of R_PLAIN, a live one of R_SEC and of D_SOON. */
export const OP_TOKEN_PLAIN_LIVE = generateRawToken();
const OP_TOKEN_PLAIN_EXPIRED = generateRawToken();
export const OP_TOKEN_SEC_LIVE = generateRawToken();
export const OP_TOKEN_SOON_LIVE = generateRawToken();
export const OP_TOKEN_PLAIN_EXPIRED_HASH = hashToken(OP_TOKEN_PLAIN_EXPIRED);

/** Device bearer of R_PLAIN, to prove the till's own token stops at once. */
export const DEVICE_TOKEN_PLAIN = generateRawToken();

/** Tenant A order the `all` owner sees at seed time. */
export const TENANT_A_ORDER = [
  D_EXC,
  D_SOON,
  D_LATE_Y,
  D_NEW,
  R_PLAIN,
  R_SEC,
  R_REC,
  R_BLOCK,
  R_Y,
  D_OLD,
  D_RETIRED,
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const repo = new ShiftCashUpRepository();
const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

interface SeedDevice {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly expiresAt: string;
  readonly tokenHash?: Buffer;
}

const DEVICES: readonly SeedDevice[] = [
  { id: D_EXC, tenantId: TENANT_A, storeId: STORE_A_X, expiresAt: "2027-01-05T00:00:00Z" },
  { id: D_SOON, tenantId: TENANT_A, storeId: STORE_A_X, expiresAt: "2026-11-01T00:00:00Z" },
  { id: D_LATE_Y, tenantId: TENANT_A, storeId: STORE_A_Y, expiresAt: "2027-01-01T00:00:00Z" },
  { id: D_NEW, tenantId: TENANT_A, storeId: STORE_A_X, expiresAt: "2027-01-02T00:00:00Z" },
  {
    id: R_PLAIN,
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    expiresAt: "2027-02-01T00:00:00Z",
    tokenHash: hashToken(DEVICE_TOKEN_PLAIN),
  },
  { id: R_SEC, tenantId: TENANT_A, storeId: STORE_A_X, expiresAt: "2027-02-02T00:00:00Z" },
  { id: R_REC, tenantId: TENANT_A, storeId: STORE_A_X, expiresAt: "2027-02-03T00:00:00Z" },
  { id: R_BLOCK, tenantId: TENANT_A, storeId: STORE_A_X, expiresAt: "2027-02-04T00:00:00Z" },
  { id: R_Y, tenantId: TENANT_A, storeId: STORE_A_Y, expiresAt: "2027-02-05T00:00:00Z" },
  { id: D_OLD, tenantId: TENANT_A, storeId: STORE_A_X, expiresAt: "2026-12-01T00:00:00Z" },
  { id: D_RETIRED, tenantId: TENANT_A, storeId: STORE_A_Y, expiresAt: "2026-10-20T00:00:00Z" },
  { id: D_B, tenantId: TENANT_B, storeId: STORE_B_X, expiresAt: "2027-01-01T00:00:00Z" },
];

async function seedDevices(admin: Pool): Promise<void> {
  for (const [i, d] of DEVICES.entries()) {
    await admin.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [d.id, d.tenantId, d.storeId, `Till ${i + 1}`, d.tokenHash ?? digest(`device:${d.id}`), d.expiresAt],
    );
  }
}

async function seedMembers(admin: Pool): Promise<void> {
  await admin.query(
    `INSERT INTO users (id, email) VALUES
       ($1, 'rt365-manager@example.test'), ($2, 'rt365-staff@example.test'), ($3, 'rt365-cashier@example.test')`,
    [USER_MANAGER, USER_STAFF, CASHIER_A],
  );
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $3, 'store_manager', 'Store Manager'), ($2, $3, 'store_staff', 'Store Staff')`,
    [ROLE_MANAGER, ROLE_STAFF, TENANT_A],
  );
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $3, $4, $5, 'specific'), ($2, $3, $6, $7, 'all')`,
    [MEM_MANAGER, MEM_STAFF, TENANT_A, USER_MANAGER, ROLE_MANAGER, USER_STAFF, ROLE_STAFF],
  );
  await admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $4), ($1, $3, $4)`,
    [MEM_MANAGER, STORE_A_X, STORE_A_Y, TENANT_A],
  );
  await admin.query(
    `INSERT INTO sessions (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
     VALUES
       ($1, $2, $6, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($3, $2, $6, $7,   now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($4, $5, $6, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
    [SES_MANAGER, USER_MANAGER, SES_MANAGER_ACTIVE, SES_STAFF, USER_STAFF, TENANT_A, STORE_A_Y],
  );
  registerTestSession(SES_MANAGER, USER_MANAGER);
  registerTestSession(SES_MANAGER_ACTIVE, USER_MANAGER);
  registerTestSession(SES_STAFF, USER_STAFF);
}

async function openCashUpShift(app: Pool, shiftId: string, scope: DeviceScope): Promise<void> {
  const outcome = await runWithTenantContext(app, { tenantId: scope.tenantId, isPlatformAdmin: false }, (c) =>
    repo.insertShift(c, scope, {
      shiftId,
      openedAt: "2026-10-16T08:00:00Z",
      openingUserId: CASHIER_A,
      currencyCode: "EGP",
      openingFloat: "500.00",
      recordedByUserId: CASHIER_A,
      payloadHash: digest(`open:${shiftId}`),
    }),
  );
  if (outcome.kind !== "inserted") throw new Error(`open ${shiftId} failed: ${outcome.kind}`);
  if (shiftId === SHIFT_SEC) {
    await runWithTenantContext(app, { tenantId: scope.tenantId, isPlatformAdmin: false }, (c) =>
      repo.insertMovement(c, outcome.shift, {
        movementId: MOVEMENT_SEC,
        kind: "pay_in",
        amount: "50.00",
        reasonCode: "float_top_up",
        note: null,
        occurredAt: "2026-10-16T09:00:00Z",
        recordedByUserId: CASHIER_A,
        payloadHash: digest(`movement:${MOVEMENT_SEC}`),
      }),
    );
  }
}

async function seedShifts(env: PgTestEnv): Promise<void> {
  const scope = (deviceId: string): DeviceScope => ({ tenantId: TENANT_A, storeId: STORE_A_X, deviceId });
  await openCashUpShift(env.app, SHIFT_EXC, scope(D_EXC));
  await openCashUpShift(env.app, SHIFT_SEC, scope(R_SEC));
  await openCashUpShift(env.app, SHIFT_REC, scope(R_REC));
  await env.admin.query(
    `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
     VALUES ($1, $2, $3, $4, $5, '2026-10-15T08:00:00Z')`,
    [SHIFT_BLOCK, TENANT_A, STORE_A_X, CASHIER_A, R_BLOCK],
  );
}

async function insertOperatorToken(
  admin: Pool,
  raw: string,
  deviceId: string,
  expiresSql: "now() + interval '8 hours'" | "now() - interval '1 hour'",
): Promise<void> {
  await admin.query(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, device_id, store_id, scope, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pos_operator', ${expiresSql})`,
    [hashToken(raw), TENANT_A, CASHIER_A, deviceId, STORE_A_X],
  );
}

async function insertCode(
  admin: Pool,
  code: { id: string; terminalId: string; status: "pending" | "used"; replaces?: string; deviceId?: string },
): Promise<void> {
  await admin.query(
    `INSERT INTO pairing_codes
       (id, tenant_id, store_id, code_hash, terminal_id, terminal_label, branch_name, branch_address,
        tenant_tax_registration_id, printer_vendor_id, printer_product_id, status, expires_at,
        replaces_device_id, device_id, used_at)
     VALUES ($1, $2, $3, $4, $5, 'Till', 'Branch', 'Address', 'TAX-1', '0x04b8', '0x0202', $6,
             now() + interval '1 day', $7, $8, CASE WHEN $6 = 'used' THEN now() ELSE NULL END)`,
    [code.id, TENANT_A, STORE_A_X, digest(`code:${code.id}`), code.terminalId, code.status, code.replaces ?? null, code.deviceId ?? null],
  );
}

async function seedCredentials(admin: Pool): Promise<void> {
  await insertOperatorToken(admin, OP_TOKEN_PLAIN_LIVE, R_PLAIN, "now() + interval '8 hours'");
  await insertOperatorToken(admin, OP_TOKEN_PLAIN_EXPIRED, R_PLAIN, "now() - interval '1 hour'");
  await insertOperatorToken(admin, OP_TOKEN_SEC_LIVE, R_SEC, "now() + interval '8 hours'");
  await insertOperatorToken(admin, OP_TOKEN_SOON_LIVE, D_SOON, "now() + interval '8 hours'");
  await insertCode(admin, { id: CODE_PLAIN_TERMINAL, terminalId: R_PLAIN, status: "pending" });
  await insertCode(admin, { id: CODE_PLAIN_REPLACEMENT, terminalId: id("09a1"), status: "pending", replaces: R_PLAIN });
  await insertCode(admin, { id: CODE_OTHER_PENDING, terminalId: id("09a2"), status: "pending", replaces: D_SOON });
  await insertCode(admin, { id: CODE_USED_REPLACE, terminalId: D_NEW, status: "used", replaces: D_OLD, deviceId: D_NEW });
}

/** Revoked / retired states, set after the shifts so D_EXC's shift could open. */
async function seedLifecycle(admin: Pool, ownerUserId: string): Promise<void> {
  await admin.query(
    `UPDATE devices SET revoked_at = '2026-10-16T10:00:00Z', revoked_by = $2, revoke_reason = 'stolen',
            revoke_note = 'Till taken; drawer cash in the safe'
      WHERE id = $1`,
    [D_EXC, ownerUserId],
  );
  await admin.query(`UPDATE devices SET revoked_at = '2026-09-01T10:00:00Z' WHERE id = $1`, [D_OLD]);
  await admin.query(
    `UPDATE devices SET revoked_at = '2026-10-10T10:00:00Z', revoked_by = $2, revoke_reason = 'retired',
            retired_at = '2026-10-10T10:05:00Z', retired_by = $2, retire_reason = 'Decommissioned'
      WHERE id = $1`,
    [D_RETIRED, ownerUserId],
  );
}

/**
 * Seed the RT-192 read fixture, the members, the devices and their facts.
 * Returns the `users.id` of the RT-192 `all` owner (SES_OWNER_ALL).
 */
export async function seedDeviceFixture(env: PgTestEnv): Promise<string> {
  await seedReadStoreScope(env);
  const owner = await env.admin.query<{ user_id: string }>(`SELECT user_id FROM sessions WHERE id = $1`, [SES_OWNER_ALL]);
  const ownerUserId = owner.rows[0]!.user_id;
  await seedMembers(env.admin);
  await seedDevices(env.admin);
  await seedShifts(env);
  await seedCredentials(env.admin);
  await seedLifecycle(env.admin, ownerUserId);
  return ownerUserId;
}

/** A digest of every cash fact of tenant A: no revoke path may change one. */
export async function cashFactsDigest(admin: Pool): Promise<string> {
  const r = await admin.query<{ d: string }>(
    `SELECT md5(
       coalesce((SELECT string_agg(s::text, '|' ORDER BY s.shift_id) FROM shifts s), '') ||
       coalesce((SELECT string_agg(m::text, '|' ORDER BY m.id) FROM shift_cash_movements m), '') ||
       coalesce((SELECT string_agg(c::text, '|' ORDER BY c.shift_id) FROM shift_closes c), '') ||
       coalesce((SELECT string_agg(x::text, '|' ORDER BY x.id) FROM sales x), '')
     ) AS d`,
  );
  return r.rows[0]!.d;
}
