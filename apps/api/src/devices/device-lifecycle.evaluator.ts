/**
 * RT-366 (RT-287 F3) — the device lifecycle evaluator: the ONE decision the
 * impact preview (`consoleGetDeviceImpact`) and every lifecycle mutation share,
 * so the two cannot drift (`devices.openapi.yaml`, "Impact preview"). Pure: no
 * DB, no clock.
 *
 * Inputs are state and authority only: the action, the revoke reason it
 * records, whether the device is revoked / retired, its open shift and the
 * caller's role. A request's note and acknowledgement are NOT inputs; a
 * mutation checks them afterwards against `requires` (`decideRevoke`).
 *
 * The rules (RT-287 D-Q1 / D-Q2 / D-Q4 as amended, RT-367 / RT-368 comments):
 *   - revoke: already revoked → no_change; no open shift → allowed; a security
 *     reason → custody exception; `hardware_failure` → the recovery revoke
 *     (owner / tenant_admin, note, acknowledgement); else 409.
 *   - replace / move: retired → blocked; revoked (with or without a custody
 *     exception) → allowed, the pair-time auto-revoke is a no-op; an open
 *     shift on an active device → 409; else allowed.
 *   - retire: retired → no_change; an open shift → 409 on an active device, the
 *     unresolved custody exception on a revoked one; else allowed.
 */

/** The closed RT-287 D-Q3 set (0040 CHECK `devices_revoke_reason_valid`). */
export const REVOKE_REASONS = [
  "lost",
  "stolen",
  "suspected_compromise",
  "hardware_failure",
  "replaced",
  "moved",
  "retired",
  "admin_error",
  "other",
] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

export const LIFECYCLE_ACTIONS = ["revoke", "replace", "move", "retire"] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export type ImpactVerdict = "allowed" | "allowed_with_custody_exception" | "blocked" | "forbidden_recovery" | "no_change";
export type ImpactBlockCode = "unresolved_cash_session" | "unresolved_custody_exception" | "device_retired";
export type ImpactRequirement = "owner_or_tenant_admin" | "note" | "acknowledge_custody_exception";

/** The security class: always succeeds, never waits (RT-287 D-Q3 / D-Q4). */
const SECURITY_REASONS: ReadonlySet<RevokeReason> = new Set(["lost", "stolen", "suspected_compromise"]);

/** The reason that, with an open shift, is a recovery revoke (D-Q4 amended). */
const RECOVERY_REASON: RevokeReason = "hardware_failure";

/** Roles allowed a recovery revoke (stronger authority than the base revoke). */
const RECOVERY_ROLES: ReadonlySet<string> = new Set(["owner", "tenant_admin"]);

/** The recovery revoke's requirements, in the order the revoke checks them. */
const RECOVERY_REQUIRES: readonly ImpactRequirement[] = ["owner_or_tenant_admin", "note", "acknowledge_custody_exception"];

/** The revoke reason each implied action records (D-Q1 / D-Q2). */
const IMPLIED_REASONS: Readonly<Record<Exclude<LifecycleAction, "revoke">, RevokeReason>> = {
  replace: "replaced",
  move: "moved",
  retire: "retired",
};

/** The device as the evaluator sees it. Retired implies revoked (0040 CHECK). */
export interface DeviceLifecycleState {
  readonly revoked: boolean;
  readonly retired: boolean;
  /** The most recently opened open shift on the device, or null. */
  readonly openShiftId: string | null;
}

export interface LifecycleInput {
  readonly action: LifecycleAction;
  /** The revoke reason the action records (`revokeReasonOf`). */
  readonly reason: RevokeReason;
  readonly state: DeviceLifecycleState;
  /** The caller's role code in the tenant. */
  readonly callerRole: string | null;
}

/** `blockCode` is set exactly on `blocked`; `requires` is non-empty only on the recovery revoke. */
export type LifecycleEvaluation = { readonly requires: readonly ImpactRequirement[] } & (
  | { readonly verdict: "blocked"; readonly blockCode: ImpactBlockCode }
  | { readonly verdict: Exclude<ImpactVerdict, "blocked">; readonly blockCode: null }
);

const ALLOWED: LifecycleEvaluation = { verdict: "allowed", blockCode: null, requires: [] };
const NO_CHANGE: LifecycleEvaluation = { verdict: "no_change", blockCode: null, requires: [] };

function blocked(blockCode: ImpactBlockCode): LifecycleEvaluation {
  return { verdict: "blocked", blockCode, requires: [] };
}

/** The revoke reason `action` records: the caller's for a revoke, the implied one otherwise. */
export function revokeReasonOf(action: LifecycleAction, reason?: RevokeReason): RevokeReason {
  if (action !== "revoke") return IMPLIED_REASONS[action];
  if (reason === undefined) throw new Error("a revoke needs a reason");
  return reason;
}

/** The verdict on `action` now (see the file header). */
export function evaluateLifecycle(input: LifecycleInput): LifecycleEvaluation {
  switch (input.action) {
    case "revoke":
      return evaluateRevoke(input);
    case "replace":
    case "move":
      return evaluateReplace(input.state);
    case "retire":
      return evaluateRetire(input.state);
  }
}

function evaluateRevoke(input: LifecycleInput): LifecycleEvaluation {
  if (input.state.revoked || input.state.retired) return NO_CHANGE;
  if (input.state.openShiftId === null) return ALLOWED;
  if (SECURITY_REASONS.has(input.reason)) {
    return { verdict: "allowed_with_custody_exception", blockCode: null, requires: [] };
  }
  if (input.reason !== RECOVERY_REASON) return blocked("unresolved_cash_session");
  const permitted = input.callerRole !== null && RECOVERY_ROLES.has(input.callerRole);
  return {
    verdict: permitted ? "allowed_with_custody_exception" : "forbidden_recovery",
    blockCode: null,
    requires: RECOVERY_REQUIRES,
  };
}

function evaluateReplace(state: DeviceLifecycleState): LifecycleEvaluation {
  if (state.retired) return blocked("device_retired");
  if (state.revoked) return ALLOWED;
  return state.openShiftId === null ? ALLOWED : blocked("unresolved_cash_session");
}

function evaluateRetire(state: DeviceLifecycleState): LifecycleEvaluation {
  if (state.retired) return NO_CHANGE;
  if (state.openShiftId === null) return ALLOWED;
  return blocked(state.revoked ? "unresolved_custody_exception" : "unresolved_cash_session");
}
