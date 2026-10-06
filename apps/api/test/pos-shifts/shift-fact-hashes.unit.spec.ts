/**
 * RT-17 — the natural-key payload hashes are a stored contract with every
 * fact already recorded: a replay matches only if the hash is reproduced
 * byte for byte. These pins were taken from the slice 2b-1 / 2b-2 code
 * before UUID normalisation (PR #714 round 1), so lower-case ids keep their
 * exact hashes, and an upper-case spelling of the same ids is the same fact.
 */
import "reflect-metadata";

import type { Pool } from "pg";

import {
  CloseShiftRequestSchema,
  OpenShiftRequestSchema,
  RecordCashMovementRequestSchema,
} from "../../src/pos-shifts/shift-cash-up.dto";
import type {
  CashMovementRow,
  CashUpShiftRow,
  NewCashMovement,
  NewCashUpShift,
  ShiftCashUpRepository,
  ShiftCloseFact,
} from "../../src/pos-shifts/shift-cash-up.repository";
import { ShiftCashUpService, type ShiftWriteContext } from "../../src/pos-shifts/shift-cash-up.service";

const SCOPE = {
  tenantId: "0e170000-0000-4000-8000-0000000a0001",
  storeId: "0e170000-0000-4000-8000-0000000a5001",
  deviceId: "0e170000-0000-4000-8000-0000000e0001",
};
const CASHIER = "0e170000-0000-4000-8000-0000000c00ab";
const SHIFT_ID = "0192f5a2-3b4c-7d8e-9f01-23456789abcd";
const CTX: ShiftWriteContext = { scope: SCOPE, actorUserId: CASHIER, path: "device" };

const OPEN = {
  shiftId: SHIFT_ID,
  openedAt: "2026-10-05T08:00:00Z",
  openingUserId: CASHIER,
  currencyCode: "EGP",
  openingFloat: "500.00",
};
const MOVEMENT = {
  movementId: "0192f5a2-3b4c-7d8e-9f01-23456789abce",
  kind: "pay_out",
  amount: "120.00",
  reasonCode: "petty_expense",
  note: "Cleaning supplies",
  occurredAt: "2026-10-05T11:30:00Z",
};
const CLOSE = {
  closedAt: "2026-10-05T16:00:00Z",
  closingUserId: CASHIER,
  closeKind: "normal",
  openingFloat: "500.00",
  cashSalesTotal: "2450.00",
  cashRefundsTotal: "75.00",
  payInTotal: "0.00",
  payOutTotal: "120.00",
  expectedCash: "2755.00",
  countedCash: "2750.00",
  variance: "-5.00",
  saleCount: 37,
  cashRefundReturnRefs: ["0e170000-0000-4000-8000-0000000aeeff", "0e170000-0000-4000-8000-0000000aee0a"],
  varianceApprovedByUserId: "0e170000-0000-4000-8000-0000000c00cd",
};

/** Which fact a hash is of. */
type FactKind = "open" | "movement" | "close";

const pool = {
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }),
} as unknown as Pool;

const SHIFT: CashUpShiftRow = {
  ...SCOPE,
  shiftId: SHIFT_ID,
  openingUserId: CASHIER,
  openedAt: new Date(OPEN.openedAt),
  lifecycleState: "open",
  currencyCode: "EGP",
  openingFloat: "500.0000",
  businessDate: "2026-10-05",
  receivedAt: new Date("2026-10-05T08:00:02Z"),
  recordedByUserId: CASHIER,
  payloadHash: Buffer.alloc(32),
};

/** A repository double that records what the service hands it; the shift exists unless opening. */
function recordingRepo(kind: FactKind) {
  const hashes: Buffer[] = [];
  const repo = {
    findShift: async () => (kind === "open" ? null : SHIFT),
    findMovement: async () => null,
    findClose: async () => null,
    readRefundRefs: async (_c: unknown, _s: unknown, refs: string[]) =>
      refs.map((returnId) => ({ returnId, currencyCode: "EGP", hasCashRefund: true, claimedByShiftId: null })),
    insertShift: async (_c: unknown, _s: unknown, shift: NewCashUpShift) => {
      hashes.push(shift.payloadHash);
      return { kind: "inserted", shift: SHIFT, adoptedLegacy: false };
    },
    insertMovement: async (_c: unknown, _s: unknown, movement: NewCashMovement): Promise<CashMovementRow> => {
      hashes.push(movement.payloadHash);
      return { ...movement, shiftId: SHIFT_ID, currencyCode: "EGP", occurredAt: new Date(), receivedAt: new Date() };
    },
    insertClose: async (_c: unknown, _s: unknown, close: ShiftCloseFact) => {
      hashes.push(close.payloadHash);
      return { ...close, shiftId: SHIFT_ID, closedAt: new Date(close.closedAt), receivedAt: new Date() };
    },
  };
  const users = { isStoreUser: async () => true, isTenantUser: async () => true };
  const service = new ShiftCashUpService(pool, repo as unknown as ShiftCashUpRepository, users as never);
  return { service, hashes };
}

/** The hex payload hash the service records for a request body of `kind`. */
async function hashOf(kind: FactKind, body: Record<string, unknown>): Promise<string> {
  const { service, hashes } = recordingRepo(kind);
  if (kind === "open") await service.openShift(CTX, OpenShiftRequestSchema.parse(body));
  if (kind === "movement") await service.recordCashMovement(CTX, SHIFT_ID, RecordCashMovementRequestSchema.parse(body));
  if (kind === "close") await service.closeShift(CTX, SHIFT_ID, CloseShiftRequestSchema.parse(body));
  return hashes[0]!.toString("hex");
}

/** The body with the named id fields (or id arrays) upper-cased. */
function upperIds(body: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const upper = (v: unknown): unknown => (Array.isArray(v) ? v.map(upper) : String(v).toUpperCase());
  return { ...body, ...Object.fromEntries(fields.map((f) => [f, upper(body[f])])) };
}

const PINNED: Record<FactKind, string> = {
  open: "66c83d95e819de140a513536f934a90ec867181e20d72aefff19ca6eba1ef45b",
  movement: "e8585b15fdc0b0a7d7a967cce80af021edc822d80c70d07ee3f7297b9e36593f",
  close: "3f8330b36e2f1a87046b716eb507f5a1ef7629b4a01be7f22a352c4e4fd2ea64",
};

describe("payload hashes of lower-case facts are unchanged (pinned)", () => {
  it.each<[FactKind, Record<string, unknown>]>([
    ["open", OPEN],
    ["movement", MOVEMENT],
    ["close", CLOSE],
  ])("%s", async (kind, body) => {
    expect(await hashOf(kind, body)).toBe(PINNED[kind]);
  });
});

describe("an upper-case spelling of the ids is the same fact (PR #714 round 1)", () => {
  it.each<[FactKind, Record<string, unknown>, string[]]>([
    ["open", OPEN, ["shiftId", "openingUserId"]],
    ["movement", MOVEMENT, ["movementId"]],
    ["close", CLOSE, ["closingUserId", "cashRefundReturnRefs", "varianceApprovedByUserId"]],
  ])("%s", async (kind, body, ids) => {
    expect(await hashOf(kind, upperIds(body, ids))).toBe(PINNED[kind]);
  });
});
