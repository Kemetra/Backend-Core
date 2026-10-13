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
 *
 * Position (RT-432; RT-290 G4-1…G4-6): every movement a write path appends
 * lands at an explicit (stock location, inventory status) of its own store —
 * the store's `primary` location and `sellable` unless a manual movement names
 * another location / status. Movements recorded before 0044 have no position
 * and are READ as (the store's primary location, sellable) with
 * `positionInterpreted: true`; they are never updated (G4-5). On-hand stays the
 * total over every location and status (973) and adds a per-status breakdown.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  runWithTenantContext,
  emit,
  INVENTORY_STATUSES,
  OUTBOX_EVENT_TYPES,
  type InventoryStatus,
} from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../auth/auth.module';
import { recordInventoryNegativeBalance } from '../observability/metrics/api.metrics';
import { formatQuantity, parseQuantity } from './decimal-quantity';
import {
  encodeTrackingIdentityCursor,
  type TrackingIdentityCursor,
} from './tracking-identity.cursor';

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
  /**
   * RT-432: a location of the path store; defaults to the store's primary
   * location (RT-290 G4-6).
   */
  readonly stockLocationId?: string | null | undefined;
  /** RT-432: defaults to `sellable` (RT-290 G4-6). */
  readonly inventoryStatus?: InventoryStatus | null | undefined;
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
  /** RT-425 (RT-289 G2-2): the effect's origin — `retail` | `erp_external`. */
  readonly origin: string;
  /**
   * RT-425 (RT-289 G2-3): the effect's ERP integration state, or null when the
   * effect has no integration record.
   */
  readonly integrationState: string | null;
  /** RT-425 (RT-289 G2-4): when ERP confirmed the effect; null until then. */
  readonly erpConfirmedAt: string | null;
  /** RT-432 (RT-290 G4-1): the effect's stock location. */
  readonly stockLocationId: string;
  /** RT-432 (RT-290 G4-2): the effect's inventory status. */
  readonly inventoryStatus: string;
  /**
   * RT-432 (RT-290 G4-5): true for a movement recorded before positions existed,
   * whose position is read as (the store's primary location, sellable).
   */
  readonly positionInterpreted: boolean;
  /**
   * RT-448 (RT-50 G7-2): the tracking identity of the movement's own product;
   * null for an untracked product and for every movement written today.
   */
  readonly trackingIdentityId: string | null;
}

/** RT-432: one inventory status's share of the on-hand (contract `StatusQuantity`). */
export interface StatusQuantityBody {
  readonly inventoryStatus: InventoryStatus;
  readonly quantity: string;
}

/** Wire projection of the derived on-hand (contract `OnHand`, FR-003/024). */
export interface OnHandBody {
  readonly storeId: string;
  readonly productId: string;
  /** Physical on-hand: every location and status of the store (732, 973). */
  readonly quantity: string;
  readonly stockingUnit: string | null;
  readonly negativeBalance: boolean;
  /** RT-432: the `sellable` share (733); ATS is derived from it later (742). */
  readonly sellableQuantity: string;
  /** RT-432: one entry per inventory status, in enum order (745). */
  readonly statusQuantities: readonly StatusQuantityBody[];
}

/** RT-432: wire projection of a stock location (contract `StockLocation`). */
export interface StockLocationBody {
  readonly id: string;
  readonly storeId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly isActive: boolean;
}

export interface StockLocationListBody {
  readonly items: readonly StockLocationBody[];
}

/** RT-448: wire projection of a tracking identity (contract `TrackingIdentity`). */
export interface TrackingIdentityBody {
  readonly id: string;
  readonly productId: string;
  readonly kind: string;
  readonly code: string;
  /** Calendar date `YYYY-MM-DD`, or null. */
  readonly expiryDate: string | null;
  readonly manufacturedOn: string | null;
  readonly origin: string;
}

export interface TrackingIdentityListBody {
  readonly items: readonly TrackingIdentityBody[];
  /** Opaque cursor for the next page; null when exhausted. */
  readonly nextCursor: string | null;
}

interface TrackingIdentityRow {
  id: string;
  tenant_product_ref: string;
  kind: string;
  code: string;
  expiry_date: string | null;
  manufactured_on: string | null;
  origin: string;
  /** The keyset sort value: the expiry date, or `infinity`. */
  sort_expiry: string;
}

function toTrackingIdentityBody(t: TrackingIdentityRow): TrackingIdentityBody {
  return {
    id: t.id,
    productId: t.tenant_product_ref,
    kind: t.kind,
    code: t.code,
    expiryDate: t.expiry_date,
    manufacturedOn: t.manufactured_on,
    origin: t.origin,
  };
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
  origin: string;
  /** From inventory_effect_integration; absent on a bare RETURNING row. */
  integration_state?: string | null;
  erp_confirmed_at?: Date | null;
  /** RT-432: NULL only on a movement recorded before 0044. */
  stock_location_id: string | null;
  inventory_status: string | null;
  /** RT-432: the store's primary location, joined on reads (G4-5). */
  primary_location_id?: string | null;
  /** RT-448 (G7-2): the typed tracking reference; NULL when untracked. */
  tracking_identity_id: string | null;
}

const MOVEMENT_COLUMN_NAMES = [
  'id', 'store_id', 'movement_type', 'quantity', 'stocking_unit', 'tenant_product_ref',
  'reason', 'occurred_at', 'received_at', 'sale_id', 'sale_line_id', 'terminal_event_ref',
  'transfer_group_id', 'stock_count_id', 'created_by', 'origin',
  'stock_location_id', 'inventory_status', 'tracking_identity_id',
] as const;

const MOVEMENT_COLUMNS = MOVEMENT_COLUMN_NAMES.join(', ');

/**
 * RT-425: movement columns qualified by `m`, plus the effect's integration
 * state, for reads that LEFT JOIN inventory_effect_integration `i`.
 * RT-432: plus the store's primary location, for reads that LEFT JOIN it as
 * `p` (MOVEMENT_POSITION_JOIN) to resolve a pre-0044 movement's position.
 */
const MOVEMENT_COLUMNS_WITH_INTEGRATION = [
  ...MOVEMENT_COLUMN_NAMES.map((c) => `m.${c}`),
  'i.state AS integration_state',
  'i.erp_confirmed_at',
  'p.id AS primary_location_id',
].join(', ');

/** RT-432 (G4-5): the store's primary location, for reading legacy positions. */
const MOVEMENT_POSITION_JOIN =
  "LEFT JOIN stock_locations p ON p.store_id = m.store_id AND p.kind = 'primary'";

/** RT-432 (RT-290 G4-6): the status a V1 write lands in unless told otherwise. */
const DEFAULT_INVENTORY_STATUS: InventoryStatus = 'sellable';

/** RT-432: the position a movement is written at. */
interface EffectPosition {
  readonly stockLocationId: string;
  readonly inventoryStatus: InventoryStatus;
}

/** RT-425: the state every Retail effect starts in until an ERP intent exists. */
const NOT_POSTED = 'not_posted';

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
    origin: r.origin,
    integrationState: r.integration_state ?? null,
    erpConfirmedAt: r.erp_confirmed_at ? r.erp_confirmed_at.toISOString() : null,
    ...toPositionBody(r),
    trackingIdentityId: r.tracking_identity_id,
  };
}

/**
 * RT-432 (RT-290 G4-5): a movement's position. A movement recorded before 0044
 * has none and is read as (the store's primary location, sellable).
 */
function toPositionBody(
  r: MovementRow,
): Pick<StockMovementBody, 'stockLocationId' | 'inventoryStatus' | 'positionInterpreted'> {
  if (r.stock_location_id !== null && r.inventory_status !== null) {
    return {
      stockLocationId: r.stock_location_id,
      inventoryStatus: r.inventory_status,
      positionInterpreted: false,
    };
  }
  if (!r.primary_location_id) {
    // 0044 gives every store a primary location; a missing one is a broken
    // invariant, never a position to guess.
    throw new Error(`InventoryService: store ${r.store_id} has no primary stock location`);
  }
  return {
    stockLocationId: r.primary_location_id,
    inventoryStatus: DEFAULT_INVENTORY_STATUS,
    positionInterpreted: true,
  };
}

/** RT-425: a just-written Retail effect, whose integration record is `not_posted`. */
function asNotPosted(r: MovementRow): MovementRow {
  return { ...r, integration_state: NOT_POSTED, erp_confirmed_at: null };
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
  getOnHand(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly productId: string;
  }): Promise<OnHandBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<OnHandBody> => {
        await this.assertReferencesInTenant(client, { storeIds: [input.storeId] });
        // Store scope is the WHERE clause + object-level authz at the
        // controller; 0014 has tenant RLS only (no store policy), so no
        // app.current_store GUC is needed.
        // RT-432: ONE statement, so the total and its per-status split come from
        // the same snapshot (two statements under READ COMMITTED could see
        // different commits and break "the entries sum to quantity"). SUM in
        // SQL at the column's numeric(19,4) scale (uniform "7.0000" wire
        // format); the total is the exact BigInt sum of the group rows. A
        // movement recorded before 0044 has no status and counts as sellable
        // (G4-5). stocking_unit is consistent per product (FR-022, 0016); NULL
        // when there are no movements.
        const byStatus = await client.query<{
          inventory_status: string;
          quantity: string;
          stocking_unit: string;
        }>(
          `SELECT COALESCE(inventory_status, '${DEFAULT_INVENTORY_STATUS}') AS inventory_status,
                  SUM(quantity)::numeric(19,4)::text AS quantity,
                  MIN(stocking_unit) AS stocking_unit
             FROM stock_movements
            WHERE store_id = $1 AND tenant_product_ref = $2
            GROUP BY 1`,
          [input.storeId, input.productId],
        );
        const quantity = formatQuantity(
          byStatus.rows.reduce((sum, row) => sum + parseQuantity(row.quantity), 0n),
        );
        const statusQuantities = INVENTORY_STATUSES.map((status) => ({
          inventoryStatus: status,
          quantity:
            byStatus.rows.find((row) => row.inventory_status === status)?.quantity ?? '0.0000',
        }));
        return {
          storeId: input.storeId,
          productId: input.productId,
          quantity,
          stockingUnit: byStatus.rows[0]?.stocking_unit ?? null,
          negativeBalance: parseQuantity(quantity) < 0n,
          sellableQuantity:
            statusQuantities.find((q) => q.inventoryStatus === DEFAULT_INVENTORY_STATUS)
              ?.quantity ?? '0.0000',
          statusQuantities,
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
        await this.assertReferencesInTenant(client, { storeIds: [input.storeId] });
        // productId present → that product; absent → ad-hoc (NULL) movements.
        const hasProduct =
          input.productId !== null && input.productId !== undefined;
        const productPredicate = hasProduct
          ? 'm.tenant_product_ref = $2'
          : 'm.tenant_product_ref IS NULL';
        const params: unknown[] = hasProduct
          ? [input.storeId, input.productId, limit]
          : [input.storeId, limit];
        const limitParam = hasProduct ? '$3' : '$2';
        // RT-425: each effect carries its integration state (LEFT JOIN: an
        // effect without an integration record projects null).
        const r = await client.query<MovementRow>(
          `SELECT ${MOVEMENT_COLUMNS_WITH_INTEGRATION}
             FROM stock_movements m
             LEFT JOIN inventory_effect_integration i ON i.effect_id = m.id
             ${MOVEMENT_POSITION_JOIN}
            WHERE m.store_id = $1 AND ${productPredicate}
            ORDER BY m.occurred_at ASC, m.id ASC
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
   * RT-432 (RT-290 G4-1): the stock locations of a (tenant, store), primary
   * first, then by code. Read-only; locations are created with their store.
   */
  listStockLocations(input: {
    readonly tenantId: string;
    readonly storeId: string;
  }): Promise<StockLocationListBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockLocationListBody> => {
        await this.assertReferencesInTenant(client, { storeIds: [input.storeId] });
        const r = await client.query<{
          id: string;
          store_id: string;
          code: string;
          name: string;
          kind: string;
          is_active: boolean;
        }>(
          `SELECT id, store_id, code, name, kind, is_active
             FROM stock_locations
            WHERE store_id = $1
            ORDER BY (kind = 'primary') DESC, code ASC, id ASC`,
          [input.storeId],
        );
        return {
          items: r.rows.map((l) => ({
            id: l.id,
            storeId: l.store_id,
            code: l.code,
            name: l.name,
            kind: l.kind,
            isActive: l.is_active,
          })),
        };
      },
    );
  }

  /**
   * RT-448 (RT-50 G7-2): the tenant's tracking identities of one product,
   * ordered by kind, then expiry (earliest first, none last), then code, in
   * keyset pages of at most MAX_LIMIT (a serial product has one identity per
   * unit). Read-only; identities are ERP-born (G7-3) and nothing creates one yet
   * (RT-453). A product outside the tenant is a non-disclosing 404 (FR-051):
   * RLS hides other tenants' products and identities alike.
   */
  async listTrackingIdentities(input: {
    readonly tenantId: string;
    readonly productId: string;
    readonly limit?: number | undefined;
    readonly cursor?: TrackingIdentityCursor | undefined;
  }): Promise<TrackingIdentityListBody> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<TrackingIdentityListBody> => {
        const product = await client.query<{ id: string }>(
          `SELECT id FROM tenant_products WHERE id = $1`,
          [input.productId],
        );
        if (!product.rows[0]) throw new NotFoundException('Not Found');
        const after = input.cursor;
        // Keyset page over (kind, expiry NULLS LAST, code, id); a missing
        // expiry sorts as 'infinity'. One extra row tells whether more exist.
        const r = await client.query<TrackingIdentityRow>(
          `SELECT id, tenant_product_ref, kind, code, expiry_date::text AS expiry_date,
                  manufactured_on::text AS manufactured_on, origin,
                  COALESCE(expiry_date, 'infinity'::date)::text AS sort_expiry
             FROM tracking_identities
            WHERE tenant_product_ref = $1
              AND ($2::text IS NULL
                   OR (kind, COALESCE(expiry_date, 'infinity'::date), code, id)
                      > ($2::text, $3::date, $4::text, $5::uuid))
            ORDER BY kind ASC, COALESCE(expiry_date, 'infinity'::date) ASC, code ASC, id ASC
            LIMIT $6`,
          [
            input.productId,
            after?.kind ?? null,
            after?.expiry ?? null,
            after?.code ?? null,
            after?.id ?? null,
            limit + 1,
          ],
        );
        const page = r.rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(toTrackingIdentityBody),
          nextCursor:
            r.rows.length > limit && last
              ? encodeTrackingIdentityCursor({
                  productId: input.productId,
                  kind: last.kind,
                  expiry: last.sort_expiry,
                  code: last.code,
                  id: last.id,
                })
              : null,
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
        await this.assertReferencesInTenant(client, {
          storeIds: [input.storeId],
          tenantProductRef,
        });
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

        // ---- Position (RT-432, RT-290 G4-6) ------------------------------
        const position = await this.resolvePosition(client, input.storeId, {
          stockLocationId: input.stockLocationId ?? null,
          inventoryStatus: input.inventoryStatus ?? null,
        });

        // ---- Append-only INSERT ------------------------------------------
        // tenant_id / store_id / created_by are the server-resolved values
        // (principal + path), never the body. occurred_at defaults to now()
        // when omitted; received_at defaults in the schema (security clock).
        const inserted = await this.insertMovementRow(
          client,
          // RT-425: a manual movement is its own governed `adjustment` Business
          // Event (RT-289 G2-1, decision 838), identified by the movement id.
          `INSERT INTO stock_movements
             (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
              tenant_product_ref, reason, occurred_at, sale_id, sale_line_id,
              terminal_event_ref, created_by, event_type, event_ref_id,
              stock_location_id, inventory_status)
           VALUES
             ($1, $2, $3, $4, $5::numeric(19,4), $6, $7, $8,
              COALESCE($9::timestamptz, now()), $10, $11, $12, $13, 'adjustment', $1,
              $14, $15)
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
            position.stockLocationId,
            position.inventoryStatus,
          ],
          { storeId: input.storeId, tenantProductRef, suppliedUnit: stockingUnit },
        );
        const row = inserted.rows[0];
        if (!row) {
          throw new Error('InventoryService.createStockMovement: INSERT returned no row');
        }
        await this.recordNotPosted(client, input.tenantId, [row.id]);

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

        return toMovementBody(asNotPosted(row));
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
    const qty = parseQuantity(input.quantity);
    if (qty === 0n) {
      throw new BadRequestException('quantity must be non-zero at numeric(19,4) scale');
    }
    if (input.movementType === 'inbound' && qty < 0n) {
      throw new BadRequestException('inbound quantity must be positive');
    }
    if (input.movementType === 'outbound' && qty > 0n) {
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
    const qty = parseQuantity(input.quantity);
    if (qty <= 0n) {
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
    const outQty = formatQuantity(-qty);
    const inQty = formatQuantity(qty);
    const transferGroupId = newId();
    const outId = newId();
    const inId = newId();
    const auditId = newId();

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockTransferBody> => {
        // ---- Both stores and the product must resolve within the tenant ----
        // (FR-051 / RT-61): a cross-tenant or unknown reference → 404.
        await this.assertReferencesInTenant(client, {
          storeIds: [input.sourceStoreId, input.destinationStoreId],
          tenantProductRef: input.tenantProductRef,
        });

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

        // ---- Positions (RT-432, RT-290 G4-6): each store's primary, sellable.
        // The instant transfer is not the target shipment workflow (974, Gate 5).
        const outPosition = await this.resolvePosition(client, input.sourceStoreId);
        const inPosition = await this.resolvePosition(client, input.destinationStoreId);

        // ---- Two linked INSERTs sharing the transfer group ----------------
        const out = await this.insertMovementRow(
          client,
          `INSERT INTO stock_movements
             (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
              tenant_product_ref, reason, occurred_at, transfer_group_id, created_by,
              event_type, event_ref_id, stock_location_id, inventory_status)
           VALUES
             ($1, $2, $3, 'transfer_out', $4::numeric(19,4), $5, $6, $7, now(), $8, $9,
              'transfer', $8, $10, $11)
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
            outPosition.stockLocationId,
            outPosition.inventoryStatus,
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
              tenant_product_ref, reason, occurred_at, transfer_group_id, created_by,
              event_type, event_ref_id, stock_location_id, inventory_status)
           VALUES
             ($1, $2, $3, 'transfer_in', $4::numeric(19,4), $5, $6, $7, now(), $8, $9,
              'transfer', $8, $10, $11)
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
            inPosition.stockLocationId,
            inPosition.inventoryStatus,
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
        // RT-425: both legs belong to one `transfer` Business Event (the
        // transfer group) and start `not_posted`, in this transaction.
        await this.recordNotPosted(client, input.tenantId, [outRow.id, inRow.id]);

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
          outbound: toMovementBody(asNotPosted(outRow)),
          inbound: toMovementBody(asNotPosted(inRow)),
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
    const counted = parseQuantity(input.countedQuantity, 'countedQuantity');
    if (counted < 0n) {
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
        await this.assertReferencesInTenant(client, {
          storeIds: [input.storeId],
          tenantProductRef: input.tenantProductRef,
        });
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
        const derivedOnHand = parseQuantity(onHandRow.rows[0]?.quantity ?? '0.0000');
        // Check the calculated variance before attempting a numeric(19,4) insert.
        const variance = counted - derivedOnHand;
        const varianceStr = formatQuantity(variance, 'variance');

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
            formatQuantity(counted),
            formatQuantity(derivedOnHand),
            stockingUnit,
            input.countedAt ?? null,
            input.userId,
          ],
        );

        // ---- Append the count_correction ONLY for a non-zero variance ----
        let correctionMovement: StockMovementBody | null = null;
        if (variance !== 0n) {
          // RT-432 (RT-290 G4-6): the immediate count corrects the store's
          // primary location, sellable; Gate 6 (RT-292) scopes counts by position.
          const position = await this.resolvePosition(client, input.storeId);
          const corr = await this.insertMovementRow(
            client,
            `INSERT INTO stock_movements
               (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
                tenant_product_ref, stock_count_id, reason, occurred_at, created_by,
                event_type, event_ref_id, stock_location_id, inventory_status)
             VALUES
               ($1, $2, $3, 'count_correction', $4::numeric(19,4), $5, $6, $7,
                'count variance', now(), $8, 'count', $7, $9, $10)
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
              position.stockLocationId,
              position.inventoryStatus,
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
          // RT-425: the correction is the `count` Business Event's effect
          // (the recorded count) and starts `not_posted`, in this transaction.
          await this.recordNotPosted(client, input.tenantId, [row.id]);
          correctionMovement = toMovementBody(asNotPosted(row));
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
            JSON.stringify({ variance: varianceStr, hasCorrection: variance !== 0n }),
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
          countedQuantity: formatQuantity(counted),
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
    const qty = parseQuantity(input.quantity);
    if (qty === 0n) {
      throw new BadRequestException('quantity must be non-zero at numeric(19,4) scale');
    }
    const wrongSign = spec.movementType === 'outbound' ? qty > 0n : qty < 0n;
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

        // RT-432 (RT-290 G4-6): the store's primary location, sellable.
        const position = await this.resolvePosition(client, input.storeId);

        // ---- Idempotent append on the provenance pair ----------------------
        const inserted = await this.insertMovementRow(
          client,
          `INSERT INTO stock_movements
             (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
              tenant_product_ref, reason, occurred_at, source_system, external_id,
              sale_id, sale_line_id, terminal_event_ref, created_by,
              stock_location_id, inventory_status)
           VALUES
             ($1, $2, $3, $4, $5::numeric(19,4), $6, $7, $8,
              COALESCE($9::timestamptz, now()), $10, $11, $12, $13, $14, $15, $16, $17)
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
            position.stockLocationId,
            position.inventoryStatus,
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
          const movementColumns = MOVEMENT_COLUMN_NAMES.map(
            (c) => `m.${c}`,
          ).join(', ');
          const existing = await client.query<MovementRow>(
            `SELECT ${movementColumns},
                    p.id AS primary_location_id
               FROM stock_movements m
               ${MOVEMENT_POSITION_JOIN}
              WHERE m.tenant_id = $1 AND m.source_system = $2 AND m.external_id = $3`,
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
  /**
   * The addressed store(s) and product must exist in the CURRENT tenant
   * (RT-61). Runs on the tenant-context client, so RLS hides other tenants'
   * rows: an unknown, soft-deleted or cross-tenant reference is a
   * non-disclosing 404 (FR-051). Without it a write reached the
   * `stock_movements` foreign keys — which do not apply RLS — and either
   * failed as a 500 or accepted another tenant's store / product id.
   */
  private async assertReferencesInTenant(
    client: PoolClient,
    refs: { readonly storeIds: readonly string[]; readonly tenantProductRef?: string | null },
  ): Promise<void> {
    const storeIds = [...new Set(refs.storeIds)];
    const found = await client.query<{ id: string }>(
      `SELECT id FROM stores WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [storeIds],
    );
    if (found.rows.length !== storeIds.length) throw new NotFoundException('Not Found');

    const productRef = refs.tenantProductRef ?? null;
    if (productRef !== null) {
      const product = await client.query<{ id: string }>(
        `SELECT id FROM tenant_products WHERE id = $1`,
        [productRef],
      );
      if (!product.rows[0]) throw new NotFoundException('Not Found');
    }
  }

  /**
   * RT-432 (RT-290 G4-6): the position a write lands at. Without an explicit
   * location the store's `primary` location; without an explicit status
   * `sellable`. Runs on the tenant-context client, so RLS hides other tenants'
   * locations: an explicit location that is not one of THIS store's locations
   * in this tenant is a non-disclosing 404 (FR-051), and an inactive one is a
   * 400. The composite FK (stock_location_id, store_id, tenant_id) is the
   * database backstop for both. A store with no visible primary location is
   * not a store of this tenant (0044 gives every store one): 404.
   */
  private async resolvePosition(
    client: PoolClient,
    storeId: string,
    explicit: {
      readonly stockLocationId?: string | null;
      readonly inventoryStatus?: InventoryStatus | null;
    } = {},
  ): Promise<EffectPosition> {
    const inventoryStatus = explicit.inventoryStatus ?? DEFAULT_INVENTORY_STATUS;
    if (!INVENTORY_STATUSES.includes(inventoryStatus)) {
      throw new BadRequestException(
        `inventoryStatus must be one of ${INVENTORY_STATUSES.join(', ')}`,
      );
    }
    const location = explicit.stockLocationId
      ? await client.query<{ id: string; is_active: boolean }>(
          `SELECT id, is_active FROM stock_locations WHERE id = $1 AND store_id = $2`,
          [explicit.stockLocationId, storeId],
        )
      : await client.query<{ id: string; is_active: boolean }>(
          `SELECT id, is_active FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`,
          [storeId],
        );
    const row = location.rows[0];
    if (!row) throw new NotFoundException('Not Found');
    if (!row.is_active) {
      throw new BadRequestException('stockLocationId names an inactive stock location');
    }
    return { stockLocationId: row.id, inventoryStatus };
  }

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
   * RT-425 (RT-289 G2-3, Q2): give each just-written Retail effect its
   * integration record in state `not_posted`, in the SAME transaction as the
   * effect INSERT. No ERP posting intent represents a manual movement,
   * transfer or count, so the divergence stays explicit (decision 730).
   */
  private async recordNotPosted(
    client: PoolClient,
    tenantId: string,
    effectIds: readonly string[],
  ): Promise<void> {
    await client.query(
      `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state)
       SELECT effect_id, $1, $3 FROM unnest($2::uuid[]) AS effect_id`,
      [tenantId, effectIds, NOT_POSTED],
    );
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
      if (parseQuantity(r.rows[0]?.quantity ?? '0') < 0n) {
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
        ...input.provenance,
      },
      // outbox_events.correlation_id is UUID — only forward a well-formed UUID;
      // a non-UUID upstream tag (or the audit-style text correlation) must NOT
      // fail the movement write. The full value, if any, is on the audit row.
      correlationId: isUuid(input.correlationId) ? input.correlationId : null,
    });
  }
}
