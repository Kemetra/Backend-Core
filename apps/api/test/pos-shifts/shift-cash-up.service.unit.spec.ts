/**
 * RT-17 slice 2b — ShiftCashUpService and the controller helpers, Docker-free.
 *
 * Covers what the HTTP suites cannot reach deterministically: an identical
 * open committed by a concurrent request between the scoped read and the
 * insert — whether the loser trips the shift_id key (`shift_id_taken`) or
 * the one-open-shift-per-device index (`device_has_open_shift`, PR #713
 * review #1), the scoped re-read replays it — the payload hash's
 * independence from the claim and from amount / instant spelling and offset,
 * the contract mapping of every refusal, the auth path taken from the
 * guard's principal (review #3), and the 401 when the guard published no
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
import type { ShiftStoreUserReader } from "../../src/pos-shifts/shift-store-user";

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

/** What the scoped re-read after a refused insert finds. */
type ReRead = "same fact" | "other payload" | "nothing";

async function reReadRow(found: ReRead): Promise<CashUpShiftRow | null> {
  if (found === "nothing") return null;
  return shiftRow(found === "same fact" ? await recordedHash(FACT) : Buffer.alloc(32));
}

describe("ShiftCashUpService.openShift — a concurrent identical open", () => {
  it.each([
    ["shift_id_taken", "same fact", "replay"],
    ["shift_id_taken", "other payload", "shift_payload_conflict"],
    ["shift_id_taken", "nothing", "shift_payload_conflict"],
    ["device_has_open_shift", "same fact", "replay"],
    ["device_has_open_shift", "other payload", "shift_already_open"],
    ["device_has_open_shift", "nothing", "shift_already_open"],
  ] as const)("%s, then the scoped re-read finds %s → %s", async (kind, found, answer) => {
    const { repo } = fakeRepo([null, await reReadRow(found)], { kind });
    const opened = new ShiftCashUpService(pool, repo).openShift(CTX, FACT).then(
      (result) => (result.created ? "created" : "replay"),
      (err: ShiftCashUpError) => err.failure,
    );
    expect(await opened).toBe(answer);
  });

  it("the replay after a refused insert is the stored projection", async () => {
    const { repo } = fakeRepo([null, await reReadRow("same fact")], { kind: "device_has_open_shift" });
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
    const offset = await recordedHash({ ...FACT, openedAt: "2026-10-05T10:00:00+02:00" });
    expect([respelled.equals(base), offset.equals(base)]).toEqual([true, true]);
    expect((await recordedHash({ ...FACT, openingFloat: "500.01" })).equals(base)).toBe(false);
  });
});

describe("ShiftCashUpService.openShift — envelope path: an exact replay before the live stated-user check (RT-17 10931 #4)", () => {
  const ENVELOPE: ShiftWriteContext = { ...CTX, path: "envelope" };

  /** The open's outcome with a recorded row of `found` and a stated user that is (not) a store user. */
  async function openAgain(found: Exclude<ReRead, "nothing">, storeUser: boolean): Promise<string> {
    const { repo } = fakeRepo([await reReadRow(found)], { kind: "shift_id_taken" });
    const users = { isStoreUser: jest.fn(async () => storeUser) } as unknown as ShiftStoreUserReader;
    return new ShiftCashUpService(pool, repo, users).openShift(ENVELOPE, FACT).then(
      (result) => (result.created ? "created" : "replay"),
      (err: ShiftCashUpError) => err.failure,
    );
  }

  it.each([
    ["the same fact, the opener's access since revoked", "same fact", false, "replay"],
    ["the same fact, the opener still a store user", "same fact", true, "replay"],
    ["another payload, the opener's access revoked", "other payload", false, "refused"],
    ["another payload, the opener still a store user", "other payload", true, "shift_payload_conflict"],
  ] as const)("%s → %s", async (_label, found, storeUser, answer) => {
    expect(await openAgain(found, storeUser)).toBe(answer);
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
    ["shift_cashup_inconsistent", 422],
    ["currency_mismatch", 422],
    ["refund_ref_invalid", 422],
  ])("%s → %i", (failure, status) => {
    const err = toShiftHttpError(new ShiftCashUpError(failure as ShiftCashUpFailure)) as HttpException;
    expect([err.getStatus(), (err.getResponse() as { code: string }).code]).toEqual([status, failure]);
  });

  it("any other error passes through unchanged", () => {
    const other = new Error("boom");
    expect(toShiftHttpError(other)).toBe(other);
  });
});

describe("shiftWriteContext — the scope, actor and path the guard published (review #3)", () => {
  const context = { userId: CASHIER, tenantId: SCOPE.tenantId, storeId: SCOPE.storeId, isPlatformAdmin: false, source: "token" };
  const principalOf = (scope: string) => ({ kind: "token", tokenId: "t-1", tenantId: SCOPE.tenantId, userId: CASHIER, storeId: SCOPE.storeId, scope });
  const published = { context, posDeviceId: SCOPE.deviceId, principal: principalOf("pos") };

  it.each([
    ["a device principal (pos)", "device", "pos"],
    ["an envelope principal (pos_operator)", "envelope", "pos_operator"],
  ])("%s → the %s path, whatever the body says", (_label, path, scope) => {
    const request = { ...published, principal: principalOf(scope), body: { operatorUserId: CASHIER } };
    const ctx = shiftWriteContext(request as unknown as TenantContextRequest);
    expect(ctx).toEqual({ scope: SCOPE, actorUserId: CASHIER, path });
  });

  it.each([
    ["no context", { posDeviceId: SCOPE.deviceId, principal: published.principal }],
    ["no device", { context, principal: published.principal }],
    ["no actor", { ...published, context: { ...context, userId: null } }],
    ["no store", { ...published, context: { ...context, storeId: null } }],
    ["no principal", { context, posDeviceId: SCOPE.deviceId }],
    ["a session principal", { ...published, principal: { kind: "session", sessionId: "s-1", userId: CASHIER } }],
    ["a dashboard_api principal", { ...published, principal: principalOf("dashboard_api") }],
  ])("%s → the generic 401", (_label, request) => {
    expect(() => shiftWriteContext(request as unknown as TenantContextRequest)).toThrow(UnauthorizedException);
  });
});
