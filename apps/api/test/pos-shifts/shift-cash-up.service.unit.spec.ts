/**
 * RT-17 slice 2b — ShiftCashUpService and the controller helpers, Docker-free.
 *
 * Covers what the HTTP suites cannot reach deterministically: an identical
 * open committed by a concurrent request between the scoped read and the
 * insert (`shift_id_taken`, then the scoped re-read replays it), the payload
 * hash's independence from the claim and from amount / instant spelling, the
 * contract mapping of every refusal, and the 401 when the guard published no
 * full scope.
 */
import "reflect-metadata";

import { HttpException, UnauthorizedException } from "@nestjs/common";
import type { Pool } from "pg";

import type { TenantContextRequest } from "../../src/context/types";
import { shiftWriteContext } from "../../src/pos-shifts/shift-cash-up.controller";
import { ShiftCashUpError, toShiftHttpError, type ShiftCashUpFailure } from "../../src/pos-shifts/shift-cash-up.errors";
import type {
  CashUpShiftRow,
  InsertShiftOutcome,
  NewCashUpShift,
  ShiftCashUpRepository,
} from "../../src/pos-shifts/shift-cash-up.repository";
import { ShiftCashUpService, type ShiftWriteContext } from "../../src/pos-shifts/shift-cash-up.service";

const SCOPE = {
  tenantId: "0e170000-0000-4000-8000-0000000a0001",
  storeId: "0e170000-0000-4000-8000-0000000a5001",
  deviceId: "0e170000-0000-4000-8000-0000000e0001",
};
const CASHIER = "0e170000-0000-4000-8000-0000000c0001";
const CTX: ShiftWriteContext = { scope: SCOPE, actorUserId: CASHIER, path: "device" };
const FACT = {
  shiftId: "0192f5a2-3b4c-7d8e-9f01-23456789ab01",
  openedAt: "2026-10-05T08:00:00Z",
  openingUserId: CASHIER,
  currencyCode: "EGP",
  openingFloat: "500.00",
};

/** A pool whose client answers every statement with no rows (BEGIN / GUCs / COMMIT). */
const pool = {
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }),
} as unknown as Pool;

function shiftRow(payloadHash: Buffer): CashUpShiftRow {
  return {
    ...SCOPE,
    shiftId: FACT.shiftId,
    openingUserId: CASHIER,
    openedAt: new Date(FACT.openedAt),
    lifecycleState: "open",
    currencyCode: "EGP",
    openingFloat: "500.0000",
    businessDate: "2026-10-05",
    receivedAt: new Date("2026-10-05T08:00:02Z"),
    recordedByUserId: CASHIER,
    payloadHash,
  };
}

/** A repository double: `findShift` answers in order; `insertShift` answers `outcome`. */
function fakeRepo(finds: Array<CashUpShiftRow | null>, outcome: InsertShiftOutcome) {
  const inserted: NewCashUpShift[] = [];
  const repo = {
    findShift: jest.fn(async () => finds.shift() ?? null),
    insertShift: jest.fn(async (_c: unknown, _s: unknown, shift: NewCashUpShift) => {
      inserted.push(shift);
      return outcome;
    }),
  } as unknown as ShiftCashUpRepository;
  return { repo, inserted };
}

/** The payload hash the service records for `fact`. */
async function recordedHash(fact: typeof FACT): Promise<Buffer> {
  const { repo, inserted } = fakeRepo([null], { kind: "inserted", shift: shiftRow(Buffer.alloc(32)), adoptedLegacy: false });
  await new ShiftCashUpService(pool, repo).openShift(CTX, fact);
  return inserted[0]!.payloadHash;
}

describe("ShiftCashUpService.openShift — a concurrent identical open", () => {
  it("shift_id_taken, then the scoped re-read finds the same fact → a replay, not a conflict", async () => {
    const hash = await recordedHash(FACT);
    const { repo } = fakeRepo([null, shiftRow(hash)], { kind: "shift_id_taken" });
    const result = await new ShiftCashUpService(pool, repo).openShift(CTX, FACT);
    expect([result.created, result.projection.openingFloat]).toEqual([false, "500.00"]);
  });

  it("adoption of the legacy row is answered as a first open", async () => {
    const { repo } = fakeRepo([null], { kind: "inserted", shift: shiftRow(Buffer.alloc(32)), adoptedLegacy: true });
    expect((await new ShiftCashUpService(pool, repo).openShift(CTX, FACT)).created).toBe(true);
  });

  it("the hash ignores amount and instant spelling, and the actor", async () => {
    const base = await recordedHash(FACT);
    const respelled = await recordedHash({ ...FACT, openingFloat: "500", openedAt: "2026-10-05T08:00:00.000Z" });
    expect(respelled.equals(base)).toBe(true);
    expect((await recordedHash({ ...FACT, openingFloat: "500.01" })).equals(base)).toBe(false);
  });
});

describe("toShiftHttpError — every refusal maps to its contract status and code", () => {
  it.each([
    ["validation_error", 400],
    ["refused", 403],
    ["shift_not_found", 404],
    ["shift_payload_conflict", 409],
    ["shift_already_open", 409],
    ["shift_closed", 409],
  ])("%s → %i", (failure, status) => {
    const err = toShiftHttpError(new ShiftCashUpError(failure as ShiftCashUpFailure)) as HttpException;
    expect([err.getStatus(), (err.getResponse() as { code: string }).code]).toEqual([status, failure]);
  });

  it("any other error passes through unchanged", () => {
    const other = new Error("boom");
    expect(toShiftHttpError(other)).toBe(other);
  });
});

describe("shiftWriteContext — the scope, actor and path the guard published", () => {
  const published = {
    context: { userId: CASHIER, tenantId: SCOPE.tenantId, storeId: SCOPE.storeId, isPlatformAdmin: false, source: "token" },
    posDeviceId: SCOPE.deviceId,
  };

  it.each([
    ["a device-path body", { operatorUserId: CASHIER }, "device"],
    ["an envelope body", {}, "envelope"],
  ])("%s → the %s path", (_label, body, path) => {
    const ctx = shiftWriteContext(published as unknown as TenantContextRequest, body);
    expect(ctx).toEqual({ scope: SCOPE, actorUserId: CASHIER, path });
  });

  it.each([
    ["no context", { posDeviceId: SCOPE.deviceId }],
    ["no device", { context: published.context }],
    ["no actor", { ...published, context: { ...published.context, userId: null } }],
    ["no store", { ...published, context: { ...published.context, storeId: null } }],
  ])("%s → the generic 401", (_label, request) => {
    expect(() => shiftWriteContext(request as unknown as TenantContextRequest, {})).toThrow(UnauthorizedException);
  });
});
