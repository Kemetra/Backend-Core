/**
 * 015 — `erpnext.posting.requested` outbox consumer.
 *
 * Reads an `erpnext.posting.requested` outbox event (emitted in-transaction by
 * the 008 `SaleProcessingProcessor` when a sale becomes processed) and, at this
 * CREATION moment, resolves posting ELIGIBILITY (015-RESOLVE) and inserts the
 * `erpnext_posting_status` row:
 *   - every line resolves to a CONFIRMED erpnext_item_map AND the store maps to
 *     an erpnext_warehouse_map → `pending` (the connector feed will offer it);
 *   - otherwise → `permanently_rejected` with the nearest 012 category
 *     (`unmapped_item` / `unmapped_store`), BEFORE the work-item is ever offered
 *     (rider R2 "fails-to-DLQ before offered"). The 008 sale fact is NEVER
 *     mutated; the failure is a reconciliation case (017), never routed to the
 *     inbound unknown-items queue (rider R4).
 *
 * DEVIATION from SaleCaptured/AuditEventCreated (which bridge to a BullMQ queue):
 * this consumer does the resolve+insert DB work DIRECTLY. There is no
 * pre-existing downstream processor to hand off to, and the outbox layer already
 * gives at-least-once + retry-budget + dead-letter — a second BullMQ hop would be
 * redundant retry, not added safety. The consumer takes a `Pool` and establishes
 * its own tenant context via `runWithTenantContext` (the OutboxConsumer contract
 * mandates this for DB access).
 *
 * Idempotency (at-least-once): if the drainer crashes after the insert but before
 * marking the row delivered, `handle()` re-runs. The INSERT is
 * `ON CONFLICT (tenant_id, source_ref_id) DO NOTHING` (the O-3 unique), so a
 * re-delivery is a no-op and the FIRST verdict stands — never a throw-then-
 * dead-letter loop.
 *
 * Ordering (RT-173, RT-83 option 2 — defense in depth): a reversal's
 * `erpnext.posting.requested` is emitted in the void/refund/return transaction,
 * but its sale's `sale_post` event only comes later from the async
 * sale-processing drain, and the drainer runs a batch concurrently. So a
 * reversal row is created ONLY once its sale's `sale_post` row exists (any
 * status). Until then `handle()` inserts nothing and throws the retryable
 * `ReversalAwaitingSalePostError`; the outbox backoff / dead-letter rules apply.
 * `sequence` is an identity drawn at INSERT, and the check only sees a COMMITTED
 * sale_post row, so the reversal's sequence is always greater than its
 * sale_post's. This does not cover a sale_post that is later re-headed after a
 * `failed_transient` ack (the Connector side, RT-83 option 1, covers that).
 *
 * Dead-letter visibility (RT-207): if the sale_post row never appears, the
 * reversal's outbox row dead-letters after its last attempt. That dead-lettered
 * outbox row is the record of truth (no synthetic posting-status row is
 * written). On that final attempt the consumer increments the unlabeled
 * `erpnext_posting_reversal_deferred_dead_letter_total` and writes one
 * structured `posting.reversal.dead_lettered` error log (identifiers only), so
 * operations can alert on it. The final attempt is decided by the drainer's own
 * rule (`isFinalOutboxAttempt`).
 *
 * Payload shape: IDs + provenance only (sale_id / store_id / kind / source_ref_id)
 * — NO money / PII. The ENVELOPE tenant_id is authoritative (a tampered payload
 * tenant must not redirect the write).
 */
import { z } from "zod";
import { runWithTenantContext } from "@data-pulse-2/db";
import {
  createLogger,
  newId,
  type Logger,
  type OutboxConsumer,
  type OutboxEventEnvelope,
} from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import {
  recordErpnextPostingReconciliation,
  recordErpnextPostingReversalDeferredDeadLetter,
} from "../observability/metrics/worker.metrics";
import { isFinalOutboxAttempt } from "../outbox/drainer.processor";

// ---------------------------------------------------------------------------
// Payload schema — IDs + provenance only (no PII / money)
// ---------------------------------------------------------------------------

const PostingRequestedPayloadSchema = z.object({
  sale_id: z.string().uuid(),
  store_id: z.string().uuid(),
  kind: z.enum(["sale_post", "reversal"]),
  source_ref_id: z.string().uuid(),
});

export type PostingRequestedPayload = z.infer<
  typeof PostingRequestedPayloadSchema
>;

export const POSTING_REQUESTED_CONSUMER_ID = "worker.erpnext.posting.requested";

type RejectionCategory = "unmapped_item" | "unmapped_store";

/**
 * RT-173: thrown for a reversal whose sale has no `sale_post` posting-status row
 * yet. Retryable — the drainer marks the outbox row failed with backoff and
 * records this class name (never the message) as the error class.
 */
export class ReversalAwaitingSalePostError extends Error {
  constructor() {
    super("reversal deferred: the sale's sale_post posting row does not exist yet");
    this.name = "ReversalAwaitingSalePostError";
  }
}

/** Log seam (tests inject one); production uses the shared pino logger. */
export type PostingRequestedLogger = Pick<Logger, "warn" | "error">;

function defaultLogger(): PostingRequestedLogger {
  return createLogger({ service: "worker", bindings: { component: POSTING_REQUESTED_CONSUMER_ID } });
}

export class PostingRequestedConsumer
  implements OutboxConsumer<PostingRequestedPayload>
{
  readonly consumerId = POSTING_REQUESTED_CONSUMER_ID;
  readonly eventType = "erpnext.posting.requested";

  private readonly logger: PostingRequestedLogger;

  constructor(
    private readonly pool: Pool,
    logger?: PostingRequestedLogger,
  ) {
    this.logger = logger ?? defaultLogger();
  }

  async handle(
    event: OutboxEventEnvelope<PostingRequestedPayload>,
  ): Promise<void> {
    const parsed = PostingRequestedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const detail = first
        ? `${first.path.join(".") || "<root>"}: ${first.message}`
        : "validation failed";
      throw new Error(
        `PostingRequestedConsumer: malformed payload — ${detail}`,
      );
    }
    const { sale_id, store_id, kind, source_ref_id } = parsed.data;
    // The ENVELOPE tenant is authoritative (not the payload).
    const tenantId = event.tenant_id;

    await runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        if (kind === "reversal") {
          await this.assertSalePostExists(client, event, parsed.data);
        }

        const verdict = await this.resolveEligibility(client, {
          saleId: sale_id,
          storeId: store_id,
        });

        // Conflict-safe insert (O-3 unique on (tenant_id, source_ref_id)): a
        // re-delivery is a no-op; the first verdict stands. RETURNING id tells
        // us whether THIS call inserted (vs a no-op re-delivery) so the §VII
        // reconciliation signal fires exactly once per dead-lettered row.
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO erpnext_posting_status
             (id, tenant_id, store_id, sale_id, kind, source_ref_id,
              source_system, external_id, payload_hash, status,
              rejection_category, correlation_id)
           SELECT $1, $2, $3, $4, $5, $6,
                  s.source_system, s.external_id, s.payload_hash, $7, $8, $9
             FROM sales s
            WHERE s.id = $4 AND s.store_id = $3
           ON CONFLICT (tenant_id, source_ref_id) DO NOTHING
           RETURNING id`,
          [
            newId(),
            tenantId,
            store_id,
            sale_id,
            kind,
            source_ref_id,
            verdict.status,
            verdict.status === "permanently_rejected"
              ? verdict.rejectionCategory
              : null,
            event.correlation_id,
          ],
        );

        // §VII reconciliation / DLQ signal — a posting dead-lettered at
        // 015-RESOLVE creation time. Fires only on a FRESH insert of a
        // permanently_rejected row (rowCount > 0), so a re-delivery no-op does
        // not double-count. A SIGNAL: never alters the insert outcome.
        if (
          (inserted.rowCount ?? 0) > 0 &&
          verdict.status === "permanently_rejected"
        ) {
          recordErpnextPostingReconciliation();
        }
      },
    );
  }

  /**
   * RT-173: a reversal row may only be created after its sale's `sale_post` row
   * exists (any status — a permanently_rejected sale_post still counts). Scoped
   * to the ENVELOPE tenant (RLS + explicit predicate). A sale_post's
   * source_ref_id IS its sale id (data-model §5), so the lookup is a point read
   * on the O-3 unique index (tenant_id, source_ref_id).
   */
  private async assertSalePostExists(
    client: PoolClient,
    event: OutboxEventEnvelope<PostingRequestedPayload>,
    payload: PostingRequestedPayload,
  ): Promise<void> {
    const { sale_id, store_id, source_ref_id } = payload;
    const found = await client.query(
      `SELECT 1 FROM erpnext_posting_status
        WHERE tenant_id = $1 AND source_ref_id = $2 AND sale_id = $2
          AND kind = 'sale_post'`,
      [event.tenant_id, sale_id],
    );
    if ((found.rowCount ?? 0) > 0) return;

    // §VII signal — identifiers only (no money / PII), once per deferred attempt.
    this.logger.warn(
      {
        event: "posting.reversal.deferred",
        tenant_id: event.tenant_id,
        sale_id,
        source_ref_id,
        attempts: event.attempts,
      },
      "reversal deferred: sale_post row not created yet",
    );

    // RT-207: this is the last attempt, so the drainer dead-letters the outbox
    // row on the throw below. Count it once and log it once — identifiers only
    // as log fields (never metric labels), no payload / money / PII. The
    // signals.md §4 async-work fields are included: request_id is the job's
    // unique id (the outbox event); correlation_id is null when absent.
    if (isFinalOutboxAttempt(event.attempts)) {
      recordErpnextPostingReversalDeferredDeadLetter();
      this.logger.error(
        {
          event: "posting.reversal.dead_lettered",
          outcome: "failure",
          request_id: event.event_id,
          correlation_id: event.correlation_id ?? null,
          tenant_id: event.tenant_id,
          store_id,
          sale_id,
          source_ref_id,
          event_id: event.event_id,
          attempts: event.attempts,
        },
        "reversal dead-lettered: its sale_post row never appeared",
      );
    }
    throw new ReversalAwaitingSalePostError();
  }

  /**
   * 015-RESOLVE at creation time. Read-only; the caller persists the verdict.
   * Mirrors the api-side `posting-work-item.projection.ts` resolution (kept in
   * SQL so the worker need not import api code).
   */
  private async resolveEligibility(
    client: PoolClient,
    input: { saleId: string; storeId: string },
  ): Promise<
    | { status: "pending" }
    | { status: "permanently_rejected"; rejectionCategory: RejectionCategory }
  > {
    // (a) store → an active warehouse mapping (rider R5: never guess).
    const wh = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM erpnext_warehouse_map
        WHERE store_id = $1 AND retired_at IS NULL`,
      [input.storeId],
    );
    if (Number(wh.rows[0]?.count ?? "0") === 0) {
      return { status: "permanently_rejected", rejectionCategory: "unmapped_store" };
    }

    // (b) every line → a CONFIRMED, non-retired item map; a null tenant_product_ref
    // (ad-hoc, FR-004) or only a `suggested` map counts as unmapped (R3).
    const unmapped = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM sale_lines sl
         LEFT JOIN erpnext_item_map m
           ON m.tenant_product_id = sl.tenant_product_ref
          AND m.state = 'confirmed'
          AND m.retired_at IS NULL
        WHERE sl.sale_id = $1
          AND (sl.tenant_product_ref IS NULL OR m.id IS NULL)`,
      [input.saleId],
    );
    if (Number(unmapped.rows[0]?.count ?? "0") > 0) {
      return { status: "permanently_rejected", rejectionCategory: "unmapped_item" };
    }

    return { status: "pending" };
  }
}
