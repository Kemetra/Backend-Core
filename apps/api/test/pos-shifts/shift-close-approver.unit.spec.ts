/**
 * RT-17 follow-up: the close approver's standing is checked at ingest
 * (Jira RT-17 comment 10955, option A: detect, never refuse). Docker-free.
 *
 * On the FIRST record of a close that carries `varianceApprovedByUserId`,
 * after the close committed, Backend-Core checks that the approver:
 *   - is not the closer;
 *   - has an active membership of the tenant (not revoked, not deleted, the
 *     user not deleted);
 *   - holds `owner`, `tenant_admin` or `store_manager`;
 *   - has access to the shift's store.
 * A failed check emits ONE warning log and ONE
 * `shift_close_approver_unverified_total{reason}` increment, with a closed
 * reason set and no ids, amounts or PII. The close is still a 201 with the
 * same projection and the same recorded row. A lookup that fails is
 * `check_unavailable` and never fails the close. A replay (200) checks and
 * emits nothing (`pos-shifts.openapi.yaml` 1.1.0-draft: the server "never
 * refuses the close because of that role").
 */
import "reflect-metadata";

jest.mock("../../src/observability/metrics/api.metrics", () => {
  const actual = jest.requireActual("../../src/observability/metrics/api.metrics");
  return { ...actual, recordShiftCloseApproverUnverified: jest.fn() };
});

import { ALLOWED_METRIC_LABELS } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import {
  SHIFT_CLOSE_APPROVER_UNVERIFIED_REASONS,
  recordShiftCloseApproverUnverified,
} from "../../src/observability/metrics/api.metrics";
import type { CloseShiftFact } from "../../src/pos-shifts/shift-cash-up.dto";
import {
  ShiftCloseNotAppliedError,
  type CashUpShiftRow,
  type ShiftCashUpRepository,
  type ShiftCloseFact,
  type ShiftCloseRow,
} from "../../src/pos-shifts/shift-cash-up.repository";
import { ShiftCashUpService, type ShiftWriteContext } from "../../src/pos-shifts/shift-cash-up.service";
import {
  APPROVER_UNVERIFIED_EVENT,
  standingFinding,
  type ApproverStanding,
} from "../../src/pos-shifts/shift-close-approver";
import type { ShiftStoreUserReader } from "../../src/pos-shifts/shift-store-user";

const record = recordShiftCloseApproverUnverified as jest.MockedFunction<typeof recordShiftCloseApproverUnverified>;

const SCOPE = {
  tenantId: "0e170000-0000-4000-8000-0000000a0001",
  storeId: "0e170000-0000-4000-8000-0000000a5001",
  deviceId: "0e170000-0000-4000-8000-0000000e0001",
};
const CASHIER = "0e170000-0000-4000-8000-0000000c0001";
const APPROVER = "0e170000-0000-4000-8000-0000000c0003";
const SHIFT_ID = "0192f5a2-3b4c-7d8e-9f01-23456789ab01";
const DEVICE: ShiftWriteContext = { scope: SCOPE, actorUserId: CASHIER, path: "device" };
const ENVELOPE: ShiftWriteContext = { ...DEVICE, path: "envelope" };

const FACT: CloseShiftFact = {
  closedAt: "2026-10-05T16:00:00Z",
  closingUserId: CASHIER,
  closeKind: "normal",
  openingFloat: "500.00",
  cashSalesTotal: "2450.00",
  cashRefundsTotal: "0.00",
  payInTotal: "0.00",
  payOutTotal: "120.00",
  expectedCash: "2830.00",
  countedCash: "2825.00",
  variance: "-5.00",
  saleCount: 37,
  cashRefundReturnRefs: [],
  varianceApprovedByUserId: APPROVER,
};

/** Every value no log line or metric label may carry. */
const SECRETS = [SCOPE.tenantId, SCOPE.storeId, SCOPE.deviceId, CASHIER, APPROVER, SHIFT_ID, "2825", "-5.00"];

const MANAGER: ApproverStanding = { active: true, roleCode: "store_manager", storeAccess: true };

/** The order things happened in, across the doubles. */
type Step = "insertClose" | "approverStanding" | "BEGIN" | "COMMIT" | "ROLLBACK";

/** A pool whose clients answer every statement with no rows and note BEGIN / COMMIT / ROLLBACK. */
function poolOf(steps: Step[]): Pool {
  const query = async (sql: unknown) => {
    const text = typeof sql === "string" ? sql.trim().toUpperCase() : "";
    for (const step of ["BEGIN", "COMMIT", "ROLLBACK"] as const) if (text.startsWith(step)) steps.push(step);
    return { rows: [] };
  };
  return { connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
}

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

/** What the doubles hold and do. */
interface State {
  /** `findShift` answers in order (the last one repeats). */
  readonly shifts?: CashUpShiftRow[];
  readonly close?: ShiftCloseRow | null;
  /** What the approver lookup answers, or the error it throws. */
  readonly standing?: ApproverStanding | null | Error;
  /** Errors `insertClose` throws once each, in order, before it succeeds. */
  readonly insertFailures?: unknown[];
  /** The logger's warn throws. */
  readonly warnThrows?: boolean;
}

function harness(state: State = {}) {
  const steps: Step[] = [];
  const recorded: ShiftCloseFact[] = [];
  const finds = [...(state.shifts ?? [shiftRow("open")])];
  const failures = [...(state.insertFailures ?? [])];
  const repo = {
    findShift: jest.fn(async () => (finds.length > 1 ? finds.shift() : finds[0]) ?? null),
    findClose: jest.fn(async () => state.close ?? null),
    readRefundRefs: jest.fn(async () => []),
    insertClose: jest.fn(async (_c: unknown, _s: unknown, fact: ShiftCloseFact) => {
      if (failures.length > 0) throw failures.shift();
      steps.push("insertClose");
      recorded.push(fact);
      return closeRowOf(fact);
    }),
  };
  const reader = {
    isStoreUser: jest.fn(async () => true),
    isTenantUser: jest.fn(async () => true),
    approverStanding: jest.fn(async () => {
      steps.push("approverStanding");
      const standing = state.standing === undefined ? MANAGER : state.standing;
      if (standing instanceof Error) throw standing;
      return standing;
    }),
  };
  const logger = {
    warn: jest.fn((..._args: unknown[]) => {
      if (state.warnThrows) throw new Error("log sink down");
    }),
  };
  const service = new ShiftCashUpService(
    poolOf(steps),
    repo as unknown as ShiftCashUpRepository,
    reader as unknown as ShiftStoreUserReader,
    logger,
  );
  return { service, repo, reader, logger, recorded, steps };
}

type Harness = ReturnType<typeof harness>;

/** Closes with FACT (and `overrides`) on `ctx`; the answer as created / replay. */
async function closeWith(hx: Harness, overrides: Partial<CloseShiftFact> = {}, ctx = DEVICE): Promise<string> {
  const result = await hx.service.closeShift(ctx, SHIFT_ID, { ...FACT, ...overrides });
  return result.created ? "created" : "replay";
}

/** The reasons recorded, in order. */
const reasons = (): string[] => record.mock.calls.map(([attrs]) => attrs.reason);

/** Everything the logger was handed, as text. */
const logged = (hx: Harness): string => JSON.stringify(hx.logger.warn.mock.calls);

beforeEach(() => record.mockReset());

describe("standingFinding — the approver's standing in the tenant and store", () => {
  it.each<[string, ApproverStanding | null, string | null]>([
    ["no membership row resolves", null, "inactive_membership"],
    ["a revoked or deleted membership", { ...MANAGER, active: false }, "inactive_membership"],
    ["an inactive membership without the role (inactive is reported first)", { active: false, roleCode: "store_staff", storeAccess: false }, "inactive_membership"],
    ["a store_staff role", { ...MANAGER, roleCode: "store_staff" }, "not_manager"],
    ["an unknown role code", { ...MANAGER, roleCode: "auditor" }, "not_manager"],
    ["a role check before store access", { active: true, roleCode: "store_staff", storeAccess: false }, "not_manager"],
    ["a manager without access to the store", { ...MANAGER, storeAccess: false }, "no_store_access"],
    ["an admin without access to the store", { active: true, roleCode: "tenant_admin", storeAccess: false }, "no_store_access"],
    ["an active store_manager with store access", MANAGER, null],
    ["an active tenant_admin with store access", { ...MANAGER, roleCode: "tenant_admin" }, null],
    ["an active owner with store access", { ...MANAGER, roleCode: "owner" }, null],
  ])("%s → %s", (_label, standing, finding) => {
    expect(standingFinding(standing)).toBe(finding);
  });
});

describe("closeShift — a first record with an approver that fails the check: still 201, one log, one count", () => {
  it.each<[string, ApproverStanding | null | Error, Partial<CloseShiftFact>, string]>([
    ["the closer approving their own close", MANAGER, { varianceApprovedByUserId: CASHIER }, "approver_is_closer"],
    ["an approver with no live membership", null, {}, "inactive_membership"],
    ["an approver whose membership is revoked", { ...MANAGER, active: false }, {}, "inactive_membership"],
    ["an approver without a manager role", { ...MANAGER, roleCode: "store_staff" }, {}, "not_manager"],
    ["an approver without access to the store", { ...MANAGER, storeAccess: false }, {}, "no_store_access"],
    ["a lookup that fails", new Error("connection reset"), {}, "check_unavailable"],
  ])("%s → %s", async (_label, standing, overrides, reason) => {
    const hx = harness({ standing });
    expect(await closeWith(hx, overrides)).toBe("created");
    expect(hx.recorded).toHaveLength(1);
    expect(reasons()).toEqual([reason]);
    expect(hx.logger.warn).toHaveBeenCalledTimes(1);
    expect(hx.logger.warn.mock.calls[0]?.[0]).toMatchObject({ event: APPROVER_UNVERIFIED_EVENT, reason });
  });

  it("the projection and the recorded row are exactly those of a verified approver", async () => {
    const verified = harness();
    const unverified = harness({ standing: { ...MANAGER, roleCode: "store_staff" } });
    const a = await verified.service.closeShift(DEVICE, SHIFT_ID, FACT);
    const b = await unverified.service.closeShift(DEVICE, SHIFT_ID, FACT);
    expect(b).toEqual(a);
    expect(unverified.recorded).toEqual(verified.recorded);
    expect(unverified.recorded[0]?.varianceApprovedByUserId).toBe(APPROVER);
  });

  it("the log line and the metric labels carry no id, amount or PII", async () => {
    const hx = harness({ standing: { ...MANAGER, roleCode: "store_staff" } });
    await closeWith(hx, {}, ENVELOPE);
    const surfaces = `${logged(hx)}\n${JSON.stringify(record.mock.calls)}`;
    expect(SECRETS.filter((secret) => surfaces.includes(secret))).toEqual([]);
    expect(Object.keys(record.mock.calls[0]?.[0] ?? {})).toEqual(["reason"]);
  });

  it("the closer approving their own close needs no lookup", async () => {
    const hx = harness();
    await closeWith(hx, { varianceApprovedByUserId: CASHIER });
    expect(hx.reader.approverStanding).not.toHaveBeenCalled();
  });

  it("the lookup runs after the close committed, in its own transaction, for the scope's tenant and store", async () => {
    const hx = harness({ standing: { ...MANAGER, roleCode: "store_staff" } });
    await closeWith(hx);
    expect(hx.steps).toEqual(["BEGIN", "insertClose", "COMMIT", "BEGIN", "approverStanding", "COMMIT"]);
    expect(hx.reader.approverStanding).toHaveBeenCalledWith(expect.anything(), { scope: SCOPE, userId: APPROVER });
  });

  it("a failed lookup is check_unavailable and the close stays recorded", async () => {
    const hx = harness({ standing: new Error("pool exhausted") });
    expect(await closeWith(hx)).toBe("created");
    expect(hx.steps.slice(0, 3)).toEqual(["BEGIN", "insertClose", "COMMIT"]);
    expect(reasons()).toEqual(["check_unavailable"]);
    expect(logged(hx)).not.toContain("pool exhausted");
  });

  it("a log sink that throws does not fail the close, and the count is still taken", async () => {
    const hx = harness({ standing: { ...MANAGER, roleCode: "store_staff" }, warnThrows: true });
    expect(await closeWith(hx)).toBe("created");
    expect(reasons()).toEqual(["not_manager"]);
  });

  it("a counter that throws does not fail the close", async () => {
    record.mockImplementationOnce(() => {
      throw new Error("meter down");
    });
    const hx = harness({ standing: { ...MANAGER, roleCode: "store_staff" } });
    expect(await closeWith(hx)).toBe("created");
  });

  it("a close retried once after a deadlock counts once", async () => {
    const deadlock = Object.assign(new Error("pg 40P01"), { code: "40P01" });
    const hx = harness({ standing: { ...MANAGER, roleCode: "store_staff" }, insertFailures: [deadlock] });
    expect(await closeWith(hx)).toBe("created");
    expect(reasons()).toEqual(["not_manager"]);
  });
});

describe("closeShift — nothing is checked or emitted", () => {
  it.each<[string, ApproverStanding]>([
    ["a valid store_manager", MANAGER],
    ["a valid tenant_admin", { ...MANAGER, roleCode: "tenant_admin" }],
    ["a valid owner", { ...MANAGER, roleCode: "owner" }],
  ])("for %s: checked once, no log, no count", async (_label, standing) => {
    const hx = harness({ standing });
    expect(await closeWith(hx)).toBe("created");
    expect(hx.reader.approverStanding).toHaveBeenCalledTimes(1);
    expect([record.mock.calls.length, hx.logger.warn.mock.calls.length]).toEqual([0, 0]);
  });

  it("for a close without an approver: no lookup", async () => {
    const hx = harness();
    const { varianceApprovedByUserId: _none, ...zeroApproval } = FACT;
    await hx.service.closeShift(DEVICE, SHIFT_ID, zeroApproval);
    expect([hx.reader.approverStanding.mock.calls.length, record.mock.calls.length]).toEqual([0, 0]);
  });

  it("for an idempotent replay (200), even with an approver that would fail", async () => {
    const first = harness();
    await first.service.closeShift(DEVICE, SHIFT_ID, FACT);
    const close = closeRowOf(first.recorded[0]!);
    const hx = harness({ shifts: [shiftRow("closed")], close, standing: { ...MANAGER, roleCode: "store_staff" } });
    expect(await closeWith(hx)).toBe("replay");
    expect([hx.reader.approverStanding.mock.calls.length, record.mock.calls.length, hx.logger.warn.mock.calls.length]).toEqual([0, 0, 0]);
  });

  it("for the loser of two identical concurrent closes (settled as a replay)", async () => {
    const first = harness();
    await first.service.closeShift(DEVICE, SHIFT_ID, FACT);
    const close = closeRowOf(first.recorded[0]!);
    const hx = harness({
      shifts: [shiftRow("open"), shiftRow("closed")],
      close,
      standing: { ...MANAGER, roleCode: "store_staff" },
      insertFailures: [new ShiftCloseNotAppliedError()],
    });
    expect(await closeWith(hx)).toBe("replay");
    expect(record).not.toHaveBeenCalled();
  });

  it("for a refused close (422): nothing recorded, nothing checked", async () => {
    const hx = harness({ standing: { ...MANAGER, roleCode: "store_staff" } });
    await expect(hx.service.closeShift(DEVICE, SHIFT_ID, { ...FACT, variance: "-5.01" })).rejects.toMatchObject({
      failure: "shift_cashup_inconsistent",
    });
    expect([hx.reader.approverStanding.mock.calls.length, record.mock.calls.length]).toEqual([0, 0]);
  });
});

describe("shift_close_approver_unverified_total — registration", () => {
  it("the reason set is closed", () => {
    expect([...SHIFT_CLOSE_APPROVER_UNVERIFIED_REASONS].sort()).toEqual(
      ["approver_is_closer", "check_unavailable", "inactive_membership", "no_store_access", "not_manager"],
    );
  });

  it("is in the label allowlist with `reason` as its only label", () => {
    expect(ALLOWED_METRIC_LABELS["shift_close_approver_unverified_total"]).toEqual(["reason"]);
  });

  it("the real helper accepts every reason without a live SDK", () => {
    const actual = jest.requireActual<typeof import("../../src/observability/metrics/api.metrics")>(
      "../../src/observability/metrics/api.metrics",
    );
    for (const reason of SHIFT_CLOSE_APPROVER_UNVERIFIED_REASONS) {
      expect(() => actual.recordShiftCloseApproverUnverified({ reason })).not.toThrow();
    }
  });
});
