/**
 * SaleProcessingProcessor — 008 WORKER (T082).
 *
 * Off-request sale-processing job. The 008 capture path (US1) writes the
 * immutable sale fact with `processed_at` left NULL and claims it later: heavy
 * processing MUST NOT block the request path (FR-081, §V). This processor is
 * that off-request worker. For one logical sale it:
 *
 *   1. Establishes tenant context (`app.current_tenant`) via
 *      `runWithTenantContext` BEFORE any tenant-scoped DB access — every read
 *      and the UPDATE run under the 008 RLS policies on the app connection
 *      (§II / §V). Skipping this fails RLS (the T561 regression pattern).
 *   2. Recomputes the ADVISORY mismatch flag identically to capture
 *      (`SalesService.captureSale`): a per-line half-up sum compared to the
 *      POS-reported total, computed by Postgres `numeric` — NEVER JS float
 *      (gate A.6). The POS total is read, never rewritten (FR-030).
 *   3. Sets the SaaS-owned processing state `processed_at` + `mismatch_flag`
 *      (FR-071) with a `WHERE processed_at IS NULL` guard so the write is
 *      idempotent and CONVERGES under retry/at-least-once re-delivery: a second
 *      run is a no-op and `processed_at` does not drift (§XI).
 *   4. RT-427: when the tenant's sale effects are active, writes one Inventory
 *      Effect per sale line in the SAME transaction as the `sale_post` intent
 *      (RT-289 DC-1 / DC-2), so the two commit or roll back together. A line
 *      whose effect cannot be written exactly is skipped, never stalls the
 *      sale, and is reported after commit (warn log + metric, owner decision
 *      2). With the flag OFF nothing else changes.
 *
 * Layered architecture (mirrors AuditFanoutProcessor)
 * ---------------------------------------------------
 *   Layer A (this file): pure `(envelope) → DB UPDATE under tenant context`.
 *     Knows nothing about BullMQ runtime, Redis, retry, or queue wiring.
 *   Layer B (DEFERRED — future worker wiring slice): the BullMQ `Worker`
 *     bootstrap, queue registration, and `worker.module.ts` wiring.
 *
 * KNOWN GAP (scope boundary): this processor is NOT registered in
 * `worker.module.ts` / `queue.config.ts`, and the DB-backed spec is NOT added
 * to `jest.config.cjs`'s Docker exclusion list — those files are outside the
 * 008-WORKER `allowed_files` globs. The wiring deferral is flagged to the
 * orchestrator (same precedent as `AuditFanoutProcessor`'s KNOWN GAP).
 *
 * PII / redaction (FR-042 / FR-092)
 * ---------------------------------
 * Raw POS payloads, line amounts, and the sale row are NEVER logged. On
 * failure the processor logs ONLY identifiers + the error class name (mirrors
 * the drainer's `logError`), routed through the shared logger whose redaction
 * policy is the enforcement boundary.
 */
import type { Pool } from "pg";
import {
  emit,
  OUTBOX_EVENT_TYPES,
  runWithTenantContext,
  writeSaleLineEffects,
  type SaleEffectsOutcome,
} from "@data-pulse-2/db";

import {
  recordInventorySaleEffectSkipped,
  recordWorkerProcessingFailure,
  sanitizeErrorClass,
} from "../observability/metrics/worker.metrics";

// ---------------------------------------------------------------------------
// Envelope — the off-request job carries the tenant scope + correlation id
// (FR-081): tenantId / storeId / correlationId. Shaped as a subset of the
// outbox `OutboxEventEnvelope` fields so a future consumer wiring maps cleanly.
// ---------------------------------------------------------------------------

export interface SaleProcessingJob {
  /** Sale fact to process. */
  readonly saleId: string;
  /** Tenant that owns the sale. Drives `app.current_tenant` (RLS). */
  readonly tenantId: string;
  /** Store scope of the sale. */
  readonly storeId: string;
  /** End-to-end correlation id from the originating capture/request. */
  readonly correlationId?: string | null;
}

export interface SaleProcessingResult {
  /** The sale id that was processed (echoed for correlation). */
  readonly saleId: string;
  /** Advisory mismatch flag the worker computed/recorded (SaaS-owned). */
  readonly mismatchFlag: boolean;
  /** ISO `processed_at`; stable across re-runs (idempotent convergence). */
  readonly processedAt: string;
  /**
   * false when a re-run found the sale already processed — the UPDATE was a
   * no-op (idempotent). true when this run set `processed_at` for the first
   * time.
   */
  readonly applied: boolean;
}

/** Minimal log seam so failed-job logging is testable without a real logger. */
export interface SaleProcessingLogger {
  error(obj: Record<string, unknown>, msg?: string): void;
  /** RT-427: a skipped sale effect (identifiers only). */
  warn?(obj: Record<string, unknown>, msg?: string): void;
}

/** Thrown when the target sale does not resolve within the tenant scope. */
export class SaleProcessingNotFoundError extends Error {
  constructor() {
    super("sale not found for processing");
    this.name = "SaleProcessingNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// UUID guard — fail fast on a malformed id before opening a connection.
// ---------------------------------------------------------------------------
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProcessRow {
  mismatch_flag: boolean;
  processed_at: Date;
}

export class SaleProcessingProcessor {
  constructor(
    private readonly pool: Pool,
    private readonly logger?: SaleProcessingLogger,
  ) {}

  /**
   * Process one sale off-request. Idempotent: a second invocation for an
   * already-processed sale converges to the SAME state (`processed_at`
   * unchanged) and reports `applied: false`.
   */
  async process(job: SaleProcessingJob): Promise<SaleProcessingResult> {
    this.assertJob(job);

    // Filled inside the transaction; reported only after it commits.
    const written: { effects: SaleEffectsOutcome | null } = { effects: null };
    try {
      const result = await runWithTenantContext(
        this.pool,
        { tenantId: job.tenantId, isPlatformAdmin: false },
        async (client): Promise<SaleProcessingResult> => {
          // Object-safety gate under tenant RLS + explicit store predicate:
          // the sale must resolve within (tenant, store) scope before any
          // processing write. A wrong-store/unknown id is non-disclosing.
          const sale = await client.query<{ id: string }>(
            `SELECT id FROM sales WHERE id = $1 AND store_id = $2`,
            [job.saleId, job.storeId],
          );
          if (!sale.rows[0]) {
            throw new SaleProcessingNotFoundError();
          }

          // Advisory mismatch (gate A.3/A.4), recomputed identically to
          // capture: half-up sum of persisted per-line amounts compared to the
          // POS-reported total, computed by Postgres numeric — NEVER JS float.
          // COALESCE handles a sale with zero lines (sum → NULL → 0).
          //
          // Idempotency (FR-071): the UPDATE is guarded by
          // `processed_at IS NULL`, so a re-run after the first processing is a
          // no-op and processed_at does not drift. We then read back the
          // authoritative (mismatch_flag, processed_at) regardless of whether
          // this run wrote, so the result is identical across runs.
          // 032 §7 / spec clarify Q1: the DP-2 sale-processing drain is the
          // transition that advances the server-authoritative sale-status to
          // 'synced'. It is set in the SAME UPDATE that sets processed_at, under
          // the SAME `processed_at IS NULL` guard, so the status advance is
          // idempotent and converges identically to processed_at (a re-run is a
          // no-op). This is NOT gated on any ERPNext posting outcome — the
          // posting feed is a separate downstream concern (Connector-owned;
          // architecture boundary POS → DP-2 → Connector → ERPNext). Crossing
          // that wire would violate the invariant.
          const updated = await client.query<ProcessRow>(
            `UPDATE sales AS s
                SET mismatch_flag = (
                      round(
                        COALESCE(
                          (SELECT SUM(sl.line_amount)
                             FROM sale_lines sl
                            WHERE sl.sale_id = s.id),
                          0
                        )::numeric,
                        4
                      ) <> s.pos_total::numeric
                    ),
                    processed_at = now(),
                    sync_status = 'synced'
              WHERE s.id = $1
                AND s.store_id = $2
                AND s.processed_at IS NULL
            RETURNING mismatch_flag, processed_at`,
            [job.saleId, job.storeId],
          );

          if (updated.rows[0]) {
            const row = updated.rows[0];

            // RT-427 (DC-1 / DC-2): the sale's Inventory Effects, in this same
            // transaction as the intent below. A no-op while the tenant is OFF.
            written.effects = await writeSaleLineEffects(client, {
              tenantId: job.tenantId,
              storeId: job.storeId,
              saleId: job.saleId,
            });

            // 015 posting trigger: the sale just became PROCESSED (first time —
            // this branch only runs when the `processed_at IS NULL` guard matched).
            // Emit `erpnext.posting.requested` IN-TRANSACTION, atomic with the
            // processed_at write, so a processed sale becomes eligible for the
            // ERPNext posting feed. The worker-side posting-requested consumer
            // resolves eligibility (015-RESOLVE) and inserts the pending /
            // permanently_rejected erpnext_posting_status row. Payload is IDs +
            // provenance only (no money / PII). Idempotent downstream via the O-3
            // unique (tenant_id, source_ref_id) — a re-delivery is a no-op insert.
            // The `processed_at IS NULL` guard means a re-run does NOT re-emit.
            await emit(client, {
              eventType: OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED,
              tenantId: job.tenantId,
              storeId: job.storeId,
              payload: {
                sale_id: job.saleId,
                store_id: job.storeId,
                kind: "sale_post",
                source_ref_id: job.saleId,
              },
              // outbox_events.correlation_id is UUID-typed. The sale-processing
              // job's correlationId is free text (may be a non-UUID), so do NOT
              // forward it here — passing null mirrors the sale.captured emit in
              // sales.service.ts (which also emits correlationId: null). A future
              // UUID correlation id can be threaded once the job carries one.
              correlationId: null,
            });

            return {
              saleId: job.saleId,
              mismatchFlag: row.mismatch_flag,
              processedAt: row.processed_at.toISOString(),
              applied: true,
            };
          }

          // Already processed by a prior run — converge by reading the
          // existing state. No write, no processed_at drift.
          const existing = await client.query<ProcessRow>(
            `SELECT mismatch_flag, processed_at FROM sales
              WHERE id = $1 AND store_id = $2`,
            [job.saleId, job.storeId],
          );
          const row = existing.rows[0];
          if (!row || row.processed_at === null) {
            // The UPDATE touched no row yet the sale still reads unprocessed:
            // another worker concurrently claimed the same sale (both txns
            // initially saw processed_at IS NULL). Throwing forces a retry,
            // which converges to the winner's committed state — or succeeds if
            // that concurrent claim rolled back. Intentional: never report a
            // false resolved state.
            throw new SaleProcessingNotFoundError();
          }
          return {
            saleId: job.saleId,
            mismatchFlag: row.mismatch_flag,
            processedAt: row.processed_at.toISOString(),
            applied: false,
          };
        },
      );
      // After COMMIT only, so a rolled-back attempt never reports a skip.
      if (written.effects !== null) this.reportSkippedEffects(job, written.effects);
      return result;
    } catch (err: unknown) {
      // RT-457: every failed attempt is counted, so a sale that keeps failing
      // (and would otherwise strand silently) is visible on the metrics.
      recordWorkerProcessingFailure({
        job_name: "sale-processing",
        error_class: sanitizeErrorClass(err instanceof Error ? err.constructor.name : undefined),
      });
      // FR-042/092: log ONLY identifiers + the error class — never the sale
      // row, line amounts, or any raw payload.
      this.logger?.error(
        {
          job_name: "sale-processing",
          sale_id: job.saleId,
          tenant_id: job.tenantId,
          store_id: job.storeId,
          correlation_id: job.correlationId ?? null,
          error_class: err instanceof Error ? err.constructor.name : "Unknown",
        },
        "sale processing failed",
      );
      throw err;
    }
  }

  /**
   * RT-427 owner decision 2: one warn log and one metric per skipped line.
   * Identifiers and closed codes only — no quantity, unit or product name.
   */
  private reportSkippedEffects(job: SaleProcessingJob, outcome: SaleEffectsOutcome): void {
    for (const line of outcome.skipped) {
      recordInventorySaleEffectSkipped(outcome.event, line.reason);
      this.logger?.warn?.(
        {
          event: "inventory.sale_effect.skipped",
          event_type: outcome.event,
          event_ref_id: job.saleId,
          reason: line.reason,
          line_id: line.lineId,
          tenant_id: job.tenantId,
          store_id: job.storeId,
          sale_id: job.saleId,
        },
        "sale line written without an inventory effect",
      );
    }
  }

  private assertJob(job: SaleProcessingJob): void {
    if (!UUID_RE.test(job.saleId)) {
      throw new Error("SaleProcessingProcessor: saleId must be a UUID string");
    }
    if (!UUID_RE.test(job.tenantId)) {
      throw new Error("SaleProcessingProcessor: tenantId must be a UUID string");
    }
    if (!UUID_RE.test(job.storeId)) {
      throw new Error("SaleProcessingProcessor: storeId must be a UUID string");
    }
  }
}
