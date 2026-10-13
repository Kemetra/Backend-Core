/**
 * drizzle-outbox-retention.repository.ts -- T590 production repository.
 *
 * Two implementations:
 *
 *   DrizzleOutboxRetentionRepository -- real pg.Pool-backed repo. Wraps each
 *     batched DELETE in `runWithTenantContext({ tenantId: null,
 *     isPlatformAdmin: true })` so the platform-admin OR-branch of the
 *     outbox_events RLS policy grants visibility across every tenant.
 *
 *   NoOpOutboxRetentionRepository -- dev/test fallback for the safe path
 *     where AuditDbPool.pool is null. Paired with NoOpWorkerFactory: no
 *     jobs flow, no rows are touched. Mirrors NoOpAuditRetentionRepository.
 *
 * SQL contract
 * ------------
 * The DELETE pins the same three-branch retention predicate locked by
 * packages/db/__tests__/outbox/retention.spec.ts (ELIGIBLE_SQL constant):
 *
 *   - delivered + event_type <> 'audit.event.created' + processed_at < $1
 *   - delivery_state IN ('failed','dead_lettered')
 *     + COALESCE(processed_at, updated_at) < $2
 *   - delivered + event_type = 'audit.event.created' + processed_at < $2
 *
 * Where $1 = deliveredCutoff (90 days ago) and $2 = failedCutoff (365 days
 * ago). Active rows (pending/claimed) are excluded by construction.
 *
 * The inner candidate SELECT uses `FOR UPDATE SKIP LOCKED LIMIT $3` so:
 *   - Concurrent drainer ticks (which also use FOR UPDATE SKIP LOCKED on
 *     the same table) are NOT blocked -- the two pick disjoint row sets.
 *   - Concurrent retention sweeps across replicas converge without
 *     double-deleting; each replica processes a disjoint batch.
 *
 * The outer DELETE uses `WHERE event_id IN (SELECT ...)` rather than a
 * direct `DELETE ... FOR UPDATE` because Postgres does not support FOR
 * UPDATE on DELETE statements directly -- the inner select grabs the
 * locks, the outer DELETE executes against the locked id set.
 *
 * Ordering by `occurred_at ASC` so the oldest eligible rows are purged
 * first; this is deterministic across runs and makes operator
 * observability ("which row class was purged first?") predictable.
 *
 * Payload is NEVER read. The predicate keys on delivery_state, event_type,
 * processed_at, and updated_at only -- the right-to-erasure pass-through
 * contract (retention.spec.ts RT-4) is preserved.
 */
import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { OutboxRetentionRepository } from "./retention.processor";
import { AUDIT_EVENT_TYPE, type RetentionCutoffs } from "./retention.policy";

/**
 * Pinned SQL. The three-branch predicate exactly matches the ELIGIBLE_SQL
 * constant in packages/db/__tests__/outbox/retention.spec.ts. The inner
 * SELECT uses FOR UPDATE SKIP LOCKED to avoid blocking the drainer's
 * claimBatch path.
 *
 * Parameters:
 *   $1 = deliveredCutoff (now - 90 days)
 *   $2 = failedCutoff    (now - 365 days)
 *   $3 = batchSize
 *   $4 = audit event type sentinel (AUDIT_EVENT_TYPE -- bound, never
 *        interpolated, so the predicate can never drift from the
 *        single source of truth in retention.policy.ts).
 */
const PURGE_BATCH_SQL = `
DELETE FROM outbox_events
 WHERE event_id IN (
   SELECT event_id
     FROM outbox_events
    WHERE (delivery_state = 'delivered'
           AND event_type <> $4
           AND processed_at < $1)
       OR (delivery_state IN ('failed', 'dead_lettered')
           AND COALESCE(processed_at, updated_at) < $2)
       OR (delivery_state = 'delivered'
           AND event_type = $4
           AND processed_at < $2)
    ORDER BY occurred_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT $3
 )
 RETURNING event_id
`;

@Injectable()
export class DrizzleOutboxRetentionRepository implements OutboxRetentionRepository {
  constructor(private readonly pool: Pool) {}

  purgeBatch(
    cutoffs: RetentionCutoffs,
    batchSize: number,
  ): Promise<number> {
    // Platform-admin context so the outbox_events RLS policy's
    // is_platform_admin OR-branch grants visibility across all tenants.
    // This mirrors `claimBatch` in packages/db/src/outbox/repository.ts.
    return runWithTenantContext(
      this.pool,
      { tenantId: null, isPlatformAdmin: true },
      async (client) => {
        const result = await client.query<{ event_id: string }>(
          PURGE_BATCH_SQL,
          [
            cutoffs.deliveredCutoff,
            cutoffs.failedCutoff,
            batchSize,
            AUDIT_EVENT_TYPE,
          ],
        );
        return result.rows.length;
      },
    );
  }
}

/**
 * No-op implementation for dev/test environments where AuditDbPool.pool
 * is null (no DATABASE_URL on a non-prod / no-Redis machine). Paired with
 * NoOpWorkerFactory: no jobs flow, so this method is never actually
 * called in steady state. Mirrors NoOpAuditRetentionRepository.
 */
@Injectable()
export class NoOpOutboxRetentionRepository implements OutboxRetentionRepository {
  async purgeBatch(
    _cutoffs: RetentionCutoffs,
    _batchSize: number,
  ): Promise<number> {
    return 0;
  }
}
