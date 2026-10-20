/**
 * The validation rules of platform-admin entitlement revisions and dispute
 * adjustments (AD-AI-ENT-001 D-2, RT-644 §4.7) — RT-664. Pure: each rule
 * returns the refusal it finds, or null. The catalogue rules take the
 * catalogue facts the service read.
 */
import type { CatalogMeter } from "./entitlement-resolution";
import { AI_ENTITLEMENT_STATES, type AiEntitlementState } from "./entitlement.types";
import type { OverrideInput } from "./revision-content";

export interface RevisionInput {
  /** The current chain head (0 when the tenant has no revision). */
  readonly expectedVersion: number;
  readonly state: AiEntitlementState;
  readonly planCode: string | null;
  readonly catalogVersion: number | null;
  /** RFC 3339; defaults to the transaction's now(). */
  readonly effectiveFrom?: string;
  readonly effectiveUntil?: string | null;
  readonly overrides?: readonly OverrideInput[];
  readonly reason: string;
}

export interface AdjustmentInput {
  readonly committedEntryId: string;
  readonly units: number;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/** The catalogue facts an override is checked against. */
export interface CatalogFacts {
  readonly known: ReadonlySet<string>;
  readonly plan: ReadonlyMap<string, readonly CatalogMeter[]>;
}

type Rule<T> = (value: T) => string | null;

const KEY_PATTERN = /^[\x21-\x7E]{16,128}$/;
const MAX_OVERRIDES = 100;

export function validReason(reason: string): boolean {
  return reason.length >= 1 && reason.length <= 500;
}

function isAbsent(value: string | undefined | null): value is undefined | null {
  return value === undefined || value === null;
}

function validInstant(value: string | undefined | null): boolean {
  return isAbsent(value) || !Number.isNaN(Date.parse(value));
}

function firstFailure<T>(rules: ReadonlyArray<Rule<T>>, value: T): string | null {
  for (const rule of rules) {
    const failure = rule(value);
    if (failure !== null) return failure;
  }
  return null;
}

function namesPlan(input: RevisionInput): boolean {
  return input.planCode !== null && input.catalogVersion !== null;
}

function halfPlan(input: RevisionInput): boolean {
  return (input.planCode === null) !== (input.catalogVersion === null);
}

/** `none` names no plan; every other state names a whole plan version. */
const planShape: Rule<RevisionInput> = (input) => {
  const mismatch = (input.state === "none") === namesPlan(input);
  return mismatch || halfPlan(input) ? "state none names no plan; every other state names a plan version" : null;
};

const trialEnds: Rule<RevisionInput> = (input) =>
  input.state === "trial" && isAbsent(input.effectiveUntil) ? "a trial needs effectiveUntil" : null;

const instants: Rule<RevisionInput> = (input) =>
  validInstant(input.effectiveFrom) && validInstant(input.effectiveUntil) ? null : "malformed instant";

const expectedVersion: Rule<RevisionInput> = (input) =>
  Number.isInteger(input.expectedVersion) && input.expectedVersion >= 0 ? null : "expectedVersion must be >= 0";

const overrideCount: Rule<RevisionInput> = (input) => ((input.overrides ?? []).length > MAX_OVERRIDES ? "too many overrides" : null);

const overrideBasics: Rule<OverrideInput> = (o) =>
  validReason(o.reason) && validInstant(o.expiresAt) ? null : "override reason or expiresAt is invalid";

function hasMeterPart(o: OverrideInput): boolean {
  return o.meter !== undefined || o.meterLimitDelta !== undefined;
}

const disableHasNoMeter: Rule<OverrideInput> = (o) =>
  o.action === "disable" && hasMeterPart(o) ? "a disable override has no meter" : null;

function validDelta(o: OverrideInput): boolean {
  return Number.isSafeInteger(o.meterLimitDelta) && o.meter !== undefined;
}

const deltaNeedsMeter: Rule<OverrideInput> = (o) =>
  o.meterLimitDelta === undefined || validDelta(o) ? null : "meterLimitDelta needs a meter and a whole number";

const OVERRIDE_RULES: ReadonlyArray<Rule<OverrideInput>> = [overrideBasics, disableHasNoMeter, deltaNeedsMeter];

const eachOverride: Rule<RevisionInput> = (input) => {
  for (const o of input.overrides ?? []) {
    const failure = firstFailure(OVERRIDE_RULES, o);
    if (failure !== null) return failure;
  }
  return null;
};

const REVISION_RULES: ReadonlyArray<Rule<RevisionInput>> = [
  (input) => (validReason(input.reason) ? null : "reason must be 1-500 characters"),
  (input) => (AI_ENTITLEMENT_STATES.includes(input.state) ? null : "unknown state"),
  planShape,
  trialEnds,
  instants,
  expectedVersion,
  overrideCount,
  eachOverride,
];

/** The shape rules that need no database. */
export function revisionShapeFailure(input: RevisionInput): string | null {
  return firstFailure(REVISION_RULES, input);
}

function overrideCatalogFailure(o: OverrideInput, facts: CatalogFacts): string | null {
  if (!facts.known.has(o.featureId)) return "override names an unknown feature";
  const meters = facts.plan.get(o.featureId);
  if (o.action === "enable" && meters === undefined) return "an enable override needs a plan feature";
  const knownMeter = o.meter === undefined || (meters ?? []).some((m) => m.meter === o.meter);
  return knownMeter ? null : "override names an unknown meter";
}

/** Every override names a catalogue feature; an enable or meter override, a plan feature and meter. */
export function overridesCatalogFailure(overrides: readonly OverrideInput[], facts: CatalogFacts): string | null {
  for (const o of overrides) {
    const failure = overrideCatalogFailure(o, facts);
    if (failure !== null) return failure;
  }
  return null;
}

const ADJUSTMENT_RULES: ReadonlyArray<Rule<AdjustmentInput>> = [
  (input) => (Number.isSafeInteger(input.units) && input.units >= 1 ? null : "units must be a positive whole number"),
  (input) => (validReason(input.reason) ? null : "reason must be 1-500 characters"),
  (input) => (KEY_PATTERN.test(input.idempotencyKey) ? null : "malformed idempotency key"),
];

export function adjustmentFailure(input: AdjustmentInput): string | null {
  return firstFailure(ADJUSTMENT_RULES, input);
}
