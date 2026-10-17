/**
 * RT-367 — fixture for the Console pairing-code spec
 * (`pairing-codes.http.integration.spec.ts`).
 *
 * Builds on the RT-192 read-store-scope seed (tenants A/B; STORE_A_X granted
 * to the `specific` tenant_admin SES_ADMIN_SPEC; STORE_A_Y never granted to
 * it; the `all` owner SES_OWNER_ALL) and adds:
 *
 *   Members (tenant A):
 *     SES_MANAGER_X  store_manager, `specific` STORE_A_X
 *     SES_STAFF      store_staff, `all` (not an allowed role → 404)
 *
 *   Devices — one per (lifecycle state × replace / move). A replace code is
 *   issued for the device's own store (STORE_A_X), a move code for STORE_A_X
 *   from a device in STORE_A_Y:
 *     *_FREE   active, no shift          (RP_FREE also has a live operator
 *                                          token and a sibling pending
 *                                          replacement code)
 *     *_SHIFT  active, open legacy shift
 *     *_REV    revoked (admin_error), no shift
 *     *_EXC    revoked (stolen) with its shift still open (custody exception)
 *     *_RET    revoked and retired
 *   RP_DEAD   active, open cash-up shift (the RT-287 11493 broken till)
 *   RP_RACE   active, no shift (a shift opens after the code is issued)
 *   D_B2      tenant B
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `0367`
 * mnemonic (hex only).
 */
import { createHash } from "node:crypto";

import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { ShiftCashUpRepository } from "../../../src/pos-shifts/shift-cash-up.repository";
import type { PgTestEnv } from "../../_helpers/postgres-container";
import { seedConsoleMember } from "../../_helpers/console-members";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import { seedReadStoreScope } from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";

const id = (n: string): string => `0a000000-0000-7000-8000-00000367${n}`;

export type LifecycleState = "free" | "shift" | "rev" | "exc" | "ret";
export type Kind = "replace" | "move";

/** [kind, state] → device id. */
export const PARITY_DEVICES: Readonly<Record<Kind, Readonly<Record<LifecycleState, string>>>> = {
  replace: { free: id("01a1"), shift: id("01a2"), rev: id("01a3"), exc: id("01a4"), ret: id("01a5") },
  move: { free: id("02a1"), shift: id("02a2"), rev: id("02a3"), exc: id("02a4"), ret: id("02a5") },
};
export const RP_DEAD = id("01b1");
export const RP_RACE = id("01b2");
export const D_B2 = "0b000000-0000-7000-8000-0000036701b1";
export const NO_DEVICE = id("01ff");

export const SHIFT_DEAD = id("03b1");
export const SHIFT_RACE = id("03b2");
export const shiftOf = (kind: Kind, state: "shift" | "exc"): string =>
  id(`03${kind === "replace" ? "a" : "c"}${state === "shift" ? "1" : "2"}`);

export const CASHIER = id("04c1");
const USER_MANAGER = id("04a1");
const USER_STAFF = id("04a2");
export const SES_MANAGER_X = id("07a1");
export const SES_STAFF = id("07a3");

/** RP_FREE's live operator session and the sibling pending replacement code for it. */
export const OP_TOKEN_FREE = generateRawToken();
export const SIBLING_CODE = id("08a1");

/** The receipt / printer binding every issue sends. */
export const BINDING = {
  branchName: "Main Store",
  branchAddress: "1 Pilot St, Cairo",
  taxRegistrationId: "123-456-789",
  printerVendorId: "0x04B8",
  printerProductId: "0x0E15",
} as const;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
const repo = new ShiftCashUpRepository();

interface SeedDevice {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
}

function devices(): SeedDevice[] {
  const list: SeedDevice[] = [];
  for (const kind of ["replace", "move"] as const) {
    for (const deviceId of Object.values(PARITY_DEVICES[kind])) {
      list.push({ id: deviceId, tenantId: TENANT_A, storeId: kind === "replace" ? STORE_A_X : STORE_A_Y });
    }
  }
  list.push({ id: RP_DEAD, tenantId: TENANT_A, storeId: STORE_A_X });
  list.push({ id: RP_RACE, tenantId: TENANT_A, storeId: STORE_A_X });
  list.push({ id: D_B2, tenantId: TENANT_B, storeId: STORE_B_X });
  return list;
}

async function seedDevices(admin: Pool): Promise<void> {
  const all = devices();
  await admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::bytea[])`,
    [
      all.map((d) => d.id),
      all.map((d) => d.tenantId),
      all.map((d) => d.storeId),
      all.map((_d, i) => `Old till ${i + 1}`),
      all.map((d) => digest(`device:${d.id}`)),
    ],
  );
}

/** A legacy open shift on `deviceId` (admin insert: no device check). */
export async function openLegacyShift(admin: Pool, shiftId: string, deviceId: string, storeId: string): Promise<void> {
  await admin.query(
    `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '2 hours')`,
    [shiftId, TENANT_A, storeId, CASHIER, deviceId],
  );
}

async function seedShifts(env: PgTestEnv): Promise<void> {
  for (const kind of ["replace", "move"] as const) {
    const storeId = kind === "replace" ? STORE_A_X : STORE_A_Y;
    for (const state of ["shift", "exc"] as const) {
      await openLegacyShift(env.admin, shiftOf(kind, state), PARITY_DEVICES[kind][state], storeId);
    }
  }
  const outcome = await runWithTenantContext(env.app, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) =>
    repo.insertShift(
      c,
      { tenantId: TENANT_A, storeId: STORE_A_X, deviceId: RP_DEAD },
      {
        shiftId: SHIFT_DEAD,
        openedAt: "2026-10-17T08:00:00Z",
        openingUserId: CASHIER,
        currencyCode: "EGP",
        openingFloat: "500.00",
        recordedByUserId: CASHIER,
        payloadHash: digest(`open:${SHIFT_DEAD}`),
      },
    ),
  );
  if (outcome.kind !== "inserted") throw new Error(`open ${SHIFT_DEAD} failed: ${outcome.kind}`);
}

async function seedLifecycle(admin: Pool): Promise<void> {
  for (const kind of ["replace", "move"] as const) {
    const d = PARITY_DEVICES[kind];
    await admin.query(
      `UPDATE devices SET revoked_at = now() - interval '1 day', revoke_reason = 'admin_error' WHERE id = $1`,
      [d.rev],
    );
    await admin.query(
      `UPDATE devices SET revoked_at = now() - interval '1 hour', revoke_reason = 'stolen' WHERE id = $1`,
      [d.exc],
    );
    await admin.query(
      `UPDATE devices SET revoked_at = now() - interval '2 days', revoke_reason = 'retired',
              retired_at = now() - interval '2 days', retire_reason = 'Decommissioned'
        WHERE id = $1`,
      [d.ret],
    );
  }
}

async function seedCredentials(admin: Pool): Promise<void> {
  await admin.query(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, device_id, store_id, scope, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pos_operator', now() + interval '8 hours')`,
    [hashToken(OP_TOKEN_FREE), TENANT_A, CASHIER, PARITY_DEVICES.replace.free, STORE_A_X],
  );
  await admin.query(
    `INSERT INTO pairing_codes
       (id, tenant_id, store_id, code_hash, terminal_id, terminal_label, branch_name, branch_address,
        tenant_tax_registration_id, printer_vendor_id, printer_product_id, status, expires_at, replaces_device_id)
     VALUES ($1, $2, $3, $4, gen_random_uuid(), 'Sibling', 'Branch', 'Address', 'TAX-1', '0x04b8', '0x0202',
             'pending', now() + interval '1 day', $5)`,
    [SIBLING_CODE, TENANT_A, STORE_A_X, digest(`code:${SIBLING_CODE}`), PARITY_DEVICES.replace.free],
  );
}

async function seedMembers(admin: Pool): Promise<void> {
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt367-cashier@example.test')`, [CASHIER]);
  await seedConsoleMember(admin, {
    tenantId: TENANT_A,
    userId: USER_MANAGER,
    email: "rt367-manager@example.test",
    membershipId: id("06a1"),
    roleId: id("05a1"),
    roleCode: "store_manager",
    stores: [STORE_A_X],
    sessions: { [SES_MANAGER_X]: null },
  });
  await seedConsoleMember(admin, {
    tenantId: TENANT_A,
    userId: USER_STAFF,
    email: "rt367-staff@example.test",
    membershipId: id("06a2"),
    roleId: id("05a2"),
    roleCode: "store_staff",
    stores: "all",
    sessions: { [SES_STAFF]: null },
  });
}

export async function seedPairingCodeFixture(env: PgTestEnv): Promise<void> {
  await seedReadStoreScope(env);
  await seedMembers(env.admin);
  await seedDevices(env.admin);
  await seedShifts(env);
  await seedCredentials(env.admin);
  await seedLifecycle(env.admin);
}
