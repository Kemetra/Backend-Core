/**
 * The payer-account update's audit row (`settlement.yaml` 2.1.0, RT-572).
 *
 * `settlement.payer_account.updated`: one row per EFFECTIVE update, written on
 * the update's own transaction (never by the async `AuditEmitterInterceptor`:
 * `@Auditable` fires per request, including a no-op and every refusal, and
 * cannot roll the update back). A failed insert fails the whole update.
 *
 * `store_id` is the payer's store, NULL for a tenant-wide payer (a tenant-level
 * event), which is why this does not reuse `insertSettlementAudit` (its
 * `storeId` is required). Metadata: field names, versions, and the status and
 * ERPNext Customer link before / after (opaque identifiers, business-class, not
 * PII per migration 0051). It never carries the display name (§XIV).
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

export const PAYER_UPDATED_ACTION = "settlement.payer_account.updated";
export const PAYER_AUDIT_TARGET = "payer_account";

export interface PayerUpdatedAudit {
  readonly tenantId: string;
  /** The payer's store; null for a tenant-wide payer. */
  readonly storeId: string | null;
  readonly actorUserId: string | null;
  readonly requestId: string | null;
  readonly payerId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export async function insertPayerUpdatedAudit(client: PoolClient, audit: PayerUpdatedAudit): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      newId(),
      audit.actorUserId,
      audit.tenantId,
      audit.storeId,
      PAYER_UPDATED_ACTION,
      PAYER_AUDIT_TARGET,
      audit.payerId,
      audit.requestId,
      JSON.stringify(audit.metadata),
    ],
  );
}
