/**
 * T584 — `audit.event.created` outbox consumer.
 *
 * Reads an `audit.event.created` outbox event and enqueues it to the
 * existing BullMQ "audit" queue as an "audit-fanout" job. The downstream
 * `AuditFanoutProcessor` (already wired in `WorkerModule`) consumes that
 * queue and persists the `audit_events` row — the flow is unchanged.
 *
 * What changes in T583/T584
 * -------------------------
 * BEFORE: `AuditEmitterInterceptor` → `AuditQueueProducer.enqueue()`
 *                                    → BullMQ "audit" queue directly.
 * AFTER:  `AuditEmitterInterceptor` → `OutboxAuditEnqueuer.enqueue()`
 *                                    → outbox_events row (T583)
 *         DrainerProcessor polls → claims row → AuditEventCreatedConsumer.handle()
 *                                    → BullMQ "audit" queue (this file)
 *
 * The audit fanout consumer (T584) is the bridge back to the existing
 * `AuditFanoutProcessor` which is already correct and tested.
 *
 * Payload shape
 * -------------
 * The outbox event payload is the `AuditJobPayload` (minus traceContext, which
 * is added at BullMQ enqueue time). The consumer validates the payload with
 * Zod before enqueuing. Validation failures are treated as poison-message
 * failures so the event dead-letters after 8 attempts rather than silently
 * dropping or retrying forever.
 *
 * BullMQ queue seam
 * -----------------
 * The consumer depends on a `AuditQueueLike` seam (same interface as
 * `AuditQueueProducer`) so unit tests can inject a spy without Redis.
 * The production instance is wired by `OutboxModule`.
 *
 * No jobId — mirrors the existing `AuditQueueProducer` which explicitly
 * omits `jobId` per FR-AUDIT-1 (every audit emission must produce a distinct row).
 *
 * Tenant context
 * --------------
 * This consumer does NOT need to establish tenant context for the BullMQ
 * `Queue.add()` call — Redis is not RLS-guarded. The downstream
 * `AuditFanoutProcessor` handles tenant context via `DrizzleAuditDbAdapter` +
 * `insertAuditEvent` (which calls `runWithTenantContext`). Establishing
 * tenant context here would be premature and incorrect (the queue.add is
 * not a DB operation).
 */
import { z } from "zod";
import type { OutboxConsumer, OutboxEventEnvelope } from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Payload schema (mirrors AuditFanoutJobSchema in audit-fanout.processor.ts)
// ---------------------------------------------------------------------------

/**
 * The outbox payload for `audit.event.created`.
 * Mirrors `AuditJobPayload` from `apps/api/src/audit/audit-job.types.ts`
 * without importing across app boundaries.
 */
const AuditEventCreatedPayloadSchema = z.object({
  actor_user_id: z.string().uuid().nullable(),
  actor_label:   z.string().nullable(),
  tenant_id:     z.string().uuid().nullable(),
  store_id:      z.string().uuid().nullable(),
  action:        z.string().min(1),
  target_type:   z.string().nullable(),
  target_id:     z.string().uuid().nullable(),
  request_id:    z.string().nullable(),
  metadata:      z.unknown().nullable(),
});

export type AuditEventCreatedPayload = z.infer<typeof AuditEventCreatedPayloadSchema>;

// ---------------------------------------------------------------------------
// BullMQ queue seam
// ---------------------------------------------------------------------------

/**
 * Minimal queue surface — mirrors `AuditQueueLike` from
 * `apps/api/src/audit/audit-queue.producer.ts` (no cross-app import).
 */
export interface AuditQueueLike {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
}

/** BullMQ queue name and job name — mirrors the producer/processor constants. */
export const OUTBOX_AUDIT_QUEUE_NAME = "audit";
export const OUTBOX_AUDIT_JOB_NAME = "audit-fanout";

/**
 * The NIL UUID — in-process sentinel for a platform-scoped outbox row.
 * Migration 0031 stores SQL NULL on `outbox_events.tenant_id` (the nil
 * UUID is not a tenant, so it cannot satisfy the foreign key). The claim
 * path presents that NULL as NIL_UUID. `AuditFanoutProcessor` expects
 * `tenant_id: string | null` and treats `null` as platform-scoped, so
 * NIL_UUID is mapped back to `null` when enqueuing the BullMQ job.
 */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

/**
 * Consumer ID string. Stable per lifecycle.md §5 — will become the primary
 * key column in the future `processed_events` dedup table (Slice 1C).
 */
export const AUDIT_EVENT_CREATED_CONSUMER_ID = "worker.audit.event.created";

export class AuditEventCreatedConsumer implements OutboxConsumer<AuditEventCreatedPayload> {
  readonly consumerId = AUDIT_EVENT_CREATED_CONSUMER_ID;
  readonly eventType = "audit.event.created";

  constructor(private readonly auditQueue: AuditQueueLike) {}

  async handle(event: OutboxEventEnvelope<AuditEventCreatedPayload>): Promise<void> {
    // Validate the payload shape before enqueuing — treat schema violations
    // as poison events so they dead-letter rather than propagating bad data.
    const parsed = AuditEventCreatedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const detail = first
        ? `${first.path.join(".") || "<root>"}: ${first.message}`
        : "validation failed";
      throw new Error(`AuditEventCreatedConsumer: malformed payload — ${detail}`);
    }

    // The OUTBOX ENVELOPE — not the payload — is the source of truth for
    // tenant_id and store_id. The payload arrived as JSONB from whatever
    // produced the outbox row, and a future producer bug (or a malicious
    // call path that bypasses tenant-context guards) could set those fields
    // to a different tenant than the one the row is scoped to. Honouring
    // payload tenant_id over envelope tenant_id would let a row land in
    // tenant A while writing the audit_events row for tenant B.
    //
    // We therefore:
    //   - Override the BullMQ job's `tenant_id` with `event.tenant_id`,
    //     mapping NIL_UUID back to null so the existing platform-scoped
    //     contract is preserved (AuditFanoutProcessor reads `null` as
    //     "platform-scoped").
    //   - Override `store_id` with `event.store_id` unconditionally — the
    //     envelope value is `string | null`, already the right shape.
    //   - Carry `correlation_id` as `request_id` only when the payload
    //     omits one (existing contract).
    const authoritativeTenantId =
      event.tenant_id === NIL_UUID ? null : event.tenant_id;

    await this.auditQueue.add(OUTBOX_AUDIT_JOB_NAME, {
      ...parsed.data,
      tenant_id:  authoritativeTenantId,
      store_id:   event.store_id,
      request_id: parsed.data.request_id ?? event.correlation_id,
    });
  }
}
