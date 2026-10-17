/**
 * The shift variance policy's audit rows (AD-CASH-001 D-9; contract "Audit").
 *
 * `cash_variance_policy.changed`: one row per revision, written in the
 * publish transaction (never by the async `AuditEmitterInterceptor`), with the
 * actor, the tenant, the store of an override, the old and new value, the
 * reason, the revision id, `effectiveFrom` / `effectiveUntil` and the approver.
 * Ids, values and the short `reason` (documented "no PII") only.
 */
import type { PoolClient } from "pg";

import { deterministicId, newId } from "@data-pulse-2/shared";

import type { PolicyValue } from "./policy-value";
import type { StoredRevision } from "./policy.repository";

export const POLICY_CHANGED_ACTION = "cash_variance_policy.changed";
export const POLICY_REVISION_TARGET = "cash_variance_policy_revision";

export interface PolicyChangedAudit {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly revision: StoredRevision;
  /** The scope's value before this revision (the tenant level, or the active override / null). */
  readonly oldValue: PolicyValue | null;
}

export async function insertPolicyChangedAudit(client: PoolClient, audit: PolicyChangedAudit): Promise<void> {
  const r = audit.revision;
  const metadata = {
    scope: r.scope,
    kind: r.kind,
    revision_id: r.id,
    old_value: audit.oldValue,
    new_value: r.value,
    reason: r.reason,
    effective_from: r.createdAt.toISOString(),
    effective_until: r.effectiveUntil?.toISOString() ?? null,
    permanent: r.permanent,
    approved_by_user_id: r.approvedByUserId,
  };
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      newId(),
      audit.actorUserId,
      audit.tenantId,
      r.storeId,
      POLICY_CHANGED_ACTION,
      POLICY_REVISION_TARGET,
      r.id,
      audit.requestId,
      JSON.stringify(metadata),
    ],
  );
}

export const OVERRIDE_EXPIRED_ACTION = "cash_variance_policy.override_expired";

/** Namespace of the expiry audit's deterministic id (one row per expired revision). */
const OVERRIDE_EXPIRED_NAMESPACE = "6f0b8a0e-3c1d-5e7a-9b42-7c3d2e1f0a87";

export interface OverrideExpiredAudit {
  readonly tenantId: string;
  readonly expired: StoredRevision;
  /** The store's effective policy from the expiry instant on. */
  readonly effective: { readonly policySource: string; readonly policyRevisionId: string | null };
}

/**
 * `cash_variance_policy.override_expired`, written exactly once per expired
 * override (AD-CASH-001 D-9; the mechanism is RT-387's). It is written lazily
 * by the first resolution of the store that sees the expiry (the POS policy
 * read, a Console read or publish), with an id derived from the expired
 * revision, so every later attempt is a no-op conflict. Its content depends
 * only on the revision history (the effective policy is resolved at
 * `effectiveUntil`), never on when it is written. No actor: the clock expired
 * it.
 */
export async function insertOverrideExpiredAudit(client: PoolClient, audit: OverrideExpiredAudit): Promise<void> {
  const r = audit.expired;
  const metadata = {
    expired_revision_id: r.id,
    effective_until: r.effectiveUntil?.toISOString() ?? null,
    effective_policy_source: audit.effective.policySource,
    effective_policy_revision_id: audit.effective.policyRevisionId,
  };
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata,
        occurred_at)
     VALUES ($1, NULL, 'system', $2, $3, $4, $5, $6, NULL, $7::jsonb, $8)
     ON CONFLICT DO NOTHING`,
    [
      deterministicId(OVERRIDE_EXPIRED_NAMESPACE, r.id),
      audit.tenantId,
      r.storeId,
      OVERRIDE_EXPIRED_ACTION,
      POLICY_REVISION_TARGET,
      r.id,
      JSON.stringify(metadata),
      r.effectiveUntil,
    ],
  );
}
