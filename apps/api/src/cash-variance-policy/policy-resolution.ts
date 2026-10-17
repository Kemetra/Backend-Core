/**
 * Resolution of the shift variance policy (AD-CASH-001 D-2; contract
 * `cash-variance-policy.openapi.yaml`, "Resolution"), owned by Backend-Core.
 * Pure: no DB, no clock — every function takes the instant it resolves at,
 * so the same rules answer "now" (the reads) and "at openedAt" (the open's
 * accept-and-flag check) and "at effectiveUntil" (the expiry audit).
 *
 *   - Tenant level: the tenant's latest revision created at or before the
 *     instant, else the System default (`none`, no revision).
 *   - Active store override: the store's latest revision at the instant, when
 *     it is a `set` whose `effectiveUntil` is absent or after the instant.
 *   - Effective: the stricter of the two; a tie goes to the store.
 */
import { compareStrictness, SYSTEM_DEFAULT, type PolicyValue } from "./policy-value";

export type PolicyScope = "tenant" | "store";
export type PolicyKind = "set" | "clear";
export type PolicySource = "system" | "tenant" | "store";
export type RevisionState = "current" | "superseded" | "expired";

/** One immutable revision (a `cash_variance_policy_revisions` row). */
export interface PolicyRevision {
  readonly id: string;
  readonly scope: PolicyScope;
  readonly storeId: string | null;
  readonly kind: PolicyKind;
  /** Null for a `clear`. */
  readonly value: PolicyValue | null;
  readonly reason: string;
  /** Equals `createdAt` (Apply Now, DR-12). */
  readonly createdAt: Date;
  readonly effectiveUntil: Date | null;
  readonly permanent: boolean;
  readonly approvedByUserId: string | null;
  readonly supersedesRevisionId: string | null;
  readonly createdByUserId: string;
}

/** A policy as resolved by Backend-Core. */
export interface ResolvedPolicy {
  readonly policySource: PolicySource;
  /** Null exactly for `system`. */
  readonly policyRevisionId: string | null;
  readonly policyValue: PolicyValue;
}

export const SYSTEM_POLICY: ResolvedPolicy = Object.freeze({
  policySource: "system",
  policyRevisionId: null,
  policyValue: SYSTEM_DEFAULT,
});

/** The latest of `revisions` created at or before `instant`, or null. */
export function latestAt(revisions: ReadonlyArray<PolicyRevision>, instant: Date): PolicyRevision | null {
  let latest: PolicyRevision | null = null;
  for (const r of revisions) {
    if (r.createdAt.getTime() > instant.getTime()) continue;
    if (latest === null || isNewer(r, latest)) latest = r;
  }
  return latest;
}

/** Newest first by (createdAt, id), the contract's history order. */
function isNewer(a: PolicyRevision, b: PolicyRevision): boolean {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  return d !== 0 ? d > 0 : a.id > b.id;
}

/** The tenant level at `instant` from the tenant's revisions. */
export function tenantLevelAt(tenantRevisions: ReadonlyArray<PolicyRevision>, instant: Date): ResolvedPolicy {
  const latest = latestAt(tenantRevisions, instant);
  if (!latest?.value) return SYSTEM_POLICY;
  return { policySource: "tenant", policyRevisionId: latest.id, policyValue: latest.value };
}

/** True when a store `set` is in force at `instant` (no expiry, or one after it). */
export function isActiveSet(revision: PolicyRevision, instant: Date): boolean {
  return (
    revision.kind === "set" &&
    revision.value !== null &&
    (revision.effectiveUntil === null || revision.effectiveUntil.getTime() > instant.getTime())
  );
}

/** The store's active override at `instant`, or null. */
export function activeOverrideAt(storeRevisions: ReadonlyArray<PolicyRevision>, instant: Date): PolicyRevision | null {
  const latest = latestAt(storeRevisions, instant);
  return latest !== null && isActiveSet(latest, instant) ? latest : null;
}

/** The stricter of the tenant level and the active override; a tie goes to the store. */
export function resolveEffective(tenantLevel: ResolvedPolicy, override: PolicyRevision | null): ResolvedPolicy {
  if (!override?.value) return tenantLevel;
  if (compareStrictness(override.value, tenantLevel.policyValue) < 0) return tenantLevel;
  return { policySource: "store", policyRevisionId: override.id, policyValue: override.value };
}

/** A store's effective policy at `instant` from the tenant's and the store's revisions. */
export function effectiveAt(history: PolicyHistory, instant: Date): ResolvedPolicy {
  return resolveEffective(tenantLevelAt(history.tenant, instant), activeOverrideAt(history.store, instant));
}

/** A store's revision history: the tenant scope and this store's scope. */
export interface PolicyHistory {
  readonly tenant: ReadonlyArray<PolicyRevision>;
  readonly store: ReadonlyArray<PolicyRevision>;
}

/**
 * The contract's derived `state`: `current` for the scope's latest revision
 * (`expired` when that is a store `set` whose `effectiveUntil` has passed),
 * `superseded` for every older one.
 */
export function revisionState(
  revision: PolicyRevision,
  scope: { readonly latestId: string | null; readonly now: Date },
): RevisionState {
  if (revision.id !== scope.latestId) return "superseded";
  const expired =
    revision.scope === "store" &&
    revision.kind === "set" &&
    revision.effectiveUntil !== null &&
    revision.effectiveUntil.getTime() <= scope.now.getTime();
  return expired ? "expired" : "current";
}
