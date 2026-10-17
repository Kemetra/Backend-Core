/**
 * The accept-and-flag findings on a frozen policy at open (AD-CASH-001 D-6;
 * pos-shifts 1.2.0-draft `PolicyFlag`). Never a refusal: the open is
 * recorded whatever this returns.
 *
 *   - `policy_revision_unknown`: a tenant / store source whose id is not a
 *     revision of this tenant, is a store revision of another store, is of the
 *     other scope than the source names, or is a `clear` (never a resolved id).
 *   - `policy_revision_superseded`: the frozen policy (its revision, or the
 *     System default for `system`) was not the store's effective policy at
 *     any instant of the closed window [openedAt − OPEN_SKEW_MS, openedAt +
 *     OPEN_SKEW_MS] (the RT-224 clock skew, 120 s). The bounds are inclusive
 *     on both sides: a revision superseded exactly 120 s before openedAt, or
 *     published exactly 120 s after it, is within tolerance; 1 ms more is
 *     flagged. An offline open on an older cached revision is normal (DR-8);
 *     an online open on the then-current revision is not flagged.
 *   - `policy_value_mismatch`: the value differs from the revision's stored
 *     value (for `system`, from the System default `none`), or a `limit`'s
 *     currency differs from the shift's.
 *
 * `fallback` is the POS's own never-fetched value (DR-6), never a server
 * revision: only the currency rule applies to it.
 */
import type { PoolClient } from "pg";

import type { FrozenPolicyFact, PolicyFlag } from "../pos-shifts/shift-frozen-policy";
import { effectiveAt, type PolicyHistory, type ResolvedPolicy } from "./policy-resolution";
import { samePolicyValue, SYSTEM_DEFAULT } from "./policy-value";
import { PolicyRepository, type StoredRevision } from "./policy.repository";

/**
 * The RT-224 clock-skew tolerance (120 s) of the superseded check, applied on
 * both sides of the open's POS-clock `openedAt`, bounds inclusive. The one
 * place this window is defined (coordinator condition on RT-387).
 */
export const OPEN_SKEW_MS = 120_000;

/** Revision times are compared at millisecond precision (JS `Date`). */
const TICK_MS = 1;

export interface OpenPolicyInput {
  readonly tenantId: string;
  readonly storeId: string;
  /** The open's POS-clock instant (RFC 3339). */
  readonly openedAt: string;
  readonly shiftCurrencyCode: string;
  readonly frozen: FrozenPolicyFact;
}

/**
 * The instants to test in [from, to]: `from`, and each change of the store's
 * effective policy inside the window together with the instant just before
 * it, so a policy in force up to a change exactly at `from` (its closed end)
 * counts as inside the window.
 */
function probePoints(history: PolicyHistory, from: number, to: number): number[] {
  const points = [from];
  for (const r of [...history.tenant, ...history.store]) {
    for (const change of [r.createdAt.getTime(), r.effectiveUntil?.getTime()]) {
      if (change === undefined || change < from || change > to) continue;
      points.push(change, change - TICK_MS);
    }
  }
  return points;
}

/** True when `matches` holds for the effective policy at some instant of the skew window. */
function effectiveInWindow(history: PolicyHistory, openedAt: Date, matches: (p: ResolvedPolicy) => boolean): boolean {
  const from = openedAt.getTime() - OPEN_SKEW_MS;
  const to = openedAt.getTime() + OPEN_SKEW_MS;
  return probePoints(history, from, to).some((t) => matches(effectiveAt(history, new Date(t))));
}

function isUnknownFor(frozen: FrozenPolicyFact, storeId: string, revision: StoredRevision | null): boolean {
  return (
    revision === null ||
    revision.kind === "clear" ||
    revision.scope !== frozen.policySource ||
    (revision.scope === "store" && revision.storeId !== storeId)
  );
}

export class OpenPolicyFlagger {
  constructor(private readonly repo: PolicyRepository = new PolicyRepository()) {}

  /** The flags of `input.frozen`, in the contract's order. Runs on the open's tenant-scoped client. */
  async flags(client: PoolClient, input: OpenPolicyInput): Promise<PolicyFlag[]> {
    const { frozen } = input;
    const found = new Set<PolicyFlag>();
    if (frozen.policySource === "tenant" || frozen.policySource === "store") {
      await this.revisionFlags(client, input, found);
    } else if (frozen.policySource === "system") {
      if (!(await this.wasEffective(client, input, (p) => p.policySource === "system"))) {
        found.add("policy_revision_superseded");
      }
      if (!samePolicyValue(frozen.policyValue, SYSTEM_DEFAULT)) found.add("policy_value_mismatch");
    }
    const value = frozen.policyValue;
    if (value.mode === "limit" && value.currencyCode !== input.shiftCurrencyCode) found.add("policy_value_mismatch");
    return (["policy_revision_unknown", "policy_revision_superseded", "policy_value_mismatch"] as const).filter((f) =>
      found.has(f),
    );
  }

  private async revisionFlags(client: PoolClient, input: OpenPolicyInput, found: Set<PolicyFlag>): Promise<void> {
    const id = input.frozen.policyRevisionId as string;
    const revision = await this.repo.find(client, input.tenantId, id);
    if (isUnknownFor(input.frozen, input.storeId, revision)) {
      found.add("policy_revision_unknown");
      return;
    }
    if (!(await this.wasEffective(client, input, (p) => p.policyRevisionId === id))) found.add("policy_revision_superseded");
    if (!revision?.value || !samePolicyValue(input.frozen.policyValue, revision.value)) {
      found.add("policy_value_mismatch");
    }
  }

  private async wasEffective(
    client: PoolClient,
    input: OpenPolicyInput,
    matches: (p: ResolvedPolicy) => boolean,
  ): Promise<boolean> {
    const openedAt = new Date(input.openedAt);
    const until = new Date(openedAt.getTime() + OPEN_SKEW_MS);
    const history: PolicyHistory = {
      tenant: await this.repo.history(client, { tenantId: input.tenantId, storeId: null }, until),
      store: await this.repo.history(client, { tenantId: input.tenantId, storeId: input.storeId }, until),
    };
    return effectiveInWindow(history, openedAt, matches);
  }
}
