/**
 * RT-742 — ShiftForceCloseService.forceClose, Docker-free.
 *
 * The evaluation order (`pos-shifts.openapi.yaml` 1.4.0-draft,
 * `forceCloseShift`, Order): the shift in the envelope's tenant and store, on
 * any device (404) → the natural-key replay (200) or, for a different
 * `forcedReason`, 409 `shift_force_closed` → 409 `shift_closed` → the stuck
 * rule (409 `shift_not_stuck`) → record (201). The ForceClosedShift
 * projection: not counted, no totals, null cash-up fields for a legacy shift,
 * terminals named by label, no internal id.
 */
import "reflect-metadata";

import { UnauthorizedException } from "@nestjs/common";
import type { Pool } from "pg";

import type { TenantContextRequest } from "../../src/context/types";
import { forceCloseContext } from "../../src/pos-shifts/shift-cash-up.controller";
import { ForceCloseShiftRequestSchema } from "../../src/pos-shifts/shift-cash-up.dto";
import type { ShiftCashUpError } from "../../src/pos-shifts/shift-cash-up.errors";
import type {
  ForcedCloseRow,
  NewForcedClose,
  ShiftForceCloseRepository,
  StoreShiftRow,
} from "../../src/pos-shifts/shift-force-close.repository";
import {
  ShiftForceCloseService,
  type ForceCloseContext,
} from "../../src/pos-shifts/shift-force-close.service";

const TENANT = "0e170000-0000-4000-8000-0000000a0001";
const STORE = "0e170000-0000-4000-8000-0000000a5001";
const TILL_A = "0e170000-0000-4000-8000-0000000e0001";
const TILL_B = "0e170000-0000-4000-8000-0000000e0002";
const CASHIER = "0e170000-0000-4000-8000-0000000c0001";
const MANAGER = "0e170000-0000-4000-8000-0000000c0003";
const OTHER_MANAGER = "0e170000-0000-4000-8000-0000000c0009";
const SHIFT_ID = "0192f5a2-3b4c-7d8e-9f01-23456789ab01";
const REASON = "Cashier left without closing; shift opened on till A";

const CTX: ForceCloseContext = {
  tenantId: TENANT,
  storeId: STORE,
  actorUserId: MANAGER,
  callerDeviceId: TILL_B,
  callerTokenId: "0e170000-0000-4000-8000-0000000f0001",
};

/** A pool whose client answers every statement with no rows (BEGIN / GUCs / COMMIT). */
const pool = {
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }),
} as unknown as Pool;

const cashUpShift = (lifecycleState: StoreShiftRow["lifecycleState"], notCounted = false): StoreShiftRow => ({
  shiftId: SHIFT_ID,
  tenantId: TENANT,
  storeId: STORE,
  openingDeviceId: TILL_A,
  openingUserId: CASHIER,
  openedAt: new Date("2026-10-05T08:00:00Z"),
  lifecycleState,
  source: "cash_up",
  currencyCode: "EGP",
  openingFloat: "500.0000",
  receivedAt: new Date("2026-10-05T08:00:02Z"),
  openedOnTerminalLabel: "till-A",
  notCounted,
});

const legacyShift = (): StoreShiftRow => ({
  ...cashUpShift("open"),
  source: "legacy",
  currencyCode: null,
  openingFloat: null,
  receivedAt: null,
  openedOnTerminalLabel: null,
});

/** What the repository double holds. */
interface RepoState {
  readonly shift: StoreShiftRow | null;
  readonly forcedClose?: ForcedCloseRow | null;
  readonly stuck?: boolean;
}

function harness(state: RepoState) {
  const recorded: NewForcedClose[] = [];
  const repo = {
    findStoreShift: jest.fn(async () => state.shift),
    findForcedClose: jest.fn(async () => state.forcedClose ?? null),
    isStuck: jest.fn(async () => state.stuck ?? true),
    insertForcedClose: jest.fn(async (_c: unknown, _s: StoreShiftRow, close: NewForcedClose): Promise<ForcedCloseRow> => {
      recorded.push(close);
      return {
        ...close,
        shiftId: SHIFT_ID,
        closedAt: new Date("2026-10-06T09:10:00Z"),
        closedFromTerminalLabel: "till-B",
        openedOnTerminalLabel: state.shift?.openedOnTerminalLabel ?? null,
      };
    }),
  };
  const service = new ShiftForceCloseService(pool, repo as unknown as ShiftForceCloseRepository, 15);
  return { service, repo, recorded };
}

type Service = ReturnType<typeof harness>["service"];

/** The answer as one word: "created", "replay" or the refusal's contract code. */
function outcomeOf(service: Service, ctx: ForceCloseContext = CTX, forcedReason = REASON): Promise<string> {
  return service.forceClose(ctx, SHIFT_ID, { forcedReason }).then(
    (result) => (result.created ? "created" : "replay"),
    (err: ShiftCashUpError) => err.failure ?? String(err),
  );
}

/** The payload hash the service records for REASON. */
async function recordedHash(forcedReason = REASON): Promise<Buffer> {
  const { service, recorded } = harness({ shift: cashUpShift("open") });
  await service.forceClose(CTX, SHIFT_ID, { forcedReason });
  return recorded[0]!.payloadHash;
}

/** A recorded force close of this shift with `payloadHash`, by `closedByUserId`. */
const forcedCloseWith = (payloadHash: Buffer, closedByUserId = MANAGER): ForcedCloseRow => ({
  shiftId: SHIFT_ID,
  closedByUserId,
  closedAt: new Date("2026-10-06T09:10:00Z"),
  closedFromDeviceId: TILL_B,
  closedFromTerminalLabel: "till-B",
  openedOnTerminalLabel: "till-A",
  forcedReason: REASON,
  payloadHash,
});

describe("forceClose — a first force close (201)", () => {
  it("records the manager, the calling terminal, the reason and the hash; projects not counted", async () => {
    const { service, recorded } = harness({ shift: cashUpShift("open") });
    const result = await service.forceClose(CTX, SHIFT_ID, { forcedReason: REASON });
    expect(result.created).toBe(true);
    expect(recorded[0]).toMatchObject({ closedByUserId: MANAGER, closedFromDeviceId: TILL_B, forcedReason: REASON });
    expect(recorded[0]!.payloadHash).toHaveLength(32);
    expect(result.projection).toEqual({
      shiftId: SHIFT_ID,
      status: "force_closed",
      currencyCode: "EGP",
      openingFloat: "500.00",
      openedAt: "2026-10-05T08:00:00.000Z",
      openingUserId: CASHIER,
      receivedAt: "2026-10-05T08:00:02.000Z",
      forcedClose: {
        closedByUserId: MANAGER,
        closedAt: "2026-10-06T09:10:00.000Z",
        closedFromTerminalLabel: "till-B",
        openedOnTerminalLabel: "till-A",
        forcedReason: REASON,
        cashCount: "not_counted",
      },
    });
  });

  it("hands the controller the audit evidence: the shift and both terminals, never the reason", async () => {
    const result = await harness({ shift: cashUpShift("open") }).service.forceClose(CTX, SHIFT_ID, { forcedReason: REASON });
    expect(result.audit).toEqual({ shift_id: SHIFT_ID, closed_from_device_id: TILL_B, opened_on_device_id: TILL_A, replayed: false });
  });

  it("a legacy shift closes the same way, with null currency, float and receipt", async () => {
    const result = await harness({ shift: legacyShift() }).service.forceClose(CTX, SHIFT_ID, { forcedReason: REASON });
    expect(result.projection).toMatchObject({ currencyCode: null, openingFloat: null, receivedAt: null, status: "force_closed" });
    expect(result.projection.forcedClose.openedOnTerminalLabel).toBeNull();
  });

  it("asks the stuck rule with the caller's own session excluded and the configured threshold", async () => {
    const { service, repo } = harness({ shift: cashUpShift("open") });
    await service.forceClose(CTX, SHIFT_ID, { forcedReason: REASON });
    expect(repo.isStuck.mock.calls[0]?.slice(1)).toEqual([
      cashUpShift("open"),
      { callerTokenId: CTX.callerTokenId, thresholdMinutes: 15 },
    ]);
  });

  it("the shift is looked up in the envelope's tenant and store only, never by device", async () => {
    const { service, repo } = harness({ shift: cashUpShift("open") });
    await service.forceClose(CTX, SHIFT_ID, { forcedReason: REASON });
    expect(repo.findStoreShift.mock.calls[0]?.slice(1)).toEqual([{ tenantId: TENANT, storeId: STORE }, SHIFT_ID]);
  });

  it("the hash is the natural key: shift and reason, never the actor or the terminal", async () => {
    const base = await recordedHash();
    const { service, recorded } = harness({ shift: cashUpShift("open") });
    await service.forceClose({ ...CTX, actorUserId: OTHER_MANAGER, callerDeviceId: TILL_A }, SHIFT_ID, { forcedReason: REASON });
    expect(recorded[0]!.payloadHash.equals(base)).toBe(true);
    expect((await recordedHash("another reason")).equals(base)).toBe(false);
  });
});

describe("forceClose — refusals and replays, in the contract's order", () => {
  it.each<[string, () => Promise<RepoState>, string]>([
    ["a shift outside the envelope's tenant and store (or unknown)", async () => ({ shift: null }), "shift_not_found"],
    ["the same force close again (another key, even another manager)", async () => ({ shift: cashUpShift("closed_forced", true), forcedClose: forcedCloseWith(await recordedHash(), OTHER_MANAGER) }), "replay"],
    ["the same force close again, not stuck any more", async () => ({ shift: cashUpShift("closed_forced", true), forcedClose: forcedCloseWith(await recordedHash()), stuck: false }), "replay"],
    ["a different reason for a force-closed shift", async () => ({ shift: cashUpShift("closed_forced", true), forcedClose: forcedCloseWith(Buffer.alloc(32)) }), "shift_force_closed"],
    ["a shift closed with a cash-up", async () => ({ shift: cashUpShift("closed") }), "shift_closed"],
    ["a shift force-closed by the POS with a count (closed_forced)", async () => ({ shift: cashUpShift("closed_forced"), stuck: false }), "shift_closed"],
    ["an open shift that is not stuck now", async () => ({ shift: cashUpShift("open"), stuck: false }), "shift_not_stuck"],
  ])("%s → %s", async (_label, state, answer) => {
    const { service, repo } = harness(await state());
    expect(await outcomeOf(service)).toBe(answer);
    expect(repo.insertForcedClose).not.toHaveBeenCalled();
  });

  it("a replay projects the recorded fact, not the caller", async () => {
    const recordedFact = forcedCloseWith(await recordedHash(), OTHER_MANAGER);
    const { service } = harness({ shift: cashUpShift("closed_forced", true), forcedClose: recordedFact });
    const result = await service.forceClose(CTX, SHIFT_ID, { forcedReason: REASON });
    expect([result.created, result.projection.forcedClose.closedByUserId]).toEqual([false, OTHER_MANAGER]);
  });

  it("the stuck rule is not asked for a closed shift", async () => {
    const { service, repo } = harness({ shift: cashUpShift("closed") });
    await outcomeOf(service);
    expect(repo.isStuck).not.toHaveBeenCalled();
  });
});

describe("forceCloseContext — what the envelope guard published", () => {
  const context = { userId: MANAGER, tenantId: TENANT, storeId: STORE, isPlatformAdmin: false, source: "token" };
  const principalOf = (scope: string) => ({ kind: "token", tokenId: CTX.callerTokenId, tenantId: TENANT, userId: MANAGER, storeId: STORE, scope });
  const published = { context, posDeviceId: TILL_B, principal: principalOf("pos_operator") };

  it("scope, actor, calling terminal and own session, never from the body", () => {
    const request = { ...published, body: { tenantId: "x", storeId: "y", forcedReason: REASON } };
    expect(forceCloseContext(request as unknown as TenantContextRequest)).toEqual(CTX);
  });

  it.each([
    ["a device principal (pos)", { ...published, principal: principalOf("pos") }],
    ["a dashboard_api principal", { ...published, principal: principalOf("dashboard_api") }],
    ["a session principal", { ...published, principal: { kind: "session", sessionId: "s-1", userId: MANAGER } }],
    ["no principal", { context, posDeviceId: TILL_B }],
    ["no bound terminal", { context, principal: published.principal }],
    ["no store", { ...published, context: { ...context, storeId: null } }],
    ["no actor", { ...published, context: { ...context, userId: null } }],
  ])("%s → the generic 401", (_label, request) => {
    expect(() => forceCloseContext(request as unknown as TenantContextRequest)).toThrow(UnauthorizedException);
  });
});

describe("ForceCloseShiftRequestSchema — the reason only, strict", () => {
  it.each([
    ["a reason", { forcedReason: REASON }, true],
    ["200 characters", { forcedReason: "x".repeat(200) }, true],
    ["201 characters", { forcedReason: "x".repeat(201) }, false],
    ["an empty reason", { forcedReason: "" }, false],
    ["no reason", {}, false],
    ["a NUL", { forcedReason: "a\u0000b" }, false],
    ["a total", { forcedReason: REASON, countedCash: "0.00" }, false],
    ["a user id", { forcedReason: REASON, closingUserId: MANAGER }, false],
    ["a scope field", { forcedReason: REASON, storeId: STORE }, false],
    ["the device-path claim", { forcedReason: REASON, operatorUserId: MANAGER }, false],
  ])("%s → valid %s", (_label, body, ok) => {
    expect(ForceCloseShiftRequestSchema.safeParse(body).success).toBe(ok);
  });
});
