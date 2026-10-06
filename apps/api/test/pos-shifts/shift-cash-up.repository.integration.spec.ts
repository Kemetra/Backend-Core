/**
 * ShiftCashUpRepository — RT-17 slice 2a ([GATED] approval: Jira RT-17
 * comments 10760 + 10919 + 10920), against real Postgres with every
 * migration applied (0036 included), on the NOBYPASSRLS `app_test` role
 * inside `runWithTenantContext`, as the service will run it.
 *
 * Proves the persistence half of the slice-2 acceptance items:
 *   - Codex P2 (RT-17 comment 10925): a `shiftId` resolves only within the
 *     credential's tenant + store + device. Another device, store or tenant
 *     (and a legacy audit-ingest row) never resolves, and re-using its id for
 *     an open is `shift_id_taken`, never another device's row;
 *   - one open cash-up shift per device, with the transaction still usable
 *     after the refusal (savepoint);
 *   - movements and closes are scoped the same way; a movement on a closed
 *     shift is refused by the database backstop;
 *   - the close records its refund claims in request order, moves the shift
 *     to closed / closed_forced, and refuses (rolling everything back) a
 *     return another shift has already claimed;
 *   - refund refs resolve only within the tenant and store, with the
 *     currency, the cash-refund flag and the claiming shift;
 *   - the open's business date is the store-local day of `openedAt`.
 */
import { createHash, randomUUID } from "node:crypto";

import { runWithTenantContext } from "@data-pulse-2/db";
import type { PoolClient } from "pg";

import type { DeviceScope } from "../../src/pos-cashier-admissions/device-scope";
import {
  RefundRefAlreadyClaimedError,
  ShiftCashUpRepository,
  type CashUpShiftRow,
  type NewCashMovement,
  type NewCashUpShift,
  type ShiftCloseFact,
} from "../../src/pos-shifts/shift-cash-up.repository";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const TENANT_A = "0a000000-0000-7000-8000-0000017a0001";
const TENANT_B = "0b000000-0000-7000-8000-0000017b0001";
const STORE_A1 = "0a000000-0000-7000-8000-0000017a5001";
const STORE_A2 = "0a000000-0000-7000-8000-0000017a5002";
const STORE_B1 = "0b000000-0000-7000-8000-0000017b5001";
const USER_A = "0a000000-0000-7000-8000-0000017a7001";
const MANAGER_A = "0a000000-0000-7000-8000-0000017a7002";
const USER_B = "0b000000-0000-7000-8000-0000017b7001";
const DEVICE_A1 = "0a000000-0000-7000-8000-0000017ad001";
const DEVICE_A1_OTHER = "0a000000-0000-7000-8000-0000017ad002";
const DEVICE_A2 = "0a000000-0000-7000-8000-0000017ad003";
const DEVICE_B1 = "0b000000-0000-7000-8000-0000017bd001";
const SALE_A1 = "0a000000-0000-7000-8000-0000017a5a01";
const SALE_A2 = "0a000000-0000-7000-8000-0000017a5a02";
const SALE_B1 = "0b000000-0000-7000-8000-0000017b5a01";
/** Cash-refunded EGP return of store A1. */
const RET_CASH = "0a000000-0000-7000-8000-0000017aee01";
/** A second cash-refunded EGP return of store A1. */
const RET_CASH_2 = "0a000000-0000-7000-8000-0000017aee02";
/** Cash-refunded return of store A1 in USD. */
const RET_USD = "0a000000-0000-7000-8000-0000017aee03";
/** Return of store A1 with no refund tender. */
const RET_NO_TENDER = "0a000000-0000-7000-8000-0000017aee04";
/** Cash-refunded return of store A2 (same tenant). */
const RET_OTHER_STORE = "0a000000-0000-7000-8000-0000017aee05";
/** Cash-refunded return of tenant B. */
const RET_OTHER_TENANT = "0b000000-0000-7000-8000-0000017bee01";
const LEGACY_SHIFT = "0a000000-0000-7000-8000-0000017a1e91";

const SCOPE_A1: DeviceScope = { tenantId: TENANT_A, storeId: STORE_A1, deviceId: DEVICE_A1 };
const SCOPE_A1_OTHER: DeviceScope = { tenantId: TENANT_A, storeId: STORE_A1, deviceId: DEVICE_A1_OTHER };
const SCOPE_A2: DeviceScope = { tenantId: TENANT_A, storeId: STORE_A2, deviceId: DEVICE_A2 };
const SCOPE_B1: DeviceScope = { tenantId: TENANT_B, storeId: STORE_B1, deviceId: DEVICE_B1 };
/** A wrong-store scope for device A1 (never produced by the device guard). */
const SCOPE_A1_WRONG_STORE: DeviceScope = { tenantId: TENANT_A, storeId: STORE_A2, deviceId: DEVICE_A1 };

const repo = new ShiftCashUpRepository();

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const skip = (): boolean => env === null;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

function inTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return runWithTenantContext(pg().app, { tenantId, isPlatformAdmin: false }, work);
}

function newShift(overrides: Partial<NewCashUpShift> = {}): NewCashUpShift {
  const shiftId = overrides.shiftId ?? randomUUID();
  return {
    shiftId,
    openedAt: "2026-10-05T08:00:00Z",
    openingUserId: USER_A,
    currencyCode: "EGP",
    openingFloat: "500.00",
    recordedByUserId: USER_A,
    payloadHash: digest(`open:${shiftId}`),
    ...overrides,
  };
}

function newMovement(overrides: Partial<NewCashMovement> = {}): NewCashMovement {
  const movementId = overrides.movementId ?? randomUUID();
  return {
    movementId,
    kind: "pay_out",
    amount: "120.00",
    reasonCode: "petty_expense",
    note: "Cleaning supplies",
    occurredAt: "2026-10-05T11:30:00Z",
    recordedByUserId: USER_A,
    payloadHash: digest(`movement:${movementId}`),
    ...overrides,
  };
}

function closeFact(overrides: Partial<ShiftCloseFact> = {}): ShiftCloseFact {
  return {
    closedAt: "2026-10-05T16:00:00Z",
    closingUserId: USER_A,
    closeKind: "normal",
    forcedReason: null,
    openingFloat: "500.00",
    cashSalesTotal: "2450.00",
    cashRefundsTotal: "75.00",
    payInTotal: "0.00",
    payOutTotal: "120.00",
    expectedCash: "2755.00",
    countedCash: "2750.00",
    variance: "-5.00",
    saleCount: 37,
    cashRefundReturnRefs: [],
    varianceApprovedByUserId: MANAGER_A,
    recordedByUserId: USER_A,
    payloadHash: digest(`close:${randomUUID()}`),
    ...overrides,
  };
}

/** Opens a shift in `scope` and returns its row (fails the test otherwise). */
async function open(scope: DeviceScope, overrides: Partial<NewCashUpShift> = {}): Promise<CashUpShiftRow> {
  const outcome = await inTenant(scope.tenantId, (c) => repo.insertShift(c, scope, newShift(overrides)));
  if (outcome.kind !== "inserted") throw new Error(`open failed: ${outcome.kind}`);
  return outcome.shift;
}

async function seedSale(saleId: string, tenant: string, store: string, actor: string): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by, device_id)
     VALUES ($1, $2, $3, 'EGP', 100, '2026-10-05T09:00:00Z', '2026-10-05', 'pos', $6, $4, $5, NULL)`,
    [saleId, tenant, store, "b".repeat(64), actor, `sale-${saleId}`],
  );
}

async function seedReturn(
  returnId: string,
  saleId: string,
  seq: number,
  tenant: string,
  store: string,
  opts: { currency?: string; cashTender?: boolean } = {},
): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sale_returns
       (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code, return_total,
        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4, $5, '2026-10-05', $6, 25, 'pos', $9, $7, $8)`,
    [returnId, saleId, tenant, store, seq, opts.currency ?? "EGP", "c".repeat(64), USER_A, `return-${returnId}`],
  );
  if (opts.cashTender ?? true) {
    await pg().admin.query(
      `INSERT INTO sale_return_tenders (return_id, tenant_id, store_id, ordinal, method, amount)
       VALUES ($1, $2, $3, 0, 'cash', 25)`,
      [returnId, tenant, store],
    );
  }
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[shift-cash-up.repository] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  const admin = env.admin;
  await admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-17 A', 'rt17r-a'), ($2, 'RT-17 B', 'rt17r-b')`,
    [TENANT_A, TENANT_B],
  );
  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name, timezone) VALUES
       ($1, $4, 'a1', 'A1', 'Africa/Cairo'), ($2, $4, 'a2', 'A2', 'UTC'), ($3, $5, 'b1', 'B1', 'UTC')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await admin.query(
    `INSERT INTO users (id, email) VALUES
       ($1, 'a@rt17r.example'), ($2, 'm@rt17r.example'), ($3, 'b@rt17r.example')`,
    [USER_A, MANAGER_A, USER_B],
  );
  await admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES
       ($1, $5, $6, decode(repeat('a1', 32), 'hex')),
       ($2, $5, $6, decode(repeat('a2', 32), 'hex')),
       ($3, $5, $7, decode(repeat('a3', 32), 'hex')),
       ($4, $8, $9, decode(repeat('b1', 32), 'hex'))`,
    [DEVICE_A1, DEVICE_A1_OTHER, DEVICE_A2, DEVICE_B1, TENANT_A, STORE_A1, STORE_A2, TENANT_B, STORE_B1],
  );
  await seedSale(SALE_A1, TENANT_A, STORE_A1, USER_A);
  await seedSale(SALE_A2, TENANT_A, STORE_A2, USER_A);
  await seedSale(SALE_B1, TENANT_B, STORE_B1, USER_B);
  await seedReturn(RET_CASH, SALE_A1, 1, TENANT_A, STORE_A1);
  await seedReturn(RET_CASH_2, SALE_A1, 2, TENANT_A, STORE_A1);
  await seedReturn(RET_USD, SALE_A1, 3, TENANT_A, STORE_A1, { currency: "USD" });
  await seedReturn(RET_NO_TENDER, SALE_A1, 4, TENANT_A, STORE_A1, { cashTender: false });
  await seedReturn(RET_OTHER_STORE, SALE_A2, 1, TENANT_A, STORE_A2);
  await seedReturn(RET_OTHER_TENANT, SALE_B1, 1, TENANT_B, STORE_B1);
  // A legacy (audit-ingest) shift on device A1, still open.
  await admin.query(
    `INSERT INTO shifts
       (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
     VALUES ($1, $2, $3, $4, $5, '2026-10-04T08:00:00Z')`,
    [LEGACY_SHIFT, TENANT_A, STORE_A1, USER_A, DEVICE_A1],
  );
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (skip()) return;
  // The fact tables are append-only for every role, so the cleanup disables
  // their user triggers for the duration of the delete.
  await pg().admin.query(`
    BEGIN;
    ALTER TABLE shift_refund_claims DISABLE TRIGGER USER;
    ALTER TABLE shift_closes DISABLE TRIGGER USER;
    ALTER TABLE shift_cash_movements DISABLE TRIGGER USER;
    ALTER TABLE shifts DISABLE TRIGGER USER;
    DELETE FROM shift_refund_claims;
    DELETE FROM shift_closes;
    DELETE FROM shift_cash_movements;
    DELETE FROM shifts WHERE shift_id <> '${LEGACY_SHIFT}';
    ALTER TABLE shift_refund_claims ENABLE TRIGGER USER;
    ALTER TABLE shift_closes ENABLE TRIGGER USER;
    ALTER TABLE shift_cash_movements ENABLE TRIGGER USER;
    ALTER TABLE shifts ENABLE TRIGGER USER;
    COMMIT;
  `);
});

describe("insertShift / findShift", () => {
  it("records a cash-up open and reads it back in scope", async () => {
    if (skip()) return;
    const input = newShift();
    const shift = await open(SCOPE_A1, input);
    expect(shift).toMatchObject({
      shiftId: input.shiftId,
      tenantId: TENANT_A,
      storeId: STORE_A1,
      deviceId: DEVICE_A1,
      openingUserId: USER_A,
      lifecycleState: "open",
      currencyCode: "EGP",
      openingFloat: "500.0000",
      recordedByUserId: USER_A,
    });
    expect(shift.openedAt.toISOString()).toBe("2026-10-05T08:00:00.000Z");
    expect(shift.receivedAt).toBeInstanceOf(Date);
    expect(shift.payloadHash.equals(input.payloadHash)).toBe(true);

    const read = await inTenant(TENANT_A, (c) => repo.findShift(c, SCOPE_A1, input.shiftId));
    expect(read).toEqual(shift);
    const locked = await inTenant(TENANT_A, (c) =>
      repo.findShift(c, SCOPE_A1, input.shiftId, { forUpdate: true }),
    );
    expect(locked).toEqual(shift);
  });

  it("records the store-local business day of openedAt", async () => {
    if (skip()) return;
    // 22:30 UTC on 5 Oct is 01:30 on 6 Oct in Cairo (UTC+3, Egyptian DST).
    const late = await open(SCOPE_A1, { openedAt: "2026-10-05T22:30:00Z" });
    expect(late.businessDate).toBe("2026-10-06");
    const utc = await open(SCOPE_A2, { openedAt: "2026-10-05T22:30:00Z" });
    expect(utc.businessDate).toBe("2026-10-05");
  });

  it("Codex P2: a shiftId resolves only within the credential's tenant + store + device", async () => {
    if (skip()) return;
    const shift = await open(SCOPE_A1);
    await inTenant(TENANT_A, async (c) => {
      expect(await repo.findShift(c, SCOPE_A1_OTHER, shift.shiftId)).toBeNull();
      expect(await repo.findShift(c, SCOPE_A2, shift.shiftId)).toBeNull();
      expect(await repo.findShift(c, SCOPE_A1_WRONG_STORE, shift.shiftId)).toBeNull();
    });
    // Tenant B with A's exact scope ids still sees nothing (RLS).
    await inTenant(TENANT_B, async (c) => {
      expect(await repo.findShift(c, SCOPE_A1, shift.shiftId)).toBeNull();
      expect(await repo.findShift(c, SCOPE_B1, shift.shiftId)).toBeNull();
    });
  });

  it("Codex P2: re-using another device's, store's or tenant's shiftId is shift_id_taken, never its row", async () => {
    if (skip()) return;
    const shift = await open(SCOPE_A1);
    for (const scope of [SCOPE_A1_OTHER, SCOPE_A2, SCOPE_B1]) {
      const outcome = await inTenant(scope.tenantId, (c) =>
        repo.insertShift(c, scope, newShift({ shiftId: shift.shiftId })),
      );
      expect(outcome).toEqual({ kind: "shift_id_taken" });
    }
  });

  it("re-using the same shiftId in scope is shift_id_taken (the caller resolves replay first)", async () => {
    if (skip()) return;
    const shift = await open(SCOPE_A1);
    await closeNormally(shift);
    const outcome = await inTenant(TENANT_A, (c) =>
      repo.insertShift(c, SCOPE_A1, newShift({ shiftId: shift.shiftId })),
    );
    expect(outcome).toEqual({ kind: "shift_id_taken" });
  });

  it("a legacy audit-ingest shift never resolves as a cash-up shift, and its id is taken", async () => {
    if (skip()) return;
    await inTenant(TENANT_A, async (c) => {
      expect(await repo.findShift(c, SCOPE_A1, LEGACY_SHIFT)).toBeNull();
      expect(await repo.insertShift(c, SCOPE_A1, newShift({ shiftId: LEGACY_SHIFT }))).toEqual({
        kind: "shift_id_taken",
      });
    });
  });

  it("refuses a second open shift on the device and keeps the transaction usable", async () => {
    if (skip()) return;
    const first = await open(SCOPE_A1);
    await inTenant(TENANT_A, async (c) => {
      expect(await repo.insertShift(c, SCOPE_A1, newShift())).toEqual({ kind: "device_has_open_shift" });
      // The refusal rolled back to a savepoint: the transaction still works.
      expect((await repo.findShift(c, SCOPE_A1, first.shiftId))?.shiftId).toBe(first.shiftId);
    });
    // Other devices are not affected.
    await open(SCOPE_A1_OTHER);
  });

  it("rethrows any other database error", async () => {
    if (skip()) return;
    // A store that is not the device's tenant's: no business day resolves, so
    // the cash-up CHECK fails. The guard never produces such a scope.
    await expect(
      inTenant(TENANT_A, (c) =>
        repo.insertShift(c, { ...SCOPE_A1, storeId: STORE_B1 }, newShift()),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("findOpenShiftOnDevice", () => {
  it("returns the device's open cash-up shift only", async () => {
    if (skip()) return;
    await inTenant(TENANT_A, async (c) => {
      // Only the legacy row is open on A1: it does not count.
      expect(await repo.findOpenShiftOnDevice(c, SCOPE_A1)).toBeNull();
    });
    const shift = await open(SCOPE_A1);
    await inTenant(TENANT_A, async (c) => {
      expect((await repo.findOpenShiftOnDevice(c, SCOPE_A1))?.shiftId).toBe(shift.shiftId);
      expect(await repo.findOpenShiftOnDevice(c, SCOPE_A1_OTHER)).toBeNull();
      expect(await repo.findOpenShiftOnDevice(c, SCOPE_A1_WRONG_STORE)).toBeNull();
    });
    await inTenant(TENANT_B, async (c) => {
      expect(await repo.findOpenShiftOnDevice(c, SCOPE_A1)).toBeNull();
    });
    await closeNormally(shift);
    await inTenant(TENANT_A, async (c) => {
      expect(await repo.findOpenShiftOnDevice(c, SCOPE_A1)).toBeNull();
    });
  });
});

describe("insertMovement / findMovement", () => {
  it("records a movement in the shift's currency and reads it back in scope", async () => {
    if (skip()) return;
    const shift = await open(SCOPE_A1);
    const input = newMovement();
    const row = await inTenant(TENANT_A, (c) => repo.insertMovement(c, shift, input));
    expect(row).toMatchObject({
      movementId: input.movementId,
      shiftId: shift.shiftId,
      kind: "pay_out",
      amount: "120.0000",
      currencyCode: "EGP",
      reasonCode: "petty_expense",
      note: "Cleaning supplies",
      recordedByUserId: USER_A,
    });
    expect(row?.occurredAt.toISOString()).toBe("2026-10-05T11:30:00.000Z");
    expect(row?.payloadHash.equals(input.payloadHash)).toBe(true);
    const read = await inTenant(TENANT_A, (c) => repo.findMovement(c, SCOPE_A1, input.movementId));
    expect(read).toEqual(row);

    const noNote = await inTenant(TENANT_A, (c) =>
      repo.insertMovement(c, shift, newMovement({ kind: "pay_in", reasonCode: "float_top_up", note: null })),
    );
    expect(noNote).toMatchObject({ kind: "pay_in", note: null });
  });

  it("a movementId resolves only within the tenant + store + device", async () => {
    if (skip()) return;
    const shift = await open(SCOPE_A1);
    const input = newMovement();
    await inTenant(TENANT_A, (c) => repo.insertMovement(c, shift, input));
    await inTenant(TENANT_A, async (c) => {
      expect(await repo.findMovement(c, SCOPE_A1_OTHER, input.movementId)).toBeNull();
      expect(await repo.findMovement(c, SCOPE_A2, input.movementId)).toBeNull();
      expect(await repo.findMovement(c, SCOPE_A1_WRONG_STORE, input.movementId)).toBeNull();
    });
    await inTenant(TENANT_B, async (c) => {
      expect(await repo.findMovement(c, SCOPE_A1, input.movementId)).toBeNull();
    });
  });

  it("returns null when the movementId is already recorded, in or out of scope", async () => {
    if (skip()) return;
    const shift = await open(SCOPE_A1);
    const other = await open(SCOPE_B1, { openingUserId: USER_B, recordedByUserId: USER_B });
    const input = newMovement();
    await inTenant(TENANT_A, (c) => repo.insertMovement(c, shift, input));
    expect(await inTenant(TENANT_A, (c) => repo.insertMovement(c, shift, input))).toBeNull();
    expect(
      await inTenant(TENANT_B, (c) =>
        repo.insertMovement(c, other, { ...input, recordedByUserId: USER_B }),
      ),
    ).toBeNull();
  });

  it("the database refuses a movement on a closed shift (55000 backstop)", async () => {
    if (skip()) return;
    const shift = await open(SCOPE_A1);
    await closeNormally(shift);
    await expect(
      inTenant(TENANT_A, (c) => repo.insertMovement(c, shift, newMovement())),
    ).rejects.toMatchObject({ code: "55000" });
  });
});

describe("readRefundRefs", () => {
  it("resolves refs of the tenant and store with currency, cash flag and claimer", async () => {
    if (skip()) return;
    const shift = await open(SCOPE_A1);
    await inTenant(TENANT_A, (c) =>
      repo.insertClose(c, shift, closeFact({ cashRefundReturnRefs: [RET_CASH_2] })),
    );
    const rows = await inTenant(TENANT_A, (c) =>
      repo.readRefundRefs(c, SCOPE_A1, [
        RET_CASH,
        RET_CASH_2,
        RET_USD,
        RET_NO_TENDER,
        RET_OTHER_STORE,
        RET_OTHER_TENANT,
        randomUUID(),
      ]),
    );
    const byId = new Map(rows.map((r) => [r.returnId, r]));
    expect(rows).toHaveLength(4);
    expect(byId.get(RET_CASH)).toEqual({
      returnId: RET_CASH,
      currencyCode: "EGP",
      hasCashRefund: true,
      claimedByShiftId: null,
    });
    expect(byId.get(RET_CASH_2)?.claimedByShiftId).toBe(shift.shiftId);
    expect(byId.get(RET_USD)).toMatchObject({ currencyCode: "USD", hasCashRefund: true });
    expect(byId.get(RET_NO_TENDER)).toMatchObject({ hasCashRefund: false });
  });

  it("returns nothing for an empty list", async () => {
    if (skip()) return;
    expect(await inTenant(TENANT_A, (c) => repo.readRefundRefs(c, SCOPE_A1, []))).toEqual([]);
  });

  it("sees no ref of another tenant even with its ids (RLS)", async () => {
    if (skip()) return;
    const rows = await inTenant(TENANT_B, (c) =>
      repo.readRefundRefs(c, { tenantId: TENANT_B, storeId: STORE_A1 }, [RET_CASH]),
    );
    expect(rows).toEqual([]);
  });
});

describe("insertClose / findClose", () => {
  it("records the close, its claims in request order, and closes the shift", async () => {
    if (skip()) return;
    const shift = await open(SCOPE_A1);
    const fact = closeFact({ cashRefundReturnRefs: [RET_CASH_2, RET_CASH] });
    const row = await inTenant(TENANT_A, (c) => repo.insertClose(c, shift, fact));
    expect(row).toMatchObject({
      shiftId: shift.shiftId,
      closingUserId: USER_A,
      closeKind: "normal",
      forcedReason: null,
      openingFloat: "500.0000",
      cashSalesTotal: "2450.0000",
      cashRefundsTotal: "75.0000",
      payInTotal: "0.0000",
      payOutTotal: "120.0000",
      expectedCash: "2755.0000",
      countedCash: "2750.0000",
      variance: "-5.0000",
      saleCount: 37,
      cashRefundReturnRefs: [RET_CASH_2, RET_CASH],
      varianceApprovedByUserId: MANAGER_A,
      recordedByUserId: USER_A,
    });
    expect(row.closedAt.toISOString()).toBe("2026-10-05T16:00:00.000Z");
    expect(row.payloadHash.equals(fact.payloadHash)).toBe(true);

    const read = await inTenant(TENANT_A, (c) => repo.findClose(c, shift));
    expect(read).toEqual(row);
    const after = await inTenant(TENANT_A, (c) => repo.findShift(c, SCOPE_A1, shift.shiftId));
    expect(after?.lifecycleState).toBe("closed");
  });

  it("records a forced close as closed_forced, with no variance approver", async () => {
    if (skip()) return;
    const shift = await open(SCOPE_A1);
    const row = await inTenant(TENANT_A, (c) =>
      repo.insertClose(
        c,
        shift,
        closeFact({
          closeKind: "forced",
          forcedReason: "Cashier left",
          closingUserId: MANAGER_A,
          recordedByUserId: MANAGER_A,
          varianceApprovedByUserId: null,
        }),
      ),
    );
    expect(row).toMatchObject({ closeKind: "forced", forcedReason: "Cashier left", varianceApprovedByUserId: null });
    const after = await inTenant(TENANT_A, (c) => repo.findShift(c, SCOPE_A1, shift.shiftId));
    expect(after?.lifecycleState).toBe("closed_forced");
  });

  it("findClose is null for an open shift and for another tenant", async () => {
    if (skip()) return;
    const shift = await open(SCOPE_A1);
    expect(await inTenant(TENANT_A, (c) => repo.findClose(c, shift))).toBeNull();
    await closeNormally(shift);
    expect(await inTenant(TENANT_B, (c) => repo.findClose(c, shift))).toBeNull();
  });

  it("refuses a return another shift already claimed and records nothing", async () => {
    if (skip()) return;
    const first = await open(SCOPE_A1);
    await inTenant(TENANT_A, (c) =>
      repo.insertClose(c, first, closeFact({ cashRefundReturnRefs: [RET_CASH] })),
    );
    const second = await open(SCOPE_A1);
    await expect(
      inTenant(TENANT_A, (c) =>
        repo.insertClose(c, second, closeFact({ cashRefundReturnRefs: [RET_CASH_2, RET_CASH] })),
      ),
    ).rejects.toBeInstanceOf(RefundRefAlreadyClaimedError);
    await inTenant(TENANT_A, async (c) => {
      expect((await repo.findShift(c, SCOPE_A1, second.shiftId))?.lifecycleState).toBe("open");
      expect(await repo.findClose(c, second)).toBeNull();
      const refs = await repo.readRefundRefs(c, SCOPE_A1, [RET_CASH_2]);
      expect(refs[0]?.claimedByShiftId).toBeNull();
    });
  });
});

async function closeNormally(shift: CashUpShiftRow): Promise<void> {
  await inTenant(shift.tenantId, (c) => repo.insertClose(c, shift, closeFact()));
}

// ---------------------------------------------------------------------------
// Round-1 review fixes (PR #712)
// ---------------------------------------------------------------------------

/** A legacy (audit-ingest `shift.open`) row to adopt. */
interface LegacyRow {
  scope: DeviceScope;
  openedAt?: string;
  openingUserId?: string;
  state?: "open" | "closed";
}

async function insertLegacy(legacy: LegacyRow): Promise<string> {
  const id = randomUUID();
  await pg().admin.query(
    `INSERT INTO shifts
       (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at,
        lifecycle_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      legacy.scope.tenantId,
      legacy.scope.storeId,
      legacy.openingUserId ?? USER_A,
      legacy.scope.deviceId,
      legacy.openedAt ?? "2026-10-05T08:00:00Z",
      legacy.state ?? "open",
    ],
  );
  return id;
}

async function sourceOf(shiftId: string): Promise<string | undefined> {
  const r = await pg().admin.query<{ source: string }>(
    `SELECT source FROM shifts WHERE shift_id = $1`,
    [shiftId],
  );
  return r.rows[0]?.source;
}

describe("insertShift adopts an open legacy row of the same scope (review P2-1, option b)", () => {
  it("adopts it: same id, now a cash-up shift with the open fact's columns", async () => {
    if (skip()) return;
    const id = await insertLegacy({ scope: SCOPE_A1, openedAt: "2026-10-05T22:30:00Z" });
    const input = newShift({ shiftId: id, openedAt: "2026-10-05T22:30:00Z" });
    const outcome = await inTenant(TENANT_A, (c) => repo.insertShift(c, SCOPE_A1, input));
    expect(outcome).toMatchObject({ kind: "inserted", adoptedLegacy: true });
    const shift = await inTenant(TENANT_A, (c) => repo.findShift(c, SCOPE_A1, id));
    expect(shift).toMatchObject({
      shiftId: id,
      deviceId: DEVICE_A1,
      openingUserId: USER_A,
      lifecycleState: "open",
      currencyCode: "EGP",
      openingFloat: "500.0000",
      // Store-local day in Cairo, as for a fresh open.
      businessDate: "2026-10-06",
      recordedByUserId: USER_A,
    });
    expect(shift?.payloadHash.equals(input.payloadHash)).toBe(true);
  });

  it("a fresh open reports adoptedLegacy: false", async () => {
    if (skip()) return;
    const outcome = await inTenant(TENANT_A, (c) => repo.insertShift(c, SCOPE_A1, newShift()));
    expect(outcome).toMatchObject({ kind: "inserted", adoptedLegacy: false });
  });

  it.each<[string, DeviceScope]>([
    ["another device", SCOPE_A1_OTHER],
    ["another store", SCOPE_A2],
    ["another tenant", SCOPE_B1],
  ])("never adopts a legacy row of %s: shift_id_taken, row untouched", async (_label, scope) => {
    if (skip()) return;
    const id = await insertLegacy({ scope: SCOPE_A1 });
    const outcome = await inTenant(scope.tenantId, (c) =>
      repo.insertShift(c, scope, newShift({ shiftId: id })),
    );
    expect(outcome).toEqual({ kind: "shift_id_taken" });
    expect(await sourceOf(id)).toBe("legacy");
  });

  it.each<[string, Partial<LegacyRow>]>([
    ["a closed legacy row", { state: "closed" }],
    ["another opened_at", { openedAt: "2026-10-05T08:00:01Z" }],
    ["another opening user", { openingUserId: MANAGER_A }],
  ])("never adopts %s", async (_label, legacy) => {
    if (skip()) return;
    const id = await insertLegacy({ scope: SCOPE_A1, ...legacy });
    const outcome = await inTenant(TENANT_A, (c) =>
      repo.insertShift(c, SCOPE_A1, newShift({ shiftId: id })),
    );
    expect(outcome).toEqual({ kind: "shift_id_taken" });
    expect(await sourceOf(id)).toBe("legacy");
  });

  it("an already cash-up id stays unchanged (shift_id_taken)", async () => {
    if (skip()) return;
    const shift = await open(SCOPE_A1);
    const outcome = await inTenant(TENANT_A, (c) =>
      repo.insertShift(c, SCOPE_A1, newShift({ shiftId: shift.shiftId, openingFloat: "1.00" })),
    );
    expect(outcome).toEqual({ kind: "shift_id_taken" });
    const after = await inTenant(TENANT_A, (c) => repo.findShift(c, SCOPE_A1, shift.shiftId));
    expect(after).toEqual(shift);
  });

  it("adoption respects one open shift per device", async () => {
    if (skip()) return;
    await open(SCOPE_A1);
    const id = await insertLegacy({ scope: SCOPE_A1 });
    const outcome = await inTenant(TENANT_A, (c) =>
      repo.insertShift(c, SCOPE_A1, newShift({ shiftId: id })),
    );
    expect(outcome).toEqual({ kind: "device_has_open_shift" });
    expect(await sourceOf(id)).toBe("legacy");
  });
});

describe("insertClose under a concurrent close claiming the same return (review P3-10)", () => {
  it("the second close waits, then throws RefundRefAlreadyClaimedError and records nothing", async () => {
    if (skip()) return;
    const first = await open(SCOPE_A1);
    const second = await open(SCOPE_A1_OTHER);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed: () => void = () => undefined;
    const firstClaimed = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const firstClose = inTenant(TENANT_A, async (c) => {
      await repo.insertClose(c, first, closeFact({ cashRefundReturnRefs: [RET_CASH] }));
      claimed();
      await gate;
    });
    await firstClaimed;
    const secondClose = inTenant(TENANT_A, (c) =>
      repo.insertClose(c, second, closeFact({ cashRefundReturnRefs: [RET_CASH] })),
    );
    secondClose.catch(() => undefined);
    await waitForLockWaiter();
    release();
    await firstClose;
    await expect(secondClose).rejects.toBeInstanceOf(RefundRefAlreadyClaimedError);
    await inTenant(TENANT_A, async (c) => {
      expect(await repo.findClose(c, second)).toBeNull();
      expect((await repo.findShift(c, SCOPE_A1_OTHER, second.shiftId))?.lifecycleState).toBe("open");
    });
  });
});

/** Polls until at least one backend waits on a lock (a two-connection barrier). */
async function waitForLockWaiter(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pg().admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`,
    );
    if ((r.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no backend started waiting on a lock");
}
