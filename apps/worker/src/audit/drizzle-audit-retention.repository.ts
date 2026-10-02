import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { AuditRetentionRepository } from "./audit-retention.processor";

/**
 * CTE-based UPDATE: selects candidates in a deterministic order (occurred_at
 * ASC, id ASC) so repeated runs over the same data are stable, then marks
 * exactly batchSize rows per call.  Only retention_marked_at is written —
 * all audit fact columns remain untouched.
 */
const MARK_BATCH_SQL = `
WITH candidate AS (
  SELECT id
  FROM audit_events
  WHERE occurred_at < $1
    AND retention_marked_at IS NULL
  ORDER BY occurred_at ASC, id ASC
  LIMIT $3
)
UPDATE audit_events
SET retention_marked_at = $2
WHERE id IN (SELECT id FROM candidate)
RETURNING id
`;

@Injectable()
export class DrizzleAuditRetentionRepository implements AuditRetentionRepository {
  constructor(private readonly pool: Pool) {}

  async markBatch(cutoff: Date, markedAt: Date, batchSize: number): Promise<number> {
    // audit_events is FORCE RLS: without a GUC the sweep sees no rows and
    // marks nothing (RT-120 C-7). Run in the platform-admin context so the
    // policy's is_platform_admin branch covers every tenant in one sweep —
    // the same boundary as the outbox retention purge. The role's own
    // privileges still apply (column-scoped UPDATE for audit_retention_worker),
    // and 0034 allows only this one-time marker write (RT-123).
    return runWithTenantContext(
      this.pool,
      { tenantId: null, isPlatformAdmin: true },
      async (client) => {
        const result = await client.query<{ id: string }>(
          MARK_BATCH_SQL,
          [cutoff, markedAt, batchSize],
        );
        return result.rows.length;
      },
    );
  }
}

/**
 * No-op implementation for dev/test environments without DATABASE_URL.
 * Paired with NoOpWorkerFactory — no jobs flow on this path.
 */
@Injectable()
export class NoOpAuditRetentionRepository implements AuditRetentionRepository {
  async markBatch(_cutoff: Date, _markedAt: Date, _batchSize: number): Promise<number> {
    return 0;
  }
}
