/**
 * DP-008-LIVELOOP — `sale.captured` outbox consumer.
 *
 * Reads a `sale.captured` outbox event and enqueues it to the existing
 * BullMQ "sale-processing" queue as a "sale-processing" job. The downstream
 * `SaleProcessingProcessor` (consumed by `SaleWorker`, wired in `WorkerModule`)
 * does the off-request DB write — the flow downstream is unchanged.
 *
 * Where this sits in the live loop
 * ---------------------------------
 *   capture (DEFERRED): `SalesService.captureSale` emits a `sale.captured`
 *                        outbox row inside the capture transaction.
 *   DrainerProcessor polls → claims row → SaleCapturedConsumer.handle()  ← THIS
 *                        → BullMQ "sale-processing" queue.
 *   SaleWorker consumes → SaleProcessingProcessor.process(envelope) → DB UPDATE.
 *
 * This consumer is the clean half of the loop that ships now. The capture-side
 * emit + `SALES_OUTBOX_PRODUCER` binding, the `saleWorker.start()` in `main.ts`,
 * and the sale-processing metrics/DLQ entries are a SEPARATE follow-up slice.
 *
 * Payload shape
 * -------------
 * The outbox payload carries only IDs (`sale_id`, `store_id`) — NO PII, NO
 * money, NO line amounts (FR-042 / FR-092). The consumer validates the payload
 * with Zod before enqueuing. Validation failures are treated as poison-message
 * failures so the event dead-letters after the attempt budget rather than
 * silently dropping or retrying forever (mirrors `AuditEventCreatedConsumer`).
 *
 * Envelope → job mapping
 * ----------------------
 * The OUTBOX ENVELOPE — not the payload — is the source of truth for
 * `tenant_id`: the JSONB payload arrived from whatever produced the row and a
 * future producer bug could set a different tenant than the row is scoped to.
 * Honouring the envelope `tenant_id` keeps the job scoped to the row's tenant.
 * `sale_id` / `store_id` come from the payload (the envelope `store_id` is
 * nullable; the sale-processing job requires a concrete store scope). The
 * downstream `SaleProcessingProcessor.assertJob` is the UUID validation
 * boundary for the resulting job; the Zod schema here guards the payload shape.
 *
 * Tenant context
 * --------------
 * This consumer does NOT establish tenant context — Redis is not RLS-guarded
 * and `Queue.add()` is not a DB operation. The drainer holds tenant context
 * for the outbox row; the downstream `SaleProcessingProcessor` establishes
 * `app.current_tenant` via `runWithTenantContext` before its DB write.
 *
 * No DB access
 * ------------
 * `handle()` performs ZERO DB work — it only maps the envelope to a job and
 * enqueues it.
 */
import { z } from "zod";
import type { OutboxConsumer, OutboxEventEnvelope } from "@data-pulse-2/shared";
import { QUEUE_NAMES } from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Payload schema — IDs only (no PII / money / line amounts; FR-042 / FR-092)
// ---------------------------------------------------------------------------

/**
 * The outbox payload for `sale.captured`. Carries the identifiers the
 * downstream `SaleProcessingProcessor` needs to resolve the sale within its
 * (tenant, store) scope. The authoritative `tenant_id` comes from the
 * envelope, not the payload (see file docstring).
 */
const SaleCapturedPayloadSchema = z.object({
  sale_id:  z.string().uuid(),
  store_id: z.string().uuid(),
});

export type SaleCapturedPayload = z.infer<typeof SaleCapturedPayloadSchema>;

// ---------------------------------------------------------------------------
// BullMQ queue seam
// ---------------------------------------------------------------------------

/**
 * Minimal queue surface — mirrors `AuditQueueLike` from
 * `audit-event-created.consumer.ts`. Lets unit tests inject a spy with no Redis.
 */
export interface SaleProcessingQueueLike {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
}

/**
 * BullMQ queue name + job name. The queue name MUST match
 * `SALE_PROCESSING_QUEUE_NAME` in `apps/worker/src/sales/sale.worker.ts` — that
 * is the transport channel the `SaleWorker` consumes. The job name is the BullMQ
 * job identifier; the `SaleProcessingJob` envelope shape is the actual contract.
 */
export const OUTBOX_SALE_PROCESSING_QUEUE_NAME = QUEUE_NAMES.saleProcessing;
export const OUTBOX_SALE_PROCESSING_JOB_NAME = "sale-processing";

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

/**
 * Consumer ID string. Stable per lifecycle.md §5 — will become a primary-key
 * column in the future `processed_events` dedup table (Slice 1C). Follows the
 * `<domain>.<event_type>` convention, matching `worker.audit.event.created`.
 */
export const SALE_CAPTURED_CONSUMER_ID = "worker.sale.captured";

export class SaleCapturedConsumer implements OutboxConsumer<SaleCapturedPayload> {
  readonly consumerId = SALE_CAPTURED_CONSUMER_ID;
  readonly eventType = "sale.captured";

  constructor(private readonly saleProcessingQueue: SaleProcessingQueueLike) {}

  async handle(event: OutboxEventEnvelope<SaleCapturedPayload>): Promise<void> {
    // Validate the payload shape before enqueuing — treat schema violations as
    // poison events so they dead-letter rather than propagating bad data.
    const parsed = SaleCapturedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const detail = first
        ? `${first.path.join(".") || "<root>"}: ${first.message}`
        : "validation failed";
      throw new Error(`SaleCapturedConsumer: malformed payload — ${detail}`);
    }

    // Deterministic BullMQ jobId for at-least-once dedup. Outbox delivery is
    // at-least-once; if the same row is re-delivered (e.g. the drainer crashes
    // after enqueuing but before marking the row delivered) handle() runs
    // again. A stable jobId derived from the OUTBOX EVENT IDENTITY
    // (`<consumerId>-<event_id>`) maps every re-delivery of the same row to the
    // SAME BullMQ job, so a re-delivered row does not enqueue a second job.
    // This is hardening on top of the downstream `WHERE processed_at IS NULL`
    // guard — not a replacement for it.
    //
    // The separator MUST be '-', never ':' — BullMQ 5.x rejects custom jobIds
    // containing ':' (`Custom Id cannot contain :`), which failed every
    // sale.captured event in RT-9 (RT-44). Same fix as EmailQueueProducer (#288).
    //
    // AuditEventCreatedConsumer keys its jobId on the outbox event_id too
    // (RT-124). Sales must NOT double-process, so keep this jobId
    // deterministic.
    const jobId = `${SALE_CAPTURED_CONSUMER_ID}-${event.event_id}`;

    // Map the outbox envelope → SaleProcessingJob. The ENVELOPE is the source
    // of truth for tenant_id (a tampered payload tenant_id must not redirect
    // the job); sale_id / store_id come from the validated payload. The
    // downstream SaleProcessingProcessor.assertJob re-validates the UUIDs and
    // owns the DB write under tenant context — this consumer does NO DB work.
    await this.saleProcessingQueue.add(
      OUTBOX_SALE_PROCESSING_JOB_NAME,
      {
        saleId:        parsed.data.sale_id,
        tenantId:      event.tenant_id,
        storeId:       parsed.data.store_id,
        correlationId: event.correlation_id,
      },
      { jobId },
    );
  }
}
