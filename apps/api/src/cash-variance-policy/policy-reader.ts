/**
 * The current resolution of the shift variance policy for a tenant or a store
 * (AD-CASH-001 D-2), read on the caller's tenant-scoped client at the
 * transaction's clock. Shared by the device read, the Console reads and the
 * publishes, so every surface answers with the same rule.
 *
 * A store resolution that finds the store's latest revision to be an expired
 * override also records its `cash_variance_policy.override_expired` audit row
 * (once per revision; see `insertOverrideExpiredAudit`). That write never
 * breaks the read: it runs under a SAVEPOINT, and a failure is rolled back to
 * it, logged (identifiers only) and retried, idempotently, by the next
 * resolution of the store.
 */
import type { Logger } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { insertOverrideExpiredAudit } from "./policy-audit";
import { isActiveSet, resolveEffective, tenantLevelAt, type ResolvedPolicy } from "./policy-resolution";
import type { PolicyValue } from "./policy-value";
import { PolicyRepository, type StoredRevision } from "./policy.repository";

/** A store's current policy picture. */
export interface StoreResolution {
  readonly now: Date;
  readonly tenantLevel: ResolvedPolicy;
  readonly latestTenant: StoredRevision | null;
  /** The store's latest revision of any kind or state (the next publish's `expectedRevisionId`). */
  readonly latestStore: StoredRevision | null;
  /** The active override, when the store's latest revision is a `set` still in force. */
  readonly activeOverride: (StoredRevision & { readonly value: PolicyValue }) | null;
  readonly effective: ResolvedPolicy;
}

/** The store's latest revision when it is a `set` still in force at `now`, else null. */
function activeOverrideOf(
  latest: StoredRevision | null,
  now: Date,
): (StoredRevision & { readonly value: PolicyValue }) | null {
  if (latest === null || !isActiveSet(latest, now)) return null;
  return latest as StoredRevision & { readonly value: PolicyValue };
}

/** True for a store `set` (once not active, an expired one). */
function isSet(revision: StoredRevision | null): revision is StoredRevision {
  return revision?.kind === "set";
}

/** The tenant level from the tenant's latest revision. */
export function tenantLevelOf(latestTenant: StoredRevision | null, now: Date): ResolvedPolicy {
  return tenantLevelAt(latestTenant === null ? [] : [latestTenant], now);
}

export class PolicyReader {
  constructor(
    private readonly repo: PolicyRepository = new PolicyRepository(),
    /** Where a failed expiry audit is reported; none in bare tests. */
    private readonly logger?: Pick<Logger, "warn">,
  ) {}

  async tenant(client: PoolClient, tenantId: string): Promise<{ now: Date; latest: StoredRevision | null; level: ResolvedPolicy }> {
    const now = await this.repo.now(client);
    const latest = await this.repo.latest(client, { tenantId, storeId: null });
    return { now, latest, level: tenantLevelOf(latest, now) };
  }

  async store(client: PoolClient, scope: { readonly tenantId: string; readonly storeId: string }): Promise<StoreResolution> {
    const { now, latest: latestTenant, level: tenantLevel } = await this.tenant(client, scope.tenantId);
    const latestStore = await this.repo.latest(client, scope);
    const activeOverride = activeOverrideOf(latestStore, now);
    if (activeOverride === null && isSet(latestStore)) await this.auditExpiry(client, scope.tenantId, latestStore);
    return {
      now,
      tenantLevel,
      latestTenant,
      latestStore,
      activeOverride,
      effective: resolveEffective(tenantLevel, activeOverride),
    };
  }

  /**
   * The expiry audit of `expired` (a store `set` past its `effectiveUntil`):
   * the effective policy from that instant is the tenant level then, since the
   * expired revision is still the store's latest.
   */
  private async auditExpiry(client: PoolClient, tenantId: string, expired: StoredRevision): Promise<void> {
    await client.query("SAVEPOINT cash_variance_policy_expiry_audit");
    try {
      const until = expired.effectiveUntil as Date;
      const tenantHistory = await this.repo.history(client, { tenantId, storeId: null }, until);
      const effective = tenantLevelAt(tenantHistory, until);
      await insertOverrideExpiredAudit(client, { tenantId, expired, effective });
      await client.query("RELEASE SAVEPOINT cash_variance_policy_expiry_audit");
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT cash_variance_policy_expiry_audit");
      this.reportExpiryAuditFailure({ tenantId, storeId: expired.storeId, revisionId: expired.id, err });
    }
  }

  /** One warning with identifiers and the error class only; never throws. */
  private reportExpiryAuditFailure(failure: {
    readonly tenantId: string;
    readonly storeId: string | null;
    readonly revisionId: string;
    readonly err: unknown;
  }): void {
    try {
      this.logger?.warn(
        {
          event: "cash_variance_policy.override_expired.audit_failed",
          tenant_id: failure.tenantId,
          store_id: failure.storeId,
          revision_id: failure.revisionId,
          error_class: failure.err instanceof Error ? failure.err.name : typeof failure.err,
        },
        "override expiry audit not written; the next resolution of the store retries it",
      );
    } catch {
      // A signal only: the read answers either way.
    }
  }
}
