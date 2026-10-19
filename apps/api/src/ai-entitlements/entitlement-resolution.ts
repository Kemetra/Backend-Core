/**
 * Layer 6 of the AI AND-chain (AD-AI-ENT-001 D-1) as a pure function: the
 * tenant's effective entitlement revision, its plan's catalogue features, the
 * revision's overrides and the owner's opt-out (D-5) decide whether a feature
 * is allowed, and with which meter limits. No I/O.
 *
 * Rules (RT-644 §4.3, D-5, D-7):
 *   - no revision or state `none` → `not_entitled` (default deny);
 *   - a feature is entitled when the revision's plan version lists it and no
 *     live `disable` override removes it. An `enable` override only adjusts
 *     a plan meter's limit (`meterLimitDelta`): it never adds a feature the
 *     plan lacks, because a feature's meters are code-owned catalogue rows;
 *   - `expired` / `cancelled`, or a revision past `effectiveUntil`, is not
 *     entitled (`trial_expired` for a trial);
 *   - `grace` keeps the feature entitled but denies new generation
 *     (`grace_read_only`);
 *   - an owner opt-out of an entitled feature is `feature_disabled_tenant`;
 *     an opt-out never changes `entitled` (it only subtracts);
 *   - a limit is never negative (a downgrade never creates a negative
 *     allowance).
 */
import type { AiEntitlementState, EntitlementDenyReason, MeterScope, MeterWindow } from "./entitlement.types";

export interface CatalogMeter {
  readonly meter: string;
  readonly unit: "request";
  readonly window: MeterWindow;
  readonly scope: MeterScope;
  readonly limit: number;
}

export interface EntitlementOverride {
  readonly featureId: string;
  readonly action: "enable" | "disable";
  readonly meter?: string;
  readonly meterLimitDelta?: number;
  readonly expiresAt?: Date;
  readonly reason: string;
}

export interface EntitlementRevision {
  readonly version: number;
  readonly state: AiEntitlementState;
  readonly planCode: string | null;
  readonly catalogVersion: number | null;
  readonly effectiveFrom: Date;
  readonly effectiveUntil: Date | null;
  readonly overrides: readonly EntitlementOverride[];
}

export interface OptOutState {
  readonly optedOut: boolean;
  readonly changedAt: Date | null;
}

export interface FeatureResolutionInput {
  /** The effective revision (the newest with `effectiveFrom <= now`), or null. */
  readonly revision: EntitlementRevision | null;
  /** featureId → meters, for the revision's plan version. */
  readonly planFeatures: ReadonlyMap<string, readonly CatalogMeter[]>;
  readonly featureId: string;
  readonly optOut: OptOutState;
  readonly now: Date;
}

export type FeatureVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: EntitlementDenyReason };

export interface FeatureResolution {
  /** Whether the effective entitlement includes the feature, before the opt-out. */
  readonly entitled: boolean;
  readonly verdict: FeatureVerdict;
  /** The feature's meters with their effective limits; empty when not entitled. */
  readonly meters: readonly CatalogMeter[];
}

const NOT_ENTITLED: FeatureResolution = { entitled: false, verdict: { allow: false, reason: "not_entitled" }, meters: [] };

function live(override: EntitlementOverride, now: Date): boolean {
  return override.expiresAt === undefined || override.expiresAt.getTime() > now.getTime();
}

function liveOverrides(revision: EntitlementRevision, featureId: string, now: Date): EntitlementOverride[] {
  return revision.overrides.filter((o) => o.featureId === featureId && live(o, now));
}

function effectiveMeters(meters: readonly CatalogMeter[], overrides: readonly EntitlementOverride[]): CatalogMeter[] {
  return meters.map((m) => {
    const delta = overrides
      .filter((o) => o.action === "enable" && o.meter === m.meter && o.meterLimitDelta !== undefined)
      .reduce((sum, o) => sum + (o.meterLimitDelta ?? 0), 0);
    return delta === 0 ? m : { ...m, limit: Math.max(0, m.limit + delta) };
  });
}

/** Past `effectiveUntil` (a trial's end is `trial_expired`), or a terminal state. */
function lapsed(revision: EntitlementRevision, now: Date): EntitlementDenyReason | null {
  if (revision.state === "expired" || revision.state === "cancelled") return "not_entitled";
  const until = revision.effectiveUntil;
  if (until !== null && until.getTime() <= now.getTime()) {
    return revision.state === "trial" ? "trial_expired" : "not_entitled";
  }
  return null;
}

/** The revision that names a plan (null for no revision or state `none`). */
function planRevision(revision: EntitlementRevision | null): EntitlementRevision | null {
  return revision === null || revision.state === "none" ? null : revision;
}

/** Why an entitled feature still refuses new generation, or null to allow. */
function refusalOf(revision: EntitlementRevision, ended: EntitlementDenyReason | null, optOut: OptOutState): EntitlementDenyReason | null {
  if (ended === "trial_expired") return "trial_expired";
  if (revision.state === "grace") return "grace_read_only";
  return optOut.optedOut ? "feature_disabled_tenant" : null;
}

export function resolveFeature(input: FeatureResolutionInput): FeatureResolution {
  const { featureId, now } = input;
  const revision = planRevision(input.revision);
  const planMeters = revision === null ? undefined : input.planFeatures.get(featureId);
  if (revision === null || planMeters === undefined) return NOT_ENTITLED;
  const overrides = liveOverrides(revision, featureId, now);
  if (overrides.some((o) => o.action === "disable")) return NOT_ENTITLED;

  const ended = lapsed(revision, now);
  if (ended === "not_entitled") return NOT_ENTITLED;
  const meters = effectiveMeters(planMeters, overrides);
  const reason = refusalOf(revision, ended, input.optOut);
  return { entitled: true, verdict: reason === null ? { allow: true } : { allow: false, reason }, meters };
}
