/**
 * The AI entitlement audit rows (AD-AI-ENT-001 D-2, D-5; RT-644 §4.7, T20) —
 * written in the same transaction as the change they record (the
 * `cash_variance_policy.changed` precedent), never by the async interceptor.
 * Ids, enum values, versions, counts and the short reason only (no PII by
 * contract).
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

export const REVISION_PUBLISHED_ACTION = "ai_entitlement.revision_published";
export const OPT_OUT_CHANGED_ACTION = "ai_entitlement.opt_out_changed";
export const USAGE_ADJUSTED_ACTION = "ai_usage.adjusted";

export interface AuditRow {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export async function insertAiAudit(client: PoolClient, row: AuditRow): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, $3, NULL, $4, $5, $6, $7, $8::jsonb)`,
    [newId(), row.actorUserId, row.tenantId, row.action, row.targetType, row.targetId, row.requestId, JSON.stringify(row.metadata)],
  );
}
