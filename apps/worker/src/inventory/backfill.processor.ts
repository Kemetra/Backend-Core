/**
 * InventoryBackfillProcessor — 009-US4-SALELINKED (T064).
 *
 * The OFF-REQUEST worker that turns CAPTURED 008 sales into sale-linked
 * outbound stock movements (FR-032/060). For one captured sale it:
 *
 *   1. Establishes tenant context (`app.current_tenant`) via
 *      `runWithTenantContext` BEFORE any tenant-scoped DB access — every read
 *      and INSERT runs under the 0014 RLS policies on the non-superuser `app`
 *      connection (§II / §V). Skipping this fails RLS (the T561 pattern).
 *   2. Reads the CAPTURED 008 sale + its lines BY VALUE. "Captured" is the
 *      `processed_at IS NULL` state (the 008 live loop is unwired — R8): this
 *      processor NEVER reads/waits on a non-NULL `processed_at`, NEVER
 *      subscribes to `sale.captured`, and NEVER mutates the 008 sale fact. The
 *      sale ids are recorded as provenance only.
 *   3. Appends ONE outbound movement per sale line, idempotent on the provenance
 *      pair `(tenant_id, source_system, external_id=<sale_line_id>)` via the
 *      partial-unique `uq_stock_movements_tenant_source_external` (0014, R4):
 *      `INSERT … ON CONFLICT DO NOTHING`. A redelivered backfill appends no
 *      duplicate and re-applies no on-hand (on-hand is compute-on-read, so
 *      "applied once" == "at most one row per pair" — FR-033). A null
 *      `tenant_product_ref` line stays null — products are NEVER auto-created
 *      (FR-023 / R5). One audit row per genuine append, in the SAME transaction.
 *
 * Layered architecture (mirrors SaleProcessingProcessor / AuditFanoutProcessor)
 * ----------------------------------------------------------------------------
 *   Layer A (this file): pure `(job) → DB INSERTs under tenant context`. Knows
 *     nothing about BullMQ runtime, Redis, retry, or queue wiring.
 *   Layer B (DEFERRED — future worker wiring slice): the BullMQ `Worker`
 *     bootstrap, queue registration, and `worker.module.ts` wiring.
 *
 * CROSS-PACKAGE SYNC POINT (apps must not depend on each other — the audit
 * processor precedent): this INSERT + ON CONFLICT + audit is a deliberate MIRROR
 * of `InventoryService.backfillSaleLinkedOutbound`
 * (apps/api/src/inventory/inventory.service.ts). The worker cannot import the
 * api app, so the write is duplicated here. Keep the two in sync — any change to
 * the provenance-dedup write semantics MUST be applied to BOTH. A future
 * `packages/inventory` extraction would consolidate them.
 *
 * KNOWN GAP (scope boundary, F-04/F-05): this processor is NOT registered in
 * `worker.module.ts` / queue config (BullMQ wiring deferred to closeout, same as
 * SaleProcessingProcessor's KNOWN GAP). Its Docker-backed spec IS registered in
 * `jest.config.cjs`'s `dockerOutboxSuites` so the no-Docker fast job excludes it
 * (project_008_worker_ci_jest_exclusion).
 *
 * PII / redaction (§XIV): raw payloads, line amounts, and sale rows are NEVER
 * logged. On failure the processor logs ONLY identifiers + the error class name.
 */
import type { Pool } from "pg";
import { runWithTenantContext, emit, OUTBOX_EVENT_TYPES } from "@data-pulse-2/db";

// ---------------------------------------------------------------------------
// Envelope — the off-request job carries the tenant scope + correlation id
// (FR-081) plus the backfill origin that becomes the dedup pair's source_system.
// ---------------------------------------------------------------------------

export interface InventoryBackfillJob {
  /** Captured 008 sale to backfill into stock movements. */
  readonly saleId: string;
  /** Tenant that owns the sale. Drives `app.current_tenant` (RLS). */
  readonly tenantId: string;
  /** Store scope of the sale. */
  readonly storeId: string;
  /** The backfill actor (a service principal). */
  readonly actorId: string;
  /** Backfill origin — half of the provenance dedup pair (FR-031). */
  readonly sourceSystem: string;
  /** End-to-end correlation id from the originating backfill batch. */
  readonly correlationId?: string | null;
}

export interface InventoryBackfillResult {
  /** The sale id that was backfilled (echoed for correlation). */
  readonly saleId: string;
  /** Number of lines that produced a NEW outbound movement this run. */
  readonly appended: number;
  /** Number of lines whose movement already existed (deduped, no-op). */
  readonly deduped: number;
  /** false when EVERY line was already backfilled (a fully idempotent re-run). */
  readonly applied: boolean;
}

/** Minimal log seam so failed-job logging is testable without a real logger. */
export interface InventoryBackfillLogger {
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** Thrown when the target sale does not resolve as CAPTURED within tenant scope. */
export class InventoryBackfillSaleNotFoundError extends Error {
  constructor() {
    super("captured sale not found for backfill");
    this.name = "InventoryBackfillSaleNotFoundError";
  }
}

/**
 * Thrown when a sale line's unit is inconsistent with the product's ESTABLISHED
 * stocking unit (FR-022 — MUST be rejected, no silent coercion, no conversion
 * engine). MIRRORS `InventoryService.CrossUnitError` (the api backfill path);
 * the worker cannot import the api app, so the type is duplicated here.
 */
export class InventoryBackfillCrossUnitError extends Error {
  constructor(
    public readonly expectedUnit: string,
    public readonly suppliedUnit: string,
  ) {
    super(
      `sale line unit '${suppliedUnit}' does not match the product's stocking unit '${expectedUnit}'`,
    );
    this.name = "InventoryBackfillCrossUnitError";
  }
}

/** The established-unit EXCLUDE constraint added in migration 0016 (issue #465). */
export const UNIT_GUARD_CONSTRAINT = "stock_movements_one_unit_per_product";

/**
 * True when `err` is the established-unit EXCLUDE violation (migration 0016):
 * SQLSTATE 23P01 on `stock_movements_one_unit_per_product`. MIRRORS the api
 * service's `isUnitExclusionViolation` (apps must not import each other). Fires
 * only under true concurrency — the pre-loop cross-unit check throws first on
 * the sequential path; this is the path-independent DB backstop. Off-request, a
 * 23P01 here is a job failure/retry, so translation only buys a cleaner log
 * class (no HTTP status to preserve) — no re-query, no separate test beyond this.
 */
function isUnitExclusionViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23P01" &&
    (err as { constraint?: unknown }).constraint === UNIT_GUARD_CONSTRAINT
  );
}

/**
 * The per-request backfill ceiling (009-POLISH / T101, plan §1.5). One backfill
 * job appends ONE movement per captured sale line; a job whose sale has more
 * than MAX_BACKFILL_MOVEMENTS lines is DETERMINISTICALLY REJECTED before any
 * INSERT — there is no unbounded backfill path (layered on the inherited
 * 001/004 rate-limit posture). Mirrors the contract's
 * `SaleLinkedBackfillCommand.maxItems` (500); the contract batch route is not
 * built in v1, so the per-sale processor loop is the only real path to bound.
 */
export const MAX_BACKFILL_MOVEMENTS = 500;

/** Thrown when a single backfill job would append more than the per-request ceiling. */
export class InventoryBackfillTooManyLinesError extends Error {
  constructor(
    public readonly lineCount: number,
    public readonly ceiling: number = MAX_BACKFILL_MOVEMENTS,
  ) {
    super(
      `backfill job has ${lineCount} sale lines, exceeding the per-request ceiling of ${ceiling}`,
    );
    this.name = "InventoryBackfillTooManyLinesError";
  }
}

// ---------------------------------------------------------------------------
// UUID guard — fail fast on a malformed id before opening a connection.
// ---------------------------------------------------------------------------
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AUDIT_ACTION_MOVEMENT_BACKFILL = "inventory.movement.backfill";
const AUDIT_TARGET_TYPE_MOVEMENT = "stock_movement";

interface SaleLineRow {
  id: string;
  quantity: string;
  unit: string;
  tenant_product_ref: string | null;
}

export class InventoryBackfillProcessor {
  constructor(
    private readonly pool: Pool,
    private readonly logger?: InventoryBackfillLogger,
  ) {}

  /**
   * Backfill one captured sale into sale-linked outbound movements. Idempotent:
   * a second invocation appends no duplicate movement and reports
   * `applied: false` when every line was already backfilled (FR-033).
   */
  async process(job: InventoryBackfillJob): Promise<InventoryBackfillResult> {
    this.assertJob(job);

    try {
      return await runWithTenantContext(
        this.pool,
        { tenantId: job.tenantId, isPlatformAdmin: false },
        async (client): Promise<InventoryBackfillResult> => {
          // ---- Resolve the CAPTURED sale (R8) under tenant RLS + store scope.
          // `processed_at IS NULL` is the captured-state filter, NOT a wait on a
          // stamped value — the decoupling mechanism. A wrong-store / unknown /
          // already-processed sale is non-disclosing.
          const sale = await client.query<{ id: string }>(
            `SELECT id FROM sales
              WHERE id = $1 AND store_id = $2 AND processed_at IS NULL`,
            [job.saleId, job.storeId],
          );
          if (!sale.rows[0]) {
            throw new InventoryBackfillSaleNotFoundError();
          }

          // ---- Read the frozen sale lines BY VALUE (provenance source). -----
          const lines = await client.query<SaleLineRow>(
            `SELECT id, quantity, unit, tenant_product_ref
               FROM sale_lines
              WHERE sale_id = $1 AND store_id = $2
              ORDER BY id ASC`,
            [job.saleId, job.storeId],
          );

          // ---- Per-request backfill ceiling (T101, plan §1.5) ---------------
          // One movement per line; reject DETERMINISTICALLY before any INSERT if
          // the job would exceed the ceiling — no unbounded backfill path. The
          // guard is before the loop, so an over-ceiling job writes nothing.
          if (lines.rows.length > MAX_BACKFILL_MOVEMENTS) {
            throw new InventoryBackfillTooManyLinesError(lines.rows.length);
          }

          let appended = 0;
          let deduped = 0;

          for (const line of lines.rows) {
            // ---- Cross-unit reject (FR-022) — MIRRORS the api service's
            // assertUnitMatchesEstablished. A line whose unit is inconsistent
            // with the product's ESTABLISHED unit MUST be rejected (no silent
            // coercion, no conversion engine). The established unit is the unit
            // of the product's existing movements at this store; skip for an
            // ad-hoc null-product line and for a product's very first movement.
            if (line.tenant_product_ref !== null) {
              const established = await client.query<{ stocking_unit: string }>(
                `SELECT stocking_unit FROM stock_movements
                  WHERE store_id = $1 AND tenant_product_ref = $2
                  ORDER BY received_at ASC, id ASC
                  LIMIT 1`,
                [job.storeId, line.tenant_product_ref],
              );
              const establishedUnit = established.rows[0]?.stocking_unit;
              if (establishedUnit !== undefined && establishedUnit !== line.unit) {
                throw new InventoryBackfillCrossUnitError(establishedUnit, line.unit);
              }
            }

            // Outbound = stock leaves on the sale: negate the sold quantity.
            // The line quantity persists as numeric; negate in SQL (no JS float)
            // by passing the value and a leading '-' via the cast below.
            const externalId = line.id; // sale_line id = the dedup natural key.

            // MIRROR of InventoryService.backfillSaleLinkedOutbound — keep in
            // sync. ON CONFLICT against the PARTIAL unique index must restate
            // the index predicate or Postgres won't match it.
            let inserted: { rows: Array<{ id: string }> };
            try {
              inserted = await client.query<{ id: string }>(
                // RT-432 (RT-290 G4-6): the store's primary location, sellable
                // — the position InventoryService resolves for the same write.
                // A store with no visible primary inserts a NULL location and
                // fails the 0044 position CHECK (never a guessed position).
                `INSERT INTO stock_movements
                   (tenant_id, store_id, movement_type, quantity, stocking_unit,
                    tenant_product_ref, occurred_at, source_system, external_id,
                    sale_id, sale_line_id, created_by, stock_location_id,
                    inventory_status)
                 VALUES
                   ($1, $2, 'outbound', (-1) * $3::numeric(19,4), $4, $5, now(),
                    $6, $7, $8, $9, $10,
                    (SELECT id FROM stock_locations
                      WHERE store_id = $2 AND kind = 'primary'),
                    'sellable')
                 ON CONFLICT (tenant_id, source_system, external_id)
                   WHERE source_system IS NOT NULL AND external_id IS NOT NULL
                   DO NOTHING
                 RETURNING id`,
                [
                  job.tenantId,
                  job.storeId,
                  line.quantity,
                  line.unit,
                  line.tenant_product_ref, // null stays null — never auto-created.
                  job.sourceSystem,
                  externalId,
                  job.saleId,
                  line.id,
                  job.actorId,
                ],
              );
            } catch (err: unknown) {
              // DB backstop (migration 0016): a concurrent first-movement raced
              // past the pre-loop unit check. Surface it as the same cross-unit
              // error class for a clean log; line.unit is the supplied unit (the
              // established one isn't known on the race path — off-request, the
              // exact units don't drive a status code).
              if (isUnitExclusionViolation(err)) {
                throw new InventoryBackfillCrossUnitError(line.unit, line.unit);
              }
              throw err;
            }

            const row = inserted.rows[0];
            if (!row) {
              // Already backfilled (dedup) — no second movement, no audit.
              deduped += 1;
              continue;
            }
            appended += 1;

            // ---- Audit per genuine append, in the SAME transaction. --------
            await client.query(
              `INSERT INTO audit_events
                 (id, actor_user_id, tenant_id, action, target_type, target_id,
                  metadata)
               VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb)`,
              [
                job.actorId,
                job.tenantId,
                AUDIT_ACTION_MOVEMENT_BACKFILL,
                AUDIT_TARGET_TYPE_MOVEMENT,
                row.id,
                JSON.stringify({
                  sourceSystem: job.sourceSystem,
                  externalId,
                  saleId: job.saleId,
                  correlationId: job.correlationId ?? null,
                }),
              ],
            );

            // Outbox emit IN-TRANSACTION, on this genuine-append branch only —
            // MIRRORS InventoryService.emitMovementCreated (apps can't import
            // each other; keep in sync). The dedup `continue` above skips it, so
            // a redelivered backfill does NOT double-emit (FR-033). IDs +
            // provenance only, no PII (§XIV).
            await emit(client, {
              eventType: OUTBOX_EVENT_TYPES.INVENTORY_MOVEMENT_CREATED,
              tenantId: job.tenantId,
              storeId: job.storeId,
              payload: {
                movementIds: [row.id],
                movementType: "outbound",
                tenantProductRef: line.tenant_product_ref,
                sourceSystem: job.sourceSystem,
                externalId,
                saleId: job.saleId,
              },
              // outbox correlation_id is UUID — only forward a well-formed UUID
              // (UUID_RE already declared for the job-id guards); a non-UUID tag
              // must not fail the movement write.
              correlationId:
                job.correlationId && UUID_RE.test(job.correlationId)
                  ? job.correlationId
                  : null,
            });
          }

          return {
            saleId: job.saleId,
            appended,
            deduped,
            applied: appended > 0,
          };
        },
      );
    } catch (err: unknown) {
      // §XIV: log ONLY identifiers + the error class — never the sale row, line
      // amounts, quantities, or any raw payload.
      this.logger?.error(
        {
          job_name: "inventory-backfill",
          sale_id: job.saleId,
          tenant_id: job.tenantId,
          store_id: job.storeId,
          correlation_id: job.correlationId ?? null,
          error_class: err instanceof Error ? err.constructor.name : "Unknown",
        },
        "inventory backfill failed",
      );
      throw err;
    }
  }

  private assertJob(job: InventoryBackfillJob): void {
    if (!UUID_RE.test(job.saleId)) {
      throw new Error("InventoryBackfillProcessor: saleId must be a UUID string");
    }
    if (!UUID_RE.test(job.tenantId)) {
      throw new Error("InventoryBackfillProcessor: tenantId must be a UUID string");
    }
    if (!UUID_RE.test(job.storeId)) {
      throw new Error("InventoryBackfillProcessor: storeId must be a UUID string");
    }
    if (!UUID_RE.test(job.actorId)) {
      throw new Error("InventoryBackfillProcessor: actorId must be a UUID string");
    }
    if (job.sourceSystem.trim().length === 0) {
      throw new Error("InventoryBackfillProcessor: sourceSystem is required");
    }
  }
}
