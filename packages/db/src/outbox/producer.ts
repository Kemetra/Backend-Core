/**
 * T580 — Outbox producer helper `emit(...)`.
 *
 * Inserts one `outbox_events` row inside the CALLER'S transaction.
 * The row is written atomically with the business state change:
 * if the caller's transaction rolls back, the event row is never committed.
 *
 * The caller is responsible for:
 *   1. Opening a transaction on the supplied `PoolClient`.
 *   2. Setting tenant-context GUCs (`app.current_tenant`, `app.is_platform_admin`)
 *      before calling `emit` — the INSERT must pass RLS WITH CHECK.
 *   3. Committing or rolling back — `emit` does NOT manage the transaction.
 *
 * For callers that don't already hold an open transaction, the sibling
 * helper `emitInNewTransaction` wraps `runWithTenantContext` + `emit` for
 * convenience (e.g., the audit emitter interceptor which fires post-response).
 *
 * Event type registry
 * -------------------
 * Only `audit.event.created` is currently a registered type (FR-C-007).
 * New event types require a separate approval PR per T541. The `OUTBOX_EVENT_TYPES`
 * constant is the single source of truth for approved types.
 *
 * Redaction obligation
 * --------------------
 * The `payload` is never logged in full (Constitution XIV, FR-C-008).
 * Callers must NOT log the emitted row or its payload — structured pino
 * redaction at the transport boundary is the enforcement mechanism.
 *
 * UUID generation
 * ---------------
 * Uses `crypto.randomUUID()` (Node 14.17+ built-in) — UUIDv4. UUIDv7
 * (time-ordered) is the production preference per the schema docs, but
 * the `packages/db` package has no dependency on the `uuid` npm package
 * (which lives in `@data-pulse-2/shared`). UUIDv4 is structurally
 * identical to UUIDv7 for correctness purposes; the schema accepts both.
 * A future refactor can swap this to UUIDv7 when the dependency is added.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient, Pool } from "pg";
import { runWithTenantContext, type TenantContext } from "../middleware/tenant-context";

// ---------------------------------------------------------------------------
// Event-type registry
// ---------------------------------------------------------------------------

/**
 * Approved outbox event types. Adding a new type requires a separate PR per T541.
 *   - `audit.event.created` (FR-C-007).
 *   - `inventory.movement.created` (009 / issue #465 part B): emitted in-
 *     transaction when a stock movement is appended (manual / transfer /
 *     count-correction / sale-linked backfill / restock), so downstream
 *     consumers receive movement events. Same registration shape as the 008
 *     `sale.captured` deferral; the payload carries IDs + provenance only
 *     (no PII / no money), redacted-by-default like the audit event.
 *   - `sale.captured` (008 DP-008-LIVELOOP): emitted in-transaction when a
 *     sale fact is captured, so the worker-side `SaleCapturedConsumer` can
 *     bridge it to the existing `sale-processing` BullMQ queue (which the
 *     `SaleWorker`/`SaleProcessingProcessor` consume). The payload carries IDs
 *     only (saleId / storeId) — no PII / no money / no line amounts (FR-042 /
 *     FR-092). The capture-side emit + `SALES_OUTBOX_PRODUCER` binding and the
 *     `saleWorker.start()` in `main.ts` are a SEPARATE follow-up slice.
 *   - `erpnext.posting.requested` (015 POS-sale-posting-to-ERPNext): emitted
 *     in-transaction when a PROCESSED 008 sale (or a void/refund terminal event)
 *     becomes eligible for ERPNext posting, so the worker-side posting-requested
 *     consumer can record a `pending` `erpnext_posting_status` row (migration
 *     0019). The payload carries IDs + provenance only (saleId / storeId /
 *     sourceSystem / externalId / kind) — no PII / no money / no line amounts;
 *     the posting work-item is projected lazily on pull (012 feed). Mirrors the
 *     `sale.captured` registration shape.
 *   - `erpnext.reconciliation.requested` (017-RECON-WIRING): emitted in-
 *     transaction by the api-side `triggerRun` when an on-demand stock
 *     reconciliation run is created (`erpnext_reconciliation_run` row,
 *     `status='running'`, migration 0020), so the worker-side
 *     `ReconciliationRequestedConsumer` invokes `ReconciliationRunProcessor`
 *     and advances the run `running → completed`. The payload carries IDs +
 *     provenance only (runId / storeId) — no PII / no money. Mirrors the
 *     `erpnext.posting.requested` registration shape; the processor's terminal
 *     write is guarded so at-least-once redelivery is an idempotent no-op.
 */
export const OUTBOX_EVENT_TYPES = {
  AUDIT_EVENT_CREATED: "audit.event.created",
  INVENTORY_MOVEMENT_CREATED: "inventory.movement.created",
  SALE_CAPTURED: "sale.captured",
  ERPNEXT_POSTING_REQUESTED: "erpnext.posting.requested",
  ERPNEXT_RECONCILIATION_REQUESTED: "erpnext.reconciliation.requested",
  ERPNEXT_PRODUCT_RECONCILIATION_REQUESTED: "erpnext.product_reconciliation.requested",
} as const;

export type OutboxEventType = typeof OUTBOX_EVENT_TYPES[keyof typeof OUTBOX_EVENT_TYPES];

// ---------------------------------------------------------------------------
// Emit input shape
// ---------------------------------------------------------------------------

/**
 * The data a producer must supply to emit an outbox event.
 * Server-stamped fields (`event_id`, `created_at`, `updated_at`, `occurred_at`
 * default, `delivery_state` default, `attempts` default) are NOT in this shape.
 */
export interface OutboxEmitInput {
  /** Registry-controlled event type. Must be one of `OUTBOX_EVENT_TYPES`. */
  readonly eventType: OutboxEventType;
  /**
   * Tenant that owns the event. Must match the active tenant context.
   * `null` is a platform-scoped row: the caller must set
   * `isPlatformAdmin: true` (the GUC sentinel stays the nil UUID).
   * RLS WITH CHECK rejects a tenant context that inserts NULL.
   */
  readonly tenantId: string | null;
  /** Store scope; null for tenant-level events. */
  readonly storeId?: string | null;
  /** Event-type-specific body. Never logged in full. */
  readonly payload: Record<string, unknown>;
  /** Optional correlation id from the originating request or job. */
  readonly correlationId?: string | null;
  /**
   * Optional business event timestamp (UTC). Defaults to `now()` in the DB
   * when omitted, which is the correct value in the majority of cases.
   */
  readonly occurredAt?: Date | null;
}

// ---------------------------------------------------------------------------
// emit — in-transaction helper
// ---------------------------------------------------------------------------

/**
 * Insert one `outbox_events` row using the CALLER'S already-open `PoolClient`.
 *
 * The client must already be inside a transaction with the appropriate tenant
 * GUCs set (`app.current_tenant` = `input.tenantId`, `app.is_platform_admin`
 * per the caller's context). The INSERT will fail RLS WITH CHECK if the tenant
 * context does not match the row's `tenant_id`.
 *
 * Returns the generated `event_id` (UUIDv4; see file header for the v7 note)
 * for the caller to log or surface for correlation.
 */
export async function emit(
  client: PoolClient,
  input: OutboxEmitInput,
): Promise<string> {
  const eventId = randomUUID();

  // SQL DEFAULT (now()) only applies when the column is OMITTED from the
  // INSERT column list — passing an explicit NULL would violate the NOT NULL
  // constraint. Use COALESCE($7::timestamptz, now()) so callers can pass null
  // and still get the DB-side default.
  await client.query(
    `INSERT INTO outbox_events
       (event_id, tenant_id, store_id, event_type, payload,
        delivery_state, attempts, correlation_id, occurred_at)
     VALUES
       ($1, $2, $3, $4, $5::jsonb,
        'pending', 0, $6, COALESCE($7::timestamptz, now()))`,
    [
      eventId,
      input.tenantId,
      input.storeId ?? null,
      input.eventType,
      JSON.stringify(input.payload),
      input.correlationId ?? null,
      input.occurredAt ?? null,
    ],
  );

  return eventId;
}

// ---------------------------------------------------------------------------
// emitInNewTransaction — convenience helper for post-response callers
// ---------------------------------------------------------------------------

/**
 * Emit an outbox event in a fresh transaction.
 *
 * Opens a new connection from `pool`, sets tenant-context GUCs via
 * `runWithTenantContext`, inserts the row, and commits.
 *
 * Use this from callers that are NOT already inside a business-state-change
 * transaction (e.g., the audit interceptor which fires post-response).
 *
 * NOTE: Because this opens a separate transaction, the event is NOT atomic
 * with the business write. If the business write already committed and this
 * helper throws, the event is lost. For true transactional atomicity, callers
 * should use `emit(client, ...)` inside the same transaction.
 *
 * The audit interceptor uses this pattern, accepting the best-effort
 * semantics; the existing BullMQ-direct path had the same limitation.
 *
 * Returns the generated `event_id`.
 */
export async function emitInNewTransaction(
  pool: Pool,
  ctx: TenantContext,
  input: OutboxEmitInput,
): Promise<string> {
  return runWithTenantContext(pool, ctx, async (client) => {
    return emit(client, input);
  });
}
