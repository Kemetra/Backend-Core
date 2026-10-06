/**
 * ShiftCashUpRepository — the pure helpers (RT-17 slice 2a). The SQL paths
 * are proven against real Postgres in shift-cash-up.repository.integration.spec.ts.
 */
import type { PoolClient } from "pg";

import {
  OPEN_DEVICE_INDEX,
  ShiftCashUpRepository,
  ShiftCloseNotAppliedError,
  isOpenDeviceConflict,
  type CashUpShiftRow,
  type ShiftCloseFact,
} from "../../src/pos-shifts/shift-cash-up.repository";

describe("isOpenDeviceConflict", () => {
  it("is true only for a 23505 on the one-open-per-device index", () => {
    expect(isOpenDeviceConflict({ code: "23505", constraint: OPEN_DEVICE_INDEX })).toBe(true);
    expect(OPEN_DEVICE_INDEX).toBe("uq_shifts_cash_up_open_device");
  });

  it.each<[string, unknown]>([
    ["another unique index", { code: "23505", constraint: "shifts_pkey" }],
    ["another SQLSTATE on the index", { code: "23514", constraint: OPEN_DEVICE_INDEX }],
    ["an error without a code", new Error("boom")],
    ["null", null],
    ["a string", "23505"],
    ["undefined", undefined],
  ])("is false for %s", (_label, err) => {
    expect(isOpenDeviceConflict(err)).toBe(false);
  });
});

describe("ShiftCashUpRepository.insertShift error path", () => {
  const scope = { tenantId: "t", storeId: "s", deviceId: "d" };
  const shift = {
    shiftId: "x",
    openedAt: "2026-10-05T08:00:00Z",
    openingUserId: "u",
    currencyCode: "EGP",
    openingFloat: "1",
    recordedByUserId: "u",
    payloadHash: Buffer.alloc(32),
  };

  function clientFailingInsertWith(err: unknown): { client: PoolClient; sql: string[] } {
    const sql: string[] = [];
    const query = jest.fn(async (text: string) => {
      sql.push(text.trim().split(/\s+/).slice(0, 4).join(" "));
      if (text.includes("INSERT INTO shifts")) throw err;
      return { rows: [], rowCount: 0 };
    });
    return { client: { query } as unknown as PoolClient, sql };
  }

  it("rolls back to the savepoint and reports device_has_open_shift", async () => {
    const { client, sql } = clientFailingInsertWith({ code: "23505", constraint: OPEN_DEVICE_INDEX });
    await expect(new ShiftCashUpRepository().insertShift(client, scope, shift)).resolves.toEqual({
      kind: "device_has_open_shift",
    });
    expect(sql).toEqual([
      "SAVEPOINT shift_cash_up_open",
      "INSERT INTO shifts (shift_id,",
      "ROLLBACK TO SAVEPOINT shift_cash_up_open",
    ]);
  });

  it("rolls back to the savepoint and rethrows any other error unchanged", async () => {
    const boom = new Error("connection reset");
    const { client, sql } = clientFailingInsertWith(boom);
    await expect(new ShiftCashUpRepository().insertShift(client, scope, shift)).rejects.toBe(boom);
    expect(sql).toContain("ROLLBACK TO SAVEPOINT shift_cash_up_open");
  });
});

describe("ShiftCashUpRepository.insertClose (review P3-4)", () => {
  const shift: CashUpShiftRow = {
    shiftId: "s",
    tenantId: "t",
    storeId: "st",
    deviceId: "d",
    openingUserId: "u",
    openedAt: new Date("2026-10-05T08:00:00Z"),
    lifecycleState: "open",
    currencyCode: "EGP",
    openingFloat: "500.0000",
    businessDate: "2026-10-05",
    receivedAt: new Date("2026-10-05T08:00:02Z"),
    recordedByUserId: "u",
    payloadHash: Buffer.alloc(32),
  };
  const close: ShiftCloseFact = {
    closedAt: "2026-10-05T16:00:00Z",
    closingUserId: "u",
    closeKind: "normal",
    forcedReason: null,
    openingFloat: "500.00",
    cashSalesTotal: "0.00",
    cashRefundsTotal: "0.00",
    payInTotal: "0.00",
    payOutTotal: "0.00",
    expectedCash: "500.00",
    countedCash: "500.00",
    variance: "0.00",
    saleCount: 0,
    cashRefundReturnRefs: [],
    varianceApprovedByUserId: null,
    recordedByUserId: "u",
    payloadHash: Buffer.alloc(32),
  };

  function clientWhoseCloseUpdateHits(rowCount: number): PoolClient {
    const query = jest.fn(async (text: string) => {
      if (text.includes("INSERT INTO shift_closes")) {
        return { rows: [{ shift_id: "s", closed_at: new Date(), sale_count: 0 }], rowCount: 1 };
      }
      if (text.includes("UPDATE shifts")) return { rows: [], rowCount };
      return { rows: [], rowCount: 0 };
    });
    return { query } as unknown as PoolClient;
  }

  it.each([0, 2])(
    "throws ShiftCloseNotAppliedError when the shift UPDATE hits %i rows, so the close rolls back",
    async (rowCount) => {
      await expect(
        new ShiftCashUpRepository().insertClose(clientWhoseCloseUpdateHits(rowCount), shift, close),
      ).rejects.toBeInstanceOf(ShiftCloseNotAppliedError);
    },
  );

  it("returns the close when exactly one shift row moves to closed", async () => {
    await expect(
      new ShiftCashUpRepository().insertClose(clientWhoseCloseUpdateHits(1), shift, close),
    ).resolves.toMatchObject({ shiftId: "s", cashRefundReturnRefs: [] });
  });
});
