/**
 * InventoryService — 009-US1-ONHAND (T033).
 *
 * The first runtime surface of the Inventory domain: the two READ operations.
 *   - getOnHand          — the derived (compute-on-read) signed SUM of a
 *                          (tenant, store, product)'s movements (FR-003). NO
 *                          materialized balance (R1/plan §10).
 *   - listStockMovements — the movements behind a balance, in a stable order
 *                          (FR-004).
 *
 * Tenant isolation: every query runs inside `runWithTenantContext` (sets
 * `app.current_tenant` in a transaction so RLS is active and fail-closed) —
 * the same primitive 005 reconciliation reuses. NO manual `SET LOCAL`, no new
 * primitive. Store scope is the `WHERE store_id = $1` clause + object-level
 * authz at the controller (0014 has tenant RLS only, no store policy).
 *
 * Compute-on-read SUM: `COALESCE(SUM(quantity), 0)` — over zero rows SUM is
 * NULL, so COALESCE makes an empty key a deterministic "0" (FR-005). The SUM is
 * done in SQL (numeric precision; never fetch-and-sum in JS). On-hand MAY be
 * negative (allow-and-flag, FR-024) — `negativeBalance` flags it.
 *
 * Projection: explicit columns only — the lineage `idempotency_key` and the
 * `source_system`/`external_id` dedup pair are NOT in the contract's
 * `StockMovement` projection and are never returned (§IV).
 *
 * Write path (009-US2-MANUAL, T044):
 *   - createStockMovement — append a manual inbound / outbound / adjustment
 *     (write-off = reason-coded outbound, FR-002). Append-only (FR-001): one
 *     INSERT, never an UPDATE/DELETE. Tenant / store / actor are resolved
 *     server-side from the principal + path — NEVER the body (FR-052/§XII; the
 *     controller's strict Zod DTO rejects any such body key). The movement's
 *     `stockingUnit` MUST match the product's ESTABLISHED unit — the unit its
 *     existing movements were recorded in (there is no catalog stocking-unit
 *     column; the first movement establishes it). A mismatch is a typed
 *     `CrossUnitError` → 400 (FR-022). `adjustment` requires a `reason`. Each
 *     successful create writes ONE audit event in the SAME transaction (audit
 *     and state cannot diverge — the 005 catalog write idiom). On-hand MAY go
 *     negative (allow-and-flag, FR-024) — never rejected here.
 *
 * Outbox: the create path emits audit-in-transaction ONLY (mirroring the
 * shipped 005 catalog write). An async outbox event for inventory movements is
 * a DEFERRED, [GATED] follow-up — it needs a new `INVENTORY_MOVEMENT_*` type
 * registered in `OUTBOX_EVENT_TYPES` (packages/db/**, a forbidden path outside
 * this slice's allowed_files; same pattern as the 008 `sale.captured` deferral).
 *
 * Transfer / count / backfill writes are authored in 009-US5/US6/US4 — NOT here.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext, emit, OUTBOX_EVENT_TYPES } from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../auth/auth.module';
import { recordInventoryNegativeBalance } from '../observability/metrics/api.metrics';

/** The set of manually-creatable movement types (contract enum, FR-002). */
export const MANUAL_MOVEMENT_TYPES = ['inbound', 'outbound', 'adjustment'] as const;
export type ManualMovementType = (typeof MANUAL_MOVEMENT_TYPES)[number];

/**
 * Raised when a movement's `stockingUnit` ≠ the product's established unit
 * (FR-022). The controller maps it to a 400 ValidationFailure. Carries both
 * units for a non-leaky, actionable message.
 */
export class CrossUnitError extends BadRequestException {
  constructor(
    public readonly expectedUnit: string,
    public readonly suppliedUnit: string,
  ) {
    super(
      `stockingUnit '${suppliedUnit}' does not match the product's stocking unit '${expectedUnit}'`,
    );
  }
}

/** The established-unit EXCLUDE constraint added in migration 0016 (issue #465). */
export const UNIT_GUARD_CONSTRAINT = 'stock_movements_one_unit_per_product';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** True when `v` is a well-formed UUID string (for the UUID-typed outbox correlation_id). */
function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * True when `err` is the established-unit EXCLUDE violation (migration 0016):
 * SQLSTATE 23P01 on the `stock_movements_one_unit_per_product` constraint.
 * This fires ONLY under true concurrency — two movements that both passed the
 * sequential `assertUnitMatchesEstablished` pre-check (saw no established unit)
 * and both inserted; the DB constraint is the path-independent backstop. The
 * sequential path throws `CrossUnitError` from the pre-check before any INSERT,
 * so this predicate is exercised by a direct unit test, not the Docker harness.
 */
export function isUnitExclusionViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23P01' &&
    (err as { constraint?: unknown }).constraint === UNIT_GUARD_CONSTRAINT
  );
}

/** Server-resolved + body-validated input to createStockMovement (FR-052). */
export interface CreateStockMovementInput {
  /** Resolved from the principal — never the body. */
  readonly tenantId: string;
  /** Resolved from the path — never the body. */
  readonly storeId: string;
  /** Resolved from the principal — never the body. */
  readonly userId: string;
  readonly movementType: ManualMovementType;
  /** SIGNED exact-decimal quantity string, in `stockingUnit`. */
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly tenantProductRef?: string | null | undefined;
  readonly reason?: string | null | undefined;
  /** Business-event time; defaults to now() server-side when omitted. */
  readonly occurredAt?: string | null | undefined;
  readonly saleId?: string | null | undefined;
  readonly saleLineId?: string | null | undefined;
  readonly terminalEventRef?: string | null | undefined;
}

/**
 * Worker-internal input to backfillSaleLinkedOutbound (009-US4, T052/T064).
 *
 * The OFF-REQUEST counterpart to CreateStockMovementInput: it carries the
 * backfill provenance dedup pair `(sourceSystem, externalId)` that the public
 * HTTP DTO deliberately does NOT accept (the controller DTO stays `.strict()` +
 * provenance-free — FR-052/§XII). This entry is reachable only from the worker
 * backfill processor (T064), never from a request. tenantId / storeId / userId
 * are resolved by the processor from its job context, never from untrusted body.
 */
export interface BackfillSaleLinkedOutboundInput {
  readonly tenantId: string;
  readonly storeId: string;
  /** The backfill actor (a service principal resolved by the processor). */
  readonly userId: string;
  /** Backfill origin (e.g. "pos-backfill") — half of the dedup pair (FR-031). */
  readonly sourceSystem: string;
  /** External natural key (e.g. the sale-line id) — the other half. */
  readonly externalId: string;
  readonly movementType: 'outbound';
  /** SIGNED exact-decimal quantity string (outbound ⇒ negative). */
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly tenantProductRef?: string | null | undefined;
  readonly reason?: string | null | undefined;
  readonly occurredAt?: string | null | undefined;
  /** CAPTURED 008 sale provenance (R8) — read by value, never an FK. */
  readonly saleId?: string | null | undefined;
  readonly saleLineId?: string | null | undefined;
  readonly terminalEventRef?: string | null | undefined;
  /** Carried into the audit metadata for traceability across the backfill. */
  readonly correlationId?: string | null | undefined;
}

/**
 * Worker-internal input to backfillRestockInbound (009-RESTOCK, T090/T091).
 *
 * The INBOUND mirror of BackfillSaleLinkedOutboundInput: a void/refund/return →
 * restock is a manual/backfill inbound movement referencing the originating 008
 * void/refund terminal event (or a customer return) as provenance, deduped on
 * `(sourceSystem, externalId)` per FR-031 (FR-025/R6). Automatic restock-on-void
 * is DEFERRED (FR-060) — this is the manual/backfill entry only, no auto route.
 */
export interface BackfillRestockInboundInput {
  readonly tenantId: string;
  readonly storeId: string;
  /** The restock actor (a service principal resolved by the processor). */
  readonly userId: string;
  /** Restock origin (e.g. "pos-restock") — half of the dedup pair (FR-031). */
  readonly sourceSystem: string;
  /** External natural key (e.g. the void/refund event id) — the other half. */
  readonly externalId: string;
  readonly movementType: 'inbound';
  /** SIGNED exact-decimal quantity string (inbound ⇒ positive). */
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly tenantProductRef?: string | null | undefined;
  readonly reason?: string | null | undefined;
  readonly occurredAt?: string | null | undefined;
  /**
   * The originating 008 void/refund terminal event (or return) — provenance
   * only, read by value, never an FK (R8); the ledger never mutates the 008 fact.
   */
  readonly terminalEventRef?: string | null | undefined;
  /** Optional originating sale provenance, if the restock traces to a sale. */
  readonly saleId?: string | null | undefined;
  readonly saleLineId?: string | null | undefined;
  /** Carried into the audit metadata for traceability across the backfill. */
  readonly correlationId?: string | null | undefined;
}

/** Server-resolved input to createStockTransfer (009-US5, FR-020). */
export interface CreateStockTransferInput {
  /** Resolved from the principal — never the body. */
  readonly tenantId: string;
  /** Resolved from the principal — never the body. */
  readonly userId: string;
  /** Source store; authorized at the controller against the principal's scope. */
  readonly sourceStoreId: string;
  /** Destination store; a TARGET ref, resolved within tenant scope (FR-051). */
  readonly destinationStoreId: string;
  readonly tenantProductRef: string;
  /** STRICTLY POSITIVE exact-decimal magnitude string (the transfer amount). */
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly reason?: string | null | undefined;
}

/** The linked-movement pair a transfer produces (contract `StockTransfer`). */
export interface StockTransferBody {
  readonly transferGroupId: string;
  readonly outbound: StockMovementBody;
  readonly inbound: StockMovementBody;
}

/** Server-resolved input to recordStockCount (009-US6, FR-021). */
export interface RecordStockCountInput {
  /** Resolved from the principal — never the body. */
  readonly tenantId: string;
  /** Resolved from the path — never the body. */
  readonly storeId: string;
  /** Resolved from the principal — never the body. */
  readonly userId: string;
  readonly tenantProductRef: string;
  /** The physical count (non-negative) at numeric(19,4). */
  readonly countedQuantity: string;
  readonly stockingUnit: string;
  readonly countedAt?: string | null | undefined;
}

/** Result of a recorded count (contract `StockCountResult`). */
export interface StockCountResultBody {
  readonly stockCountId: string;
  readonly countedQuantity: string;
  /** Signed variance (counted − derived on-hand). Zero ⇒ no correction. */
  readonly variance: string;
  /** The appended count_correction movement, or null on zero variance. */
  readonly correctionMovement: StockMovementBody | null;
}

const AUDIT_ACTION_MOVEMENT_CREATE = 'inventory.movement.create';
const AUDIT_ACTION_MOVEMENT_BACKFILL = 'inventory.movement.backfill';
const AUDIT_ACTION_TRANSFER_CREATE = 'inventory.transfer.create';
const AUDIT_ACTION_COUNT_RECORD = 'inventory.count.record';
const AUDIT_TARGET_TYPE_MOVEMENT = 'stock_movement';
const AUDIT_TARGET_TYPE_TRANSFER = 'stock_transfer';
const AUDIT_TARGET_TYPE_COUNT = 'stock_count';

/** Wire projection of a stock_movements row (contract `StockMovement`, §IV). */
export interface StockMovementBody {
  readonly id: string;
  readonly storeId: string;
  readonly movementType: string;
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly tenantProductRef: string | null;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly saleId: string | null;
  readonly saleLineId: string | null;
  readonly terminalEventRef: string | null;
  readonly transferGroupId: string | null;
  readonly stockCountId: string | null;
  readonly createdBy: string;
}

/** Wire projection of the derived on-hand (contract `OnHand`, FR-003/024). */
export interface OnHandBody {
  readonly storeId: string;
  readonly productId: string;
  readonly quantity: string;
  readonly stockingUnit: string | null;
  readonly negativeBalance: boolean;
}

export interface StockMovementListBody {
  readonly items: readonly StockMovementBody[];
  readonly nextCursor: string | null;
}

/** Raw row shape from the explicit-column SELECT. */
interface MovementRow {
  id: string;
  store_id: string;
  movement_type: string;
  quantity: string;
  stocking_unit: string;
  tenant_product_ref: string | null;
  reason: string | null;
  occurred_at: Date;
  received_at: Date;
  sale_id: string | null;
  sale_line_id: string | null;
  terminal_event_ref: string | null;
  transfer_group_id: string | null;
  stock_count_id: string | null;
  created_by: string;
}

const MOVEMENT_COLUMNS = `
  id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref,
  reason, occurred_at, received_at, sale_id, sale_line_id, terminal_event_ref,
  transfer_group_id, stock_count_id, created_by
`;

function toMovementBody(r: MovementRow): StockMovementBody {
  return {
    id: r.id,
    storeId: r.store_id,
    movementType: r.movement_type,
    quantity: r.quantity,
    stockingUnit: r.stocking_unit,
    tenantProductRef: r.tenant_product_ref,
    reason: r.reason,
    occurredAt: r.occurred_at.toISOString(),
    receivedAt: r.received_at.toISOString(),
    saleId: r.sale_id,
    saleLineId: r.sale_line_id,
    terminalEventRef: r.terminal_event_ref,
    transferGroupId: r.transfer_group_id,
    stockCountId: r.stock_count_id,
    createdBy: r.created_by,
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Normalized, validated fields shared by the two provenance-dedup backfill entries. */
interface NormalizedBackfillFields {
  sourceSystem: string;
  externalId: string;
  stockingUnit: string;
  reason: string | null;
  tenantProductRef: string | null;
}

@Injectable()
export class InventoryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Derived on-hand for a (tenant, store, product): COALESCE(SUM(quantity), 0).
   * Empty key ⇒ "0" (FR-005). Negative ⇒ negativeBalance=true (FR-024).
   */
  async getOnHand(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly productId: string;
  }): Promise<OnHandBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<OnHandBody> => {
        // Store scope is the WHERE clause + object-level authz at the
        // controller; 0014 has tenant RLS only (no store policy), so no
        // app.current_store GUC is needed.
        // SUM in SQL; COALESCE handles the empty-key (zero-row → NULL) case.
        // stocking_unit is taken from any movement for the key (consistent per
        // product by FR-022); NULL when there are no movements.
        const r = await client.query<{
          quantity: string;
          stocking_unit: string | null;
        }>(
          // ::numeric(19,4)::text gives a uniform wire format ("0.0000" /
          // "7.0000") — the empty-key COALESCE literal and the SUM both render
          // at the column's scale, so a client never sees mixed "0" vs "7.0000".
          `SELECT COALESCE(SUM(quantity), 0)::numeric(19,4)::text AS quantity,
                  MIN(stocking_unit) AS stocking_unit
             FROM stock_movements
            WHERE store_id = $1 AND tenant_product_ref = $2`,
          [input.storeId, input.productId],
        );
        const quantity = r.rows[0]?.quantity ?? '0.0000';
        return {
          storeId: input.storeId,
          productId: input.productId,
          quantity,
          stockingUnit: r.rows[0]?.stocking_unit ?? null,
          negativeBalance: Number(quantity) < 0,
        };
      },
    );
  }

  /**
   * List movements for a (tenant, store) in stable order (occurred_at, id).
   * `productId` set ⇒ that product; omitted ⇒ ad-hoc (NULL-product) movements
   * only (per the contract — ad-hoc entries are listable but roll up to no
   * product on-hand, SC-001 / data-model Entity 2).
   */
  async listStockMovements(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly productId?: string | null | undefined;
    readonly limit?: number | undefined;
  }): Promise<StockMovementListBody> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockMovementListBody> => {
        // productId present → that product; absent → ad-hoc (NULL) movements.
        const productPredicate =
          input.productId != null ? 'tenant_product_ref = $2' : 'tenant_product_ref IS NULL';
        const params: unknown[] =
          input.productId != null
            ? [input.storeId, input.productId, limit]
            : [input.storeId, limit];
        const limitParam = input.productId != null ? '$3' : '$2';
        const r = await client.query<MovementRow>(
          `SELECT ${MOVEMENT_COLUMNS}
             FROM stock_movements
            WHERE store_id = $1 AND ${productPredicate}
            ORDER BY occurred_at ASC, id ASC
            LIMIT ${limitParam}`,
          params,
        );
        return {
          items: r.rows.map(toMovementBody),
          nextCursor: null,
        };
      },
    );
  }

  /**
   * Append a manual movement (inbound / outbound / adjustment). Append-only:
   * one INSERT inside one `runWithTenantContext` transaction, plus one audit
   * event in the SAME transaction. Returns the persisted `toBody` projection.
   *
   * Validation (all server-side; the body never carries tenant/store/actor):
   *   - sign agrees with type (FR-022): inbound>0, outbound<0, adjustment≠0;
   *   - adjustment requires a non-empty reason (FR-012);
   *   - the supplied stockingUnit matches the product's ESTABLISHED unit, if the
   *     product already has movements (FR-022) — first movement / ad-hoc
   *     null-product establishes its own unit, no prior to compare against.
   * On-hand MAY go negative — never rejected (allow-and-flag, FR-024).
   */
  async createStockMovement(input: CreateStockMovementInput): Promise<StockMovementBody> {
    const { reason, stockingUnit } = this.validateManualMovementInput(input);

    const tenantProductRef = input.tenantProductRef ?? null;
    const movementId = newId();
    const auditId = newId();

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockMovementBody> => {
        // ---- Cross-unit check (FR-022) -----------------------------------
        // The product's established unit is the unit of its existing movements
        // at this store (no catalog stocking-unit column). Skip for ad-hoc
        // null-product and for a product's very first movement.
        if (tenantProductRef !== null) {
          await this.assertUnitMatchesEstablished(
            client,
            input.storeId,
            tenantProductRef,
            stockingUnit,
          );
        }

        // ---- Append-only INSERT ------------------------------------------
        // tenant_id / store_id / created_by are the server-resolved values
        // (principal + path), never the body. occurred_at defaults to now()
        // when omitted; received_at defaults in the schema (security clock).
        const inserted = await this.insertMovementRow(
          client,
          `INSERT INTO stock_movements
             (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
              tenant_product_ref, reason, occurred_at, sale_id, sale_line_id,
              terminal_event_ref, created_by)
           VALUES
             ($1, $2, $3, $4, $5::numeric(19,4), $6, $7, $8,
              COALESCE($9::timestamptz, now()), $10, $11, $12, $13)
           RETURNING ${MOVEMENT_COLUMNS}`,
          [
            movementId,
            input.tenantId,
            input.storeId,
            input.movementType,
            input.quantity,
            stockingUnit,
            tenantProductRef,
            reason,
            input.occurredAt ?? null,
            input.saleId ?? null,
            input.saleLineId ?? null,
            input.terminalEventRef ?? null,
            input.userId,
          ],
          { storeId: input.storeId, tenantProductRef, suppliedUnit: stockingUnit },
        );
        const row = inserted.rows[0];
        if (!row) {
          throw new Error('InventoryService.createStockMovement: INSERT returned no row');
        }

        // ---- Audit event in the SAME transaction (FR-013, SC-007) --------
        // Atomic with the movement INSERT: a failure on either rolls both back.
        await client.query(
          `INSERT INTO audit_events
             (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            auditId,
            input.userId,
            input.tenantId,
            AUDIT_ACTION_MOVEMENT_CREATE,
            AUDIT_TARGET_TYPE_MOVEMENT,
            row.id,
            '{}',
          ],
        );

        // Outbox emit IN-TRANSACTION with the movement + audit (issue #465 B).
        await this.emitMovementCreated(client, {
          tenantId: input.tenantId,
          storeId: input.storeId,
          movementIds: [row.id],
          movementType: row.movement_type,
          tenantProductRef,
        });

        // ---- Negative-balance signal (FR-024) ----------------------------
        // An outbound that drove on-hand below zero is flagged, never rejected.
        if (input.movementType === 'outbound') {
          await this.flagIfNegativeOnHand(client, input.storeId, tenantProductRef);
        }

        return toMovementBody(row);
      },
    );
  }

  /**
   * Pre-DB validation for a manual movement: FR-002 type rules, the
   * numeric(19,4)-scale sign/zero rules, and the adjustment-reason rule.
   * The row persists as numeric(19,4); the sign/zero rules are evaluated on
   * the value AT THAT SCALE so a sub-0.0001 input (e.g. "0.00004") that
   * Postgres would round to 0.0000 cannot slip past the non-zero / adjustment
   * rules and persist as a zero-quantity movement. (The DTO regex also bounds
   * this at the boundary; this is the defense-in-depth half for direct
   * callers.)
   */
  private validateManualMovementInput(input: CreateStockMovementInput): {
    reason: string | null;
    stockingUnit: string;
  } {
    if (!MANUAL_MOVEMENT_TYPES.includes(input.movementType)) {
      // write-off is a reason-coded outbound, NOT a type (FR-002); transfer /
      // count_correction are produced by their own operations only.
      throw new BadRequestException(
        `movementType must be one of ${MANUAL_MOVEMENT_TYPES.join(', ')}`,
      );
    }
    const qtyRaw = Number(input.quantity);
    if (!Number.isFinite(qtyRaw)) {
      throw new BadRequestException('quantity must be a number');
    }
    const qty = Math.round(qtyRaw * 1e4) / 1e4;
    if (qty === 0) {
      throw new BadRequestException('quantity must be non-zero at numeric(19,4) scale');
    }
    if (input.movementType === 'inbound' && qty < 0) {
      throw new BadRequestException('inbound quantity must be positive');
    }
    if (input.movementType === 'outbound' && qty > 0) {
      throw new BadRequestException('outbound quantity must be negative');
    }
    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : null;
    if (input.movementType === 'adjustment' && reason === null) {
      throw new BadRequestException('adjustment requires a reason');
    }
    const stockingUnit = input.stockingUnit.trim();
    if (stockingUnit.length === 0) {
      throw new BadRequestException('stockingUnit is required');
    }
    return { reason, stockingUnit };
  }

  /**
   * Create an intra-tenant transfer as LINKED movements (009-US5, FR-020): a
   * `transfer_out` at the source store and a `transfer_in` at the destination,
   * sharing one `transfer_group_id` so the legs are mutually discoverable
   * (SC-004). BOTH inserts + the audit run in ONE `runWithTenantContext`
   * transaction — a partial transfer (one leg without its counterpart) can never
   * commit and corrupt the on-hand invariant.
   *
   * Validation (server-side):
   *   - source ≠ destination, quantity strictly positive (else 400);
   *   - the destination store MUST resolve within the caller's tenant — the
   *     SELECT runs under RLS, so a cross-tenant destination returns zero rows
   *     and is a non-disclosing 404 (FR-051). (The source is authorized at the
   *     controller against the principal's store scope.)
   *   - each leg's `stockingUnit` MUST match that store's established unit, if
   *     the product already has movements there (FR-022, per-store).
   * Allow-and-flag (FR-024): a transfer-out driving the SOURCE on-hand negative
   * is still recorded — never rejected; the negative balance surfaces on read.
   */
  async createStockTransfer(input: CreateStockTransferInput): Promise<StockTransferBody> {
    // ---- Pre-DB validation -------------------------------------------------
    if (input.sourceStoreId === input.destinationStoreId) {
      throw new BadRequestException('source and destination stores must differ');
    }
    const qtyRaw = Number(input.quantity);
    if (!Number.isFinite(qtyRaw)) {
      throw new BadRequestException('quantity must be a number');
    }
    // Evaluate at numeric(19,4) scale so a sub-0.0001 value cannot slip the
    // positivity rule and persist as a zero-quantity transfer.
    const qty = Math.round(qtyRaw * 1e4) / 1e4;
    if (qty <= 0) {
      throw new BadRequestException('transfer quantity must be strictly positive');
    }
    const stockingUnit = input.stockingUnit.trim();
    if (stockingUnit.length === 0) {
      throw new BadRequestException('stockingUnit is required');
    }
    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : null;

    // Signed magnitudes for the two legs (string form for the numeric cast).
    const outQty = `-${qty.toFixed(4)}`;
    const inQty = qty.toFixed(4);
    const transferGroupId = newId();
    const outId = newId();
    const inId = newId();
    const auditId = newId();

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockTransferBody> => {
        // ---- Destination store must resolve within the tenant (FR-051) ----
        // RLS scopes `stores` to the current tenant, so a cross-tenant
        // destination returns zero rows → non-disclosing 404 (never 403).
        const dest = await client.query<{ id: string }>(
          `SELECT id FROM stores WHERE id = $1`,
          [input.destinationStoreId],
        );
        if (!dest.rows[0]) {
          throw new NotFoundException('Not Found');
        }

        // ---- Per-store cross-unit checks (FR-022) -------------------------
        await this.assertUnitMatchesEstablished(
          client,
          input.sourceStoreId,
          input.tenantProductRef,
          stockingUnit,
        );
        await this.assertUnitMatchesEstablished(
          client,
          input.destinationStoreId,
          input.tenantProductRef,
          stockingUnit,
        );

        // ---- Two linked INSERTs sharing the transfer group ----------------
        const out = await this.insertMovementRow(
          client,
          `INSERT INTO stock_movements
             (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
              tenant_product_ref, reason, occurred_at, transfer_group_id, created_by)
           VALUES
             ($1, $2, $3, 'transfer_out', $4::numeric(19,4), $5, $6, $7, now(), $8, $9)
           RETURNING ${MOVEMENT_COLUMNS}`,
          [
            outId,
            input.tenantId,
            input.sourceStoreId,
            outQty,
            stockingUnit,
            input.tenantProductRef,
            reason,
            transferGroupId,
            input.userId,
          ],
          {
            storeId: input.sourceStoreId,
            tenantProductRef: input.tenantProductRef,
            suppliedUnit: stockingUnit,
          },
        );
        const inb = await this.insertMovementRow(
          client,
          `INSERT INTO stock_movements
             (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
              tenant_product_ref, reason, occurred_at, transfer_group_id, created_by)
           VALUES
             ($1, $2, $3, 'transfer_in', $4::numeric(19,4), $5, $6, $7, now(), $8, $9)
           RETURNING ${MOVEMENT_COLUMNS}`,
          [
            inId,
            input.tenantId,
            input.destinationStoreId,
            inQty,
            stockingUnit,
            input.tenantProductRef,
            reason,
            transferGroupId,
            input.userId,
          ],
          {
            storeId: input.destinationStoreId,
            tenantProductRef: input.tenantProductRef,
            suppliedUnit: stockingUnit,
          },
        );
        const outRow = out.rows[0];
        const inRow = inb.rows[0];
        if (!outRow || !inRow) {
          throw new Error('InventoryService.createStockTransfer: INSERT returned no row');
        }

        // ---- One audit event for the logical transfer (same transaction) --
        await client.query(
          `INSERT INTO audit_events
             (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            auditId,
            input.userId,
            input.tenantId,
            AUDIT_ACTION_TRANSFER_CREATE,
            AUDIT_TARGET_TYPE_TRANSFER,
            transferGroupId,
            JSON.stringify({
              sourceStoreId: input.sourceStoreId,
              destinationStoreId: input.destinationStoreId,
            }),
          ],
        );

        // One outbox event for the logical transfer, naming BOTH linked legs
        // (one operation = one event, mirroring the single audit row). storeId
        // is the source; the payload carries both store ids + both movement ids.
        await this.emitMovementCreated(client, {
          tenantId: input.tenantId,
          storeId: input.sourceStoreId,
          movementIds: [outRow.id, inRow.id],
          movementType: 'transfer',
          tenantProductRef: input.tenantProductRef,
          provenance: {
            transferGroupId,
            sourceStoreId: input.sourceStoreId,
            destinationStoreId: input.destinationStoreId,
          },
        });

        // ---- Negative-balance signal (FR-024) — the transfer_out leg may
        // drive the SOURCE on-hand below zero; flagged, never rejected.
        await this.flagIfNegativeOnHand(client, input.sourceStoreId, input.tenantProductRef);

        return {
          transferGroupId,
          outbound: toMovementBody(outRow),
          inbound: toMovementBody(inRow),
        };
      },
    );
  }

  /**
   * Record a physical stock count and append a `count_correction` movement for
   * any variance (009-US6, FR-021). The history is NEVER rewritten: the variance
   * (counted − derived on-hand) is an APPEND-ONLY signed correction movement
   * linked to the recorded count via `stock_count_id`. After the count, the
   * derived on-hand equals the counted quantity (SC-005). A zero-variance count
   * is deterministic — the count is recorded but NO correction movement is
   * appended (`correctionMovement: null`). The stock_counts insert + the optional
   * correction + the audit all run in ONE `runWithTenantContext` transaction.
   *
   * The store is the PATH-scoped target (authorized at the controller), never a
   * body field (§XII). The count_correction movement is the ONLY movement type
   * that may carry a `stock_count_id` (and MUST, when it is that type) — the
   * 0014 biconditional CHECK enforces it; the composite FK ties it to a count in
   * the SAME tenant + store.
   */
  async recordStockCount(input: RecordStockCountInput): Promise<StockCountResultBody> {
    const countedRaw = Number(input.countedQuantity);
    if (!Number.isFinite(countedRaw)) {
      throw new BadRequestException('countedQuantity must be a number');
    }
    const counted = Math.round(countedRaw * 1e4) / 1e4;
    if (counted < 0) {
      throw new BadRequestException('countedQuantity must be non-negative');
    }
    const stockingUnit = input.stockingUnit.trim();
    if (stockingUnit.length === 0) {
      throw new BadRequestException('stockingUnit is required');
    }

    const stockCountId = newId();
    const auditId = newId();

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockCountResultBody> => {
        // ---- Established-unit check (FR-022) ------------------------------
        await this.assertUnitMatchesEstablished(
          client,
          input.storeId,
          input.tenantProductRef,
          stockingUnit,
        );

        // ---- Derived on-hand at count time (signed SUM) -------------------
        const onHandRow = await client.query<{ quantity: string }>(
          `SELECT COALESCE(SUM(quantity), 0)::numeric(19,4)::text AS quantity
             FROM stock_movements
            WHERE store_id = $1 AND tenant_product_ref = $2`,
          [input.storeId, input.tenantProductRef],
        );
        const derivedOnHand = Number(onHandRow.rows[0]?.quantity ?? '0.0000');
        // Variance = counted − derived on-hand, at numeric(19,4) scale.
        const variance = Math.round((counted - derivedOnHand) * 1e4) / 1e4;
        const varianceStr = variance.toFixed(4);

        // ---- Record the count (provenance for the correction) -------------
        await client.query(
          `INSERT INTO stock_counts
             (id, tenant_id, store_id, tenant_product_ref, counted_quantity,
              derived_on_hand_at_count, stocking_unit, counted_at, created_by)
           VALUES ($1, $2, $3, $4, $5::numeric(19,4), $6::numeric(19,4), $7,
                   COALESCE($8::timestamptz, now()), $9)`,
          [
            stockCountId,
            input.tenantId,
            input.storeId,
            input.tenantProductRef,
            counted.toFixed(4),
            derivedOnHand.toFixed(4),
            stockingUnit,
            input.countedAt ?? null,
            input.userId,
          ],
        );

        // ---- Append the count_correction ONLY for a non-zero variance ----
        let correctionMovement: StockMovementBody | null = null;
        if (variance !== 0) {
          const corr = await this.insertMovementRow(
            client,
            `INSERT INTO stock_movements
               (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
                tenant_product_ref, stock_count_id, reason, occurred_at, created_by)
             VALUES
               ($1, $2, $3, 'count_correction', $4::numeric(19,4), $5, $6, $7,
                'count variance', now(), $8)
             RETURNING ${MOVEMENT_COLUMNS}`,
            [
              newId(),
              input.tenantId,
              input.storeId,
              varianceStr,
              stockingUnit,
              input.tenantProductRef,
              stockCountId,
              input.userId,
            ],
            {
              storeId: input.storeId,
              tenantProductRef: input.tenantProductRef,
              suppliedUnit: stockingUnit,
            },
          );
          const row = corr.rows[0];
          if (!row) {
            throw new Error('InventoryService.recordStockCount: correction INSERT returned no row');
          }
          correctionMovement = toMovementBody(row);
        }

        // ---- Audit the count in the SAME transaction ----------------------
        await client.query(
          `INSERT INTO audit_events
             (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            auditId,
            input.userId,
            input.tenantId,
            AUDIT_ACTION_COUNT_RECORD,
            AUDIT_TARGET_TYPE_COUNT,
            stockCountId,
            JSON.stringify({ variance: varianceStr, hasCorrection: variance !== 0 }),
          ],
        );

        // Emit the movement event ONLY when a correction movement was appended
        // (a zero-variance count records the count + audits it but writes NO
        // movement — so there is no movement.created to emit).
        if (correctionMovement !== null) {
          await this.emitMovementCreated(client, {
            tenantId: input.tenantId,
            storeId: input.storeId,
            movementIds: [correctionMovement.id],
            movementType: correctionMovement.movementType,
            tenantProductRef: input.tenantProductRef,
            provenance: { stockCountId },
          });
        }

        return {
          stockCountId,
          countedQuantity: counted.toFixed(4),
          variance: varianceStr,
          correctionMovement,
        };
      },
    );
  }

  /**
   * Append a sale-linked OUTBOUND from the off-request backfill (009-US4,
   * T052/T064). Idempotent on the provenance pair `(tenant_id, source_system,
   * external_id)` (FR-031/033): a redelivered backfill job for the SAME sale
   * line appends NO second movement and re-applies NO on-hand — it returns the
   * already-persisted movement. Dedup is the partial-unique
   * `uq_stock_movements_tenant_source_external` (migration 0014, R4), NOT a new
   * primitive; on-hand is compute-on-read, so "applied once" is exactly "at most
   * one row inserted" — there is no balance to double-decrement.
   *
   * This is the WORKER seam: the HTTP createStockMovement DTO stays `.strict()`
   * + provenance-free (FR-052); only this entry writes `source_system` /
   * `external_id`. It reuses createStockMovement's validation (outbound sign,
   * established-unit, append-only INSERT + audit-in-transaction) — the only
   * additions are the provenance columns and the ON CONFLICT dedup.
   *
   * DECOUPLING (R8): the caller (T064) reads CAPTURED 008 rows; this method
   * never reads `processed_at`, never subscribes to `sale.captured`, and never
   * mutates the 008 sale fact — the sale ids are recorded by value as provenance.
   *
   * CROSS-PACKAGE SYNC POINT: the off-request worker
   * `apps/worker/src/inventory/backfill.processor.ts` (T064) MIRRORS this
   * INSERT + ON CONFLICT + audit per sale line — apps must not import each
   * other, so the write is duplicated there. Keep the two in sync: any change
   * to the provenance-dedup write semantics MUST be applied to BOTH. A future
   * `packages/inventory` extraction would consolidate them.
   */
  async backfillSaleLinkedOutbound(
    input: BackfillSaleLinkedOutboundInput,
  ): Promise<StockMovementBody> {
    // The backfill of a captured SALE is always an outbound (stock leaves on a
    // sale). Restocks/voids are a separate deferred flow (009-RESTOCK).
    const f = this.validateBackfillInput(input, {
      movementType: 'outbound',
      typeError: 'backfill movementType must be outbound',
      signError: 'outbound quantity must be negative',
      provenanceError: 'backfill requires a non-empty sourceSystem and externalId',
    });

    return this.runBackfillTransaction(input, f, {
      movementType: 'outbound',
      conflictError:
        'InventoryService.backfillSaleLinkedOutbound: conflict with no matching provenance row',
      auditMetadata: {
        sourceSystem: f.sourceSystem,
        externalId: f.externalId,
        correlationId: input.correlationId ?? null,
      },
      outboxProvenance: {
        sourceSystem: f.sourceSystem,
        externalId: f.externalId,
        saleId: input.saleId ?? null,
      },
      // A sale-linked backfill outbound may drive on-hand below zero;
      // flagged, never rejected (FR-024).
      flagNegativeOnHand: true,
    });
  }

  /**
   * Append a void/refund/return → restock INBOUND from the off-request backfill
   * (009-RESTOCK, T090/T091, FR-025/R6). The INBOUND mirror of
   * backfillSaleLinkedOutbound: same provenance-dedup machinery
   * (`uq_stock_movements_tenant_source_external`, idempotent on
   * `(tenant_id, source_system, external_id)`), opposite sign. References the
   * originating 008 void/refund terminal event (or a customer return) as
   * `terminal_event_ref` provenance — read by value, never an FK; the ledger
   * never mutates the 008 fact (R8). A redelivered restock appends no second
   * movement and re-applies no on-hand (FR-031).
   *
   * SCOPE STOP (FR-025/FR-060): this is the MANUAL/BACKFILL entry only. There is
   * deliberately NO automatic restock-on-void route — auto restock is deferred
   * to the same future follow-up as auto-decrement.
   */
  async backfillRestockInbound(
    input: BackfillRestockInboundInput,
  ): Promise<StockMovementBody> {
    const f = this.validateBackfillInput(input, {
      movementType: 'inbound',
      typeError: 'restock movementType must be inbound',
      signError: 'inbound (restock) quantity must be positive',
      provenanceError: 'restock requires a non-empty sourceSystem and externalId',
    });

    return this.runBackfillTransaction(input, f, {
      movementType: 'inbound',
      conflictError:
        'InventoryService.backfillRestockInbound: conflict with no matching provenance row',
      auditMetadata: {
        sourceSystem: f.sourceSystem,
        externalId: f.externalId,
        terminalEventRef: input.terminalEventRef ?? null,
        correlationId: input.correlationId ?? null,
      },
      outboxProvenance: {
        sourceSystem: f.sourceSystem,
        externalId: f.externalId,
        terminalEventRef: input.terminalEventRef ?? null,
      },
      // A restock is an INBOUND (positive) — it cannot drive on-hand below
      // zero, so no negative-balance signal probe is needed (FR-024).
      flagNegativeOnHand: false,
    });
  }

  /**
   * Shared pre-DB validation for the two provenance-dedup backfill entries
   * (mirrors the manual sign rules; the numeric(19,4)-scale zero rule matches
   * createStockMovement).
   */
  private validateBackfillInput(
    input: BackfillSaleLinkedOutboundInput | BackfillRestockInboundInput,
    spec: {
      movementType: 'outbound' | 'inbound';
      typeError: string;
      signError: string;
      provenanceError: string;
    },
  ): NormalizedBackfillFields {
    if (input.movementType !== spec.movementType) {
      throw new BadRequestException(spec.typeError);
    }
    const qtyRaw = Number(input.quantity);
    if (!Number.isFinite(qtyRaw)) {
      throw new BadRequestException('quantity must be a number');
    }
    const qty = Math.round(qtyRaw * 1e4) / 1e4;
    if (qty === 0) {
      throw new BadRequestException('quantity must be non-zero at numeric(19,4) scale');
    }
    const wrongSign = spec.movementType === 'outbound' ? qty > 0 : qty < 0;
    if (wrongSign) {
      throw new BadRequestException(spec.signError);
    }
    const sourceSystem = input.sourceSystem.trim();
    const externalId = input.externalId.trim();
    if (sourceSystem.length === 0 || externalId.length === 0) {
      // The pair is the dedup key — a blank half cannot dedup (DB CHECK keeps it
      // all-or-nothing, but reject early with an actionable message).
      throw new BadRequestException(spec.provenanceError);
    }
    const stockingUnit = input.stockingUnit.trim();
    if (stockingUnit.length === 0) {
      throw new BadRequestException('stockingUnit is required');
    }
    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : null;
    return {
      sourceSystem,
      externalId,
      stockingUnit,
      reason,
      tenantProductRef: input.tenantProductRef ?? null,
    };
  }

  /**
   * Shared idempotent-append transaction for the two backfill entries:
   * cross-unit check (FR-022) → ON CONFLICT DO NOTHING append on the
   * provenance pair (FR-031/033; the conflict target restates the partial
   * index predicate — source/external NOT NULL — or Postgres won't match the
   * partial index) → audit + outbox emit ONLY on a genuine append (a
   * redelivered job writes no duplicate audit and does NOT double-emit) →
   * optional negative-balance probe (FR-024).
   */
  private runBackfillTransaction(
    input: BackfillSaleLinkedOutboundInput | BackfillRestockInboundInput,
    f: NormalizedBackfillFields,
    spec: {
      movementType: 'outbound' | 'inbound';
      conflictError: string;
      auditMetadata: Record<string, unknown>;
      outboxProvenance: Record<string, unknown>;
      flagNegativeOnHand: boolean;
    },
  ): Promise<StockMovementBody> {
    const movementId = newId();
    const auditId = newId();

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockMovementBody> => {
        // ---- Cross-unit check (FR-022) — same rule as the manual path -----
        if (f.tenantProductRef !== null) {
          await this.assertUnitMatchesEstablished(
            client,
            input.storeId,
            f.tenantProductRef,
            f.stockingUnit,
          );
        }

        // ---- Idempotent append on the provenance pair ----------------------
        const inserted = await this.insertMovementRow(
          client,
          `INSERT INTO stock_movements
             (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
              tenant_product_ref, reason, occurred_at, source_system, external_id,
              sale_id, sale_line_id, terminal_event_ref, created_by)
           VALUES
             ($1, $2, $3, $4, $5::numeric(19,4), $6, $7, $8,
              COALESCE($9::timestamptz, now()), $10, $11, $12, $13, $14, $15)
           ON CONFLICT (tenant_id, source_system, external_id)
             WHERE source_system IS NOT NULL AND external_id IS NOT NULL
             DO NOTHING
           RETURNING ${MOVEMENT_COLUMNS}`,
          [
            movementId,
            input.tenantId,
            input.storeId,
            spec.movementType,
            input.quantity,
            f.stockingUnit,
            f.tenantProductRef,
            f.reason,
            input.occurredAt ?? null,
            f.sourceSystem,
            f.externalId,
            input.saleId ?? null,
            input.saleLineId ?? null,
            input.terminalEventRef ?? null,
            input.userId,
          ],
          {
            storeId: input.storeId,
            tenantProductRef: f.tenantProductRef,
            suppliedUnit: f.stockingUnit,
          },
        );

        const row = inserted.rows[0];
        if (!row) {
          // Conflict: a movement for this provenance pair already exists. Return
          // it WITHOUT a second INSERT and WITHOUT a second audit/side-effect —
          // on-hand stays applied exactly once (FR-031/033).
          const existing = await client.query<MovementRow>(
            `SELECT ${MOVEMENT_COLUMNS}
               FROM stock_movements
              WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3`,
            [input.tenantId, f.sourceSystem, f.externalId],
          );
          const existingRow = existing.rows[0];
          if (!existingRow) {
            // Should be unreachable: DO NOTHING fired but no row matches the
            // pair. Surface loudly rather than silently double-applying.
            throw new Error(spec.conflictError);
          }
          return toMovementBody(existingRow);
        }

        // ---- Audit event in the SAME transaction (FR-013, SC-007) ---------
        // Only on a genuine append. correlationId is recorded for backfill
        // traceability; no PII/payload is persisted (§XIV).
        await client.query(
          `INSERT INTO audit_events
             (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            auditId,
            input.userId,
            input.tenantId,
            AUDIT_ACTION_MOVEMENT_BACKFILL,
            AUDIT_TARGET_TYPE_MOVEMENT,
            row.id,
            JSON.stringify(spec.auditMetadata),
          ],
        );

        await this.emitMovementCreated(client, {
          tenantId: input.tenantId,
          storeId: input.storeId,
          movementIds: [row.id],
          movementType: row.movement_type,
          tenantProductRef: f.tenantProductRef,
          correlationId: input.correlationId ?? null,
          provenance: spec.outboxProvenance,
        });

        if (spec.flagNegativeOnHand) {
          await this.flagIfNegativeOnHand(client, input.storeId, f.tenantProductRef);
        }

        return toMovementBody(row);
      },
    );
  }

  /**
   * Throw `CrossUnitError` if the product already has movements at the store in
   * a stocking unit different from `suppliedUnit` (FR-022). Runs on the same
   * RLS-active client as the insert.
   *
   * Concurrency caveat (v1, best-effort at the app layer): this is a
   * read-before-insert under READ COMMITTED, so two concurrent FIRST movements
   * for the same `(store, product)` in different units could both see "no
   * established unit" and both commit, leaving divergent units. For manual entry
   * this is rare. A hard guarantee belongs at the data layer (a UNIQUE
   * `(store_id, tenant_product_ref, stocking_unit)`-style trigger/constraint, or
   * a per-key advisory lock) — that touches `packages/db/**` (a [GATED] path
   * outside this slice's allowed_files), so it is a documented follow-up, not
   * silently reached into here.
   */
  private async assertUnitMatchesEstablished(
    client: PoolClient,
    storeId: string,
    tenantProductRef: string,
    suppliedUnit: string,
  ): Promise<void> {
    const r = await client.query<{ stocking_unit: string }>(
      `SELECT stocking_unit FROM stock_movements
        WHERE store_id = $1 AND tenant_product_ref = $2
        ORDER BY received_at ASC, id ASC
        LIMIT 1`,
      [storeId, tenantProductRef],
    );
    const established = r.rows[0]?.stocking_unit;
    if (established !== undefined && established !== suppliedUnit) {
      throw new CrossUnitError(established, suppliedUnit);
    }
  }

  /**
   * Run a stock_movements INSERT and translate the established-unit EXCLUDE
   * violation (migration 0016) into the same `CrossUnitError` (400) the
   * sequential pre-check throws — so the rare concurrent-race path returns a
   * clean 400, not a raw 500. `assertUnitMatchesEstablished` remains the
   * friendly common-path 400; this is the backstop for the true-concurrency
   * window the pre-check can't close under READ COMMITTED. On the violation we
   * re-query the now-established unit (one extra SELECT, only when the race
   * actually fired) so the error carries the same (expected, supplied) shape.
   */
  private async insertMovementRow(
    client: PoolClient,
    sql: string,
    params: readonly unknown[],
    context: {
      readonly storeId: string;
      readonly tenantProductRef: string | null;
      readonly suppliedUnit: string;
    },
  ): Promise<{ rows: MovementRow[] }> {
    try {
      return await client.query<MovementRow>(sql, params as unknown[]);
    } catch (err: unknown) {
      if (isUnitExclusionViolation(err) && context.tenantProductRef !== null) {
        const established = await client.query<{ stocking_unit: string }>(
          `SELECT stocking_unit FROM stock_movements
            WHERE store_id = $1 AND tenant_product_ref = $2
            ORDER BY received_at ASC, id ASC
            LIMIT 1`,
          [context.storeId, context.tenantProductRef],
        );
        throw new CrossUnitError(
          established.rows[0]?.stocking_unit ?? context.suppliedUnit,
          context.suppliedUnit,
        );
      }
      throw err;
    }
  }

  /**
   * Emit the negative-balance SIGNAL (009-SIGNAL-NEGBAL / FR-024) if the
   * post-write derived on-hand for a (store, product) is below zero. Called
   * after an outbound write (manual outbound / transfer_out / sale-linked
   * backfill) on the SAME RLS-active client, INSIDE the write transaction so the
   * SUM includes the just-appended row.
   *
   * Allow-and-flag: this is a signal, never an error. It NEVER throws — a metric
   * failure must not roll back or block a legitimate movement. A null
   * `tenantProductRef` (ad-hoc) has no product on-hand to flag, so it is skipped.
   */
  private async flagIfNegativeOnHand(
    client: PoolClient,
    storeId: string,
    tenantProductRef: string | null,
  ): Promise<void> {
    if (tenantProductRef === null) return;
    try {
      const r = await client.query<{ quantity: string }>(
        `SELECT COALESCE(SUM(quantity), 0)::numeric(19,4)::text AS quantity
           FROM stock_movements
          WHERE store_id = $1 AND tenant_product_ref = $2`,
        [storeId, tenantProductRef],
      );
      if (Number(r.rows[0]?.quantity ?? '0') < 0) {
        recordInventoryNegativeBalance();
      }
    } catch {
      // Signal-only: never let a metric/probe failure affect the write (FR-024).
    }
  }

  /**
   * Emit the `inventory.movement.created` outbox event (009 / issue #465 part B)
   * on the CALLER's client, IN-TRANSACTION with the movement append + its audit
   * row — so the event is committed iff the movement is (atomic; a rollback
   * drops both). Call this at exactly the same site + under the same guard as
   * the audit INSERT (the genuine-append branch only — never the backfill dedup
   * early-return, or a redelivered backfill would double-emit and break FR-033).
   * Payload carries IDs + provenance ONLY — no money, no PII (§XIV), mirroring
   * the audit metadata. `movementIds` is an array so the transfer path (two
   * linked legs, one logical operation) names both legs.
   */
  private async emitMovementCreated(
    client: PoolClient,
    input: {
      readonly tenantId: string;
      readonly storeId: string;
      readonly movementIds: readonly string[];
      readonly movementType: string;
      readonly tenantProductRef?: string | null;
      readonly correlationId?: string | null;
      readonly provenance?: Record<string, unknown>;
    },
  ): Promise<void> {
    await emit(client, {
      eventType: OUTBOX_EVENT_TYPES.INVENTORY_MOVEMENT_CREATED,
      tenantId: input.tenantId,
      storeId: input.storeId,
      payload: {
        movementIds: input.movementIds,
        movementType: input.movementType,
        tenantProductRef: input.tenantProductRef ?? null,
        ...(input.provenance ?? {}),
      },
      // outbox_events.correlation_id is UUID — only forward a well-formed UUID;
      // a non-UUID upstream tag (or the audit-style text correlation) must NOT
      // fail the movement write. The full value, if any, is on the audit row.
      correlationId: isUuid(input.correlationId) ? input.correlationId : null,
    });
  }
}
