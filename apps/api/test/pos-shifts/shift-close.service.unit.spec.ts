/**
 * RT-17 slice 2b-2 — ShiftCashUpService.closeShift, Docker-free.
 *
 * The decision order (`pos-shifts.openapi.yaml` 1.1.0-draft, closeShift):
 * the shift in scope (404) → wire precision against its currency (400) → an
 * exact replay of the recorded close (200, before the envelope path's live
 * stated-user check, RT-17 10931 #4) → the stated closer (403) → a second,
 * different close (409) → the arithmetic (422) → the variance approver (400)
 * → the refund refs (422) → record (201). And the races the HTTP suites
 * cannot force: a ref claimed concurrently (RefundRefAlreadyClaimedError →
 * 422 refund_ref_invalid, the whole close rolled back) and a close that did
 * not apply (ShiftCloseNotAppliedError: the loser of a concurrent identical
 * close replays; anything else is not hidden).
 */
import "reflect-metadata";

import type { Pool } from "pg";

import type { CloseShiftFact } from "../../src/pos-shifts/shift-cash-up.dto";
import type { ShiftCashUpError } from "../../src/pos-shifts/shift-cash-up.errors";
import {
  RefundRefAlreadyClaimedError,
  ShiftCloseNotAppliedError,
  type CashUpShiftRow,
  type RefundRefRow,
  type ShiftCashUpRepository,
  type ShiftCloseFact,
  type ShiftCloseRow,
} from "../../src/pos-shifts/shift-cash-up.repository";
import { ShiftCashUpService, type ShiftWriteContext } from "../../src/pos-shifts/shift-cash-up.service";
import type { ShiftStoreUserReader } from "../../src/pos-shifts/shift-store-user";

const SCOPE = {
  tenantId: "0e170000-0000-4000-8000-0000000a0001",
  storeId: "0e170000-0000-4000-8000-0000000a5001",
  deviceId: "0e170000-0000-4000-8000-0000000e0001",
};
const CASHIER = "0e170000-0000-4000-8000-0000000c0001";
const SHIFT_ID = "0192f5a2-3b4c-7d8e-9f01-23456789ab01";
const RETURN_ID = "0e170000-0000-4000-8000-0000000aee01";
const DEVICE: ShiftWriteContext = { scope: SCOPE, actorUserId: CASHIER, path: "device" };
const ENVELOPE: ShiftWriteContext = { ...DEVICE, path: "envelope" };

const FACT: CloseShiftFact = {
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
  cashRefundReturnRefs: [RETURN_ID],
};

/** A pool whose client answers every statement with no rows (BEGIN / GUCs / COMMIT). */
const pool = {
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }),
} as unknown as Pool;

const shiftRow = (lifecycleState: CashUpShiftRow["lifecycleState"]): CashUpShiftRow => ({
  ...SCOPE,
  shiftId: SHIFT_ID,
  openingUserId: CASHIER,
  openedAt: new Date("2026-10-05T08:00:00Z"),
  lifecycleState,
  currencyCode: "EGP",
  openingFloat: "500.0000",
  businessDate: "2026-10-05",
  receivedAt: new Date("2026-10-05T08:00:02Z"),
  recordedByUserId: CASHIER,
  payloadHash: Buffer.alloc(32),
});

const closeRowOf = (fact: ShiftCloseFact): ShiftCloseRow => ({
  ...fact,
  shiftId: SHIFT_ID,
  closedAt: new Date(fact.closedAt),
  receivedAt: new Date("2026-10-05T16:00:03Z"),
});

const cashRef = (overrides: Partial<RefundRefRow> = {}): RefundRefRow => ({
  returnId: RETURN_ID,
  currencyCode: "EGP",
  hasCashRefund: true,
  claimedByShiftId: null,
  ...overrides,
});

/** What the repository double holds and does. */
interface RepoState {
  /** `findShift` answers in order (the last one repeats). */
  readonly shifts: Array<CashUpShiftRow | null>;
  readonly close?: ShiftCloseRow | null;
  readonly refs?: RefundRefRow[];
  readonly insertError?: Error;
}

/** The stated users the store-user double accepts. */
interface UserState {
  readonly storeUser?: boolean;
  readonly tenantUser?: boolean;
}

function harness(repoState: RepoState, users: UserState = {}) {
  const recorded: ShiftCloseFact[] = [];
  const finds = [...repoState.shifts];
  const repo = {
    findShift: jest.fn(async () => (finds.length > 1 ? finds.shift() : finds[0]) ?? null),
    findClose: jest.fn(async () => repoState.close ?? null),
    readRefundRefs: jest.fn(async () => repoState.refs ?? [cashRef()]),
    insertClose: jest.fn(async (_c: unknown, _s: unknown, fact: ShiftCloseFact) => {
      if (repoState.insertError) throw repoState.insertError;
      recorded.push(fact);
      return closeRowOf(fact);
    }),
  };
  const reader = {
    isStoreUser: jest.fn(async () => users.storeUser ?? true),
    isTenantUser: jest.fn(async () => users.tenantUser ?? true),
  };
  const service = new ShiftCashUpService(
    pool,
    repo as unknown as ShiftCashUpRepository,
    reader as unknown as ShiftStoreUserReader,
  );
  return { service, repo, reader, recorded };
}

/** A close attempt: on which path, with which overrides of FACT. */
interface Attempt {
  readonly ctx?: ShiftWriteContext;
  readonly fact?: Partial<CloseShiftFact>;
}

type Service = ReturnType<typeof harness>["service"];

/** The answer as one word: "created", "replay" or the refusal's contract code. */
function outcomeOf(service: Service, attempt: Attempt = {}): Promise<string> {
  return service.closeShift(attempt.ctx ?? DEVICE, SHIFT_ID, { ...FACT, ...attempt.fact }).then(
    (result) => (result.created ? "created" : "replay"),
    (err: ShiftCashUpError) => err.failure ?? String(err),
  );
}

/** The payload hash the service records for FACT. */
async function recordedHash(): Promise<Buffer> {
  const { service, recorded } = harness({ shifts: [shiftRow("open")] });
  await service.closeShift(DEVICE, SHIFT_ID, FACT);
  return recorded[0]!.payloadHash;
}

/** A recorded close of FACT's totals with `payloadHash`. */
const closeWithHash = (payloadHash: Buffer): ShiftCloseRow =>
  closeRowOf({ ...FACT, forcedReason: null, varianceApprovedByUserId: null, recordedByUserId: CASHIER, payloadHash });

/** Another close of this shift (another payload). */
const OTHER_CLOSE = closeWithHash(Buffer.alloc(32));

/** The close recorded for FACT, as the repository would return it. */
async function recordedClose(): Promise<ShiftCloseRow> {
  return closeWithHash(await recordedHash());
}

describe("closeShift — a first close", () => {
  it("records the fact verbatim with the verified actor and answers the closed Shift", async () => {
    const { service, recorded } = harness({ shifts: [shiftRow("open")] });
    const result = await service.closeShift(DEVICE, SHIFT_ID, FACT);
    expect([result.created, result.projection.status, result.projection.close?.variance]).toEqual([true, "closed", "-5.00"]);
    expect(recorded[0]).toMatchObject({ countedCash: "2750.00", forcedReason: null, recordedByUserId: CASHIER });
  });

  it("a forced close records its reason", async () => {
    const { service, recorded } = harness({ shifts: [shiftRow("open")] });
    const result = await service.closeShift(ENVELOPE, SHIFT_ID, { ...FACT, closeKind: "forced", forcedReason: "left" });
    expect([result.projection.close?.closeKind, recorded[0]?.forcedReason]).toEqual(["forced", "left"]);
  });

  it("the hash ignores amount and instant spelling", async () => {
    const base = await recordedHash();
    const { service, recorded } = harness({ shifts: [shiftRow("open")] });
    await service.closeShift(DEVICE, SHIFT_ID, { ...FACT, countedCash: "2750", variance: "-5", closedAt: "2026-10-05T18:00:00+02:00" });
    expect(recorded[0]!.payloadHash.equals(base)).toBe(true);
  });
});

describe("closeShift — refusals, in order", () => {
  it.each<[string, RepoState, Attempt, string]>([
    ["a shift out of scope", { shifts: [null] }, {}, "shift_not_found"],
    ["a precision breach", { shifts: [shiftRow("open")] }, { fact: { countedCash: "2750.001", variance: "-4.999" } }, "validation_error"],
    ["a second, different close", { shifts: [shiftRow("closed")], close: OTHER_CLOSE }, {}, "shift_payload_conflict"],
    ["an inconsistent cash-up", { shifts: [shiftRow("open")] }, { fact: { variance: "-5.01" } }, "shift_cashup_inconsistent"],
    ["an opening float other than the one recorded", { shifts: [shiftRow("open")] }, { fact: { openingFloat: "600.00", expectedCash: "2855.00", variance: "-105.00" } }, "shift_cashup_inconsistent"],
    ["an invalid refund ref", { shifts: [shiftRow("open")], refs: [] }, {}, "refund_ref_invalid"],
    ["a refund in another currency", { shifts: [shiftRow("open")], refs: [cashRef({ currencyCode: "USD" })] }, {}, "currency_mismatch"],
    ["a ref claimed concurrently", { shifts: [shiftRow("open")], insertError: new RefundRefAlreadyClaimedError() }, {}, "refund_ref_invalid"],
  ])("%s → %s", async (_label, state, attempt, answer) => {
    expect(await outcomeOf(harness(state).service, attempt)).toBe(answer);
  });

  it.each<[string, UserState, Attempt, string]>([
    ["an approver who is not a user of the tenant", { tenantUser: false }, { fact: { varianceApprovedByUserId: CASHIER } }, "validation_error"],
    ["an approver of the tenant", {}, { fact: { varianceApprovedByUserId: CASHIER } }, "created"],
    ["an envelope closer who is not a store user", { storeUser: false }, { ctx: ENVELOPE }, "refused"],
    ["a device-path closer (checked by the guard, not here)", { storeUser: false }, {}, "created"],
  ])("%s → %s", async (_label, users, attempt, answer) => {
    expect(await outcomeOf(harness({ shifts: [shiftRow("open")] }, users).service, attempt)).toBe(answer);
  });

  it("nothing but the arithmetic runs for an inconsistent close: no ref read, no insert", async () => {
    const { service, repo } = harness({ shifts: [shiftRow("open")] });
    await outcomeOf(service, { fact: { expectedCash: "1.00" } });
    expect([repo.readRefundRefs.mock.calls.length, repo.insertClose.mock.calls.length]).toEqual([0, 0]);
  });
});

describe("closeShift — replay (200), the envelope path's replay before the live check (RT-17 10931 #4)", () => {
  it.each<[string, ShiftWriteContext, boolean, string]>([
    ["device path", DEVICE, true, "replay"],
    ["envelope path, the closer's access since revoked", ENVELOPE, false, "replay"],
  ])("the same close again on the %s → %s", async (_label, ctx, storeUser, answer) => {
    const { service, reader } = harness({ shifts: [shiftRow("closed")], close: await recordedClose() }, { storeUser });
    expect(await outcomeOf(service, { ctx })).toBe(answer);
    expect(reader.isStoreUser).not.toHaveBeenCalled();
  });

  it("a different close on the envelope path still runs the live check first: 403", async () => {
    const { service } = harness({ shifts: [shiftRow("closed")], close: await recordedClose() }, { storeUser: false });
    expect(await outcomeOf(service, { ctx: ENVELOPE, fact: { saleCount: 38 } })).toBe("refused");
  });
});

describe("closeShift — a close that did not apply (ShiftCloseNotAppliedError)", () => {
  /** The shift was open under the lock, then closed with `close` by the time the loser re-reads. */
  const raced = (close: ShiftCloseRow): RepoState => ({
    shifts: [shiftRow("open"), shiftRow("closed")],
    close,
    insertError: new ShiftCloseNotAppliedError(),
  });

  it("the same close committed concurrently → a replay", async () => {
    expect(await outcomeOf(harness(raced(await recordedClose())).service)).toBe("replay");
  });

  it("another close committed concurrently → shift_payload_conflict", async () => {
    expect(await outcomeOf(harness(raced(OTHER_CLOSE)).service)).toBe("shift_payload_conflict");
  });

  it("a shift still open afterwards is not hidden: the error propagates (500)", async () => {
    const { service } = harness({ shifts: [shiftRow("open")], insertError: new ShiftCloseNotAppliedError() });
    await expect(service.closeShift(DEVICE, SHIFT_ID, FACT)).rejects.toBeInstanceOf(ShiftCloseNotAppliedError);
  });
});
