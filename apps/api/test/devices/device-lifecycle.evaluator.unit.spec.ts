/**
 * RT-366 — the device lifecycle evaluator (RT-287 D-Q1 / D-Q2 / D-Q4 as
 * amended): the one decision the impact preview and every lifecycle mutation
 * share. No DB, no HTTP.
 *
 *   1. The verdict of each action, for every reason × state × role.
 *   2. Parity: over the whole cross-product, the revoke's decision
 *      (`decideRevoke`) is exactly what the preview's verdict maps to under the
 *      contract's table ("Impact preview" in `devices.openapi.yaml`).
 */
import {
  evaluateLifecycle,
  LIFECYCLE_ACTIONS,
  revokeReasonOf,
  type DeviceLifecycleState,
  type LifecycleEvaluation,
} from "../../src/devices/device-lifecycle.evaluator";
import { decideRevoke, REVOKE_REASONS, type RevokeDecision, type RevokeReason } from "../../src/devices/devices.projections";

const SHIFT = "0190f5a2-3b4c-7d8e-9f01-000000000004";
const SECURITY: readonly RevokeReason[] = ["lost", "stolen", "suspected_compromise"];
const OTHER: readonly RevokeReason[] = ["replaced", "moved", "retired", "admin_error", "other"];
const ROLES = ["owner", "tenant_admin", "store_manager", null] as const;
const RECOVERY_REQUIRES = ["owner_or_tenant_admin", "note", "acknowledge_custody_exception"];

const ACTIVE: DeviceLifecycleState = { revoked: false, retired: false, openShiftId: null };
const ACTIVE_SHIFT: DeviceLifecycleState = { ...ACTIVE, openShiftId: SHIFT };
const REVOKED: DeviceLifecycleState = { revoked: true, retired: false, openShiftId: null };
const EXCEPTION: DeviceLifecycleState = { ...REVOKED, openShiftId: SHIFT };
const RETIRED: DeviceLifecycleState = { revoked: true, retired: true, openShiftId: null };
const STATES = [ACTIVE, ACTIVE_SHIFT, REVOKED, EXCEPTION, RETIRED];

const ALLOWED: LifecycleEvaluation = { verdict: "allowed", blockCode: null, requires: [] };
const NO_CHANGE: LifecycleEvaluation = { verdict: "no_change", blockCode: null, requires: [] };
const blocked = (blockCode: string): LifecycleEvaluation => ({ verdict: "blocked", blockCode, requires: [] } as LifecycleEvaluation);

const revokeVerdict = (reason: RevokeReason, state: DeviceLifecycleState, callerRole: string | null = "owner") =>
  evaluateLifecycle({ action: "revoke", reason, state, callerRole });

// ===========================================================================
// 1. Verdicts
// ===========================================================================
describe("evaluateLifecycle — revoke", () => {
  it.each(REVOKE_REASONS.map((r) => [r]))("answers no_change for %s on a revoked, excepted or retired device", (reason) => {
    for (const state of [REVOKED, EXCEPTION, RETIRED]) expect(revokeVerdict(reason, state)).toEqual(NO_CHANGE);
  });

  it.each(REVOKE_REASONS.map((r) => [r]))("allows %s with no open shift, whatever the role", (reason) => {
    for (const role of ROLES) expect(revokeVerdict(reason, ACTIVE, role)).toEqual(ALLOWED);
  });

  it.each(SECURITY.map((r) => [r]))("a security revoke (%s) over an open shift makes the custody exception for any role", (reason) => {
    for (const role of ROLES) {
      expect(revokeVerdict(reason, ACTIVE_SHIFT, role)).toEqual({
        verdict: "allowed_with_custody_exception",
        blockCode: null,
        requires: [],
      });
    }
  });

  it("a recovery revoke needs owner / tenant_admin, and reports its requirements to every role", () => {
    for (const role of ["owner", "tenant_admin"]) {
      expect(revokeVerdict("hardware_failure", ACTIVE_SHIFT, role)).toEqual({
        verdict: "allowed_with_custody_exception",
        blockCode: null,
        requires: RECOVERY_REQUIRES,
      });
    }
    for (const role of ["store_manager", "store_staff", null]) {
      expect(revokeVerdict("hardware_failure", ACTIVE_SHIFT, role)).toEqual({
        verdict: "forbidden_recovery",
        blockCode: null,
        requires: RECOVERY_REQUIRES,
      });
    }
  });

  it.each(OTHER.map((r) => [r]))("blocks %s over an open shift with unresolved_cash_session", (reason) => {
    for (const role of ROLES) expect(revokeVerdict(reason, ACTIVE_SHIFT, role)).toEqual(blocked("unresolved_cash_session"));
  });
});

describe("evaluateLifecycle — replace / move (RT-367)", () => {
  it.each([
    ["an active device", ACTIVE, ALLOWED],
    ["an active device with an open shift", ACTIVE_SHIFT, blocked("unresolved_cash_session")],
    ["a revoked device", REVOKED, ALLOWED],
    ["a revoked device whose open shift is the custody exception", EXCEPTION, ALLOWED],
    ["a retired device", RETIRED, blocked("device_retired")],
  ])("judges %s", (_label, state, expected) => {
    for (const action of ["replace", "move"] as const) {
      for (const role of ROLES) expect(evaluateLifecycle({ action, reason: revokeReasonOf(action), state, callerRole: role })).toEqual(expected);
    }
  });
});

describe("evaluateLifecycle — retire (RT-368)", () => {
  it.each([
    ["an active device", ACTIVE, ALLOWED],
    ["an active device with an open shift", ACTIVE_SHIFT, blocked("unresolved_cash_session")],
    ["a revoked device", REVOKED, ALLOWED],
    ["a revoked device with the custody exception", EXCEPTION, blocked("unresolved_custody_exception")],
    ["a retired device", RETIRED, NO_CHANGE],
  ])("judges %s", (_label, state, expected) => {
    for (const role of ROLES) expect(evaluateLifecycle({ action: "retire", reason: "retired", state, callerRole: role })).toEqual(expected);
  });
});

describe("revokeReasonOf", () => {
  it("records the D-Q1 / D-Q2 reason of each implied action", () => {
    expect(["replace", "move", "retire"].map((a) => revokeReasonOf(a as "replace"))).toEqual(["replaced", "moved", "retired"]);
  });

  it("takes the caller's reason for a revoke, and has no default", () => {
    expect(revokeReasonOf("revoke", "stolen")).toBe("stolen");
    expect(() => revokeReasonOf("revoke")).toThrow();
  });

  it("covers exactly the four contract actions", () => {
    expect(LIFECYCLE_ACTIONS).toEqual(["revoke", "replace", "move", "retire"]);
  });
});

// ===========================================================================
// 2. Parity: the revoke decides what the preview says
// ===========================================================================

/** The contract's verdict → `consoleRevokeDevice` outcome table, written independently of the code. */
function contractOutcome(evaluation: LifecycleEvaluation, state: DeviceLifecycleState, note: string | undefined, ack: boolean | undefined): RevokeDecision {
  switch (evaluation.verdict) {
    case "no_change":
      return { kind: "already_revoked" };
    case "allowed":
      return { kind: "revoke", custodyExceptionShiftId: null };
    case "forbidden_recovery":
      return { kind: "refuse", status: 403, code: "recovery_revoke_forbidden" };
    case "blocked":
      return { kind: "refuse", status: 409, code: evaluation.blockCode as "unresolved_cash_session" };
    case "allowed_with_custody_exception":
      if (evaluation.requires.includes("note") && note === undefined) {
        return { kind: "refuse", status: 422, code: "recovery_note_required" };
      }
      if (evaluation.requires.includes("acknowledge_custody_exception") && ack !== true) {
        return { kind: "refuse", status: 422, code: "custody_exception_not_acknowledged" };
      }
      return { kind: "revoke", custodyExceptionShiftId: state.openShiftId };
  }
}

describe("preview / revoke parity", () => {
  const states = STATES.filter((s) => !s.retired); // the revoke's input has no retired flag (retired implies revoked)
  const cases = REVOKE_REASONS.flatMap((reason) =>
    states.flatMap((state) =>
      ROLES.flatMap((role) =>
        [undefined, "Drawer cash in the safe"].flatMap((note) =>
          [undefined, false, true].map((ack) => ({ reason, state, role, note, ack })),
        ),
      ),
    ),
  );

  it(`decideRevoke equals the preview's mapped verdict on all ${cases.length} cases`, () => {
    const mismatches = cases.filter(({ reason, state, role, note, ack }) => {
      const decision = decideRevoke({
        alreadyRevoked: state.revoked,
        openShiftId: state.openShiftId,
        reason,
        callerRole: role,
        note,
        acknowledgeCustodyException: ack,
      });
      return JSON.stringify(decision) !== JSON.stringify(contractOutcome(revokeVerdict(reason, state, role), state, note, ack));
    });
    expect(mismatches).toEqual([]);
    expect(cases.length).toBe(REVOKE_REASONS.length * 4 * ROLES.length * 2 * 3);
  });
});
