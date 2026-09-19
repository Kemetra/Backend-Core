import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

export interface SettlementAuditInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata?: Record<string, unknown>;
}

/** Persist a required settlement audit fact on the caller's business tx. */
export async function insertSettlementAudit(
  client: PoolClient,
  input: SettlementAuditInput,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action,
        target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      newId(),
      input.actorUserId,
      input.tenantId,
      input.storeId,
      input.action,
      input.targetType,
      input.targetId,
      input.requestId,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}
