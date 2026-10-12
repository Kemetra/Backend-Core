/**
 * Inventory & Stock Movement Ledger (009) — Drizzle schema. (data-model.md §1, §4)
 *
 * Two tables:
 *   1. stock_counts     — a recorded physical count (provenance for a variance
 *                         correction movement). data-model.md Entity 4.
 *   2. stock_movements  — the append-only stock ledger; on-hand is the derived
 *                         (compute-on-read) signed SUM of a key's movements.
 *                         data-model.md Entity 1.
 *
 * Key invariants:
 *   - Append-only fact: NO `version` column (R7 / FR-001 — nothing is
 *     overwritten; allow-and-flag dissolves the read-compute-write race, so
 *     there is no optimistic-concurrency column). Movements are TRULY
 *     immutable — the RLS layer grants SELECT + INSERT only (no UPDATE/DELETE
 *     policy), so even a role with UPDATE/DELETE grants is denied under FORCE.
 *   - Quantity: `numeric(p,s)` exact-decimal (no float), SIGNED (outbound
 *     negative, inbound positive), in the product's single stocking unit
 *     (FR-022). The on-hand SUM may go negative (allow-and-flag, FR-024).
 *   - movement_type: a `text` column constrained by CHECK (the repo has no
 *     pgEnum precedent and enum migrations are costly) — one of
 *     inbound | outbound | adjustment | transfer_out | transfer_in |
 *     count_correction (FR-002). Write-off is a reason-coded `outbound`.
 *   - Dedup (R4 / FR-030/031): ONE movement-level unique index only — the
 *     backfill provenance partial-unique `(tenant_id, source_system,
 *     external_id)` WHERE both NOT NULL. Manual-movement dedup lives in the
 *     001/005 `Idempotency-Key` interceptor (`idempotency_keys` table), NOT a
 *     movement index — `idempotency_key` here is a LINEAGE-ONLY nullable column.
 *   - Product identity: `tenant_product_ref` -> tenant_products is NULLABLE
 *     (ad-hoc / unresolved references are provenance only; never auto-created,
 *     FR-023 / R5). A null-product movement rolls up to no product's on-hand.
 *   - Provenance only (never required, never mutates the source): `sale_id` /
 *     `sale_line_id` / `terminal_event_ref` reference the CAPTURED 008 sale
 *     fact (FR-032/025); the ledger does not depend on the gated 008 live loop.
 *   - Pharmacy seam (FR-040/041): NO batch/expiry/serial column on the base
 *     movement — a future nullable `stock_lot_id` / `stock_serial_id` FK is the
 *     only addition needed later, leaving generic-retail movements valid (no
 *     rewrite). Deliberately absent in v1.
 *   - RLS: ENABLE + FORCE, fail-closed by `tenant_id` via the empty-GUC CASE
 *     guard. Policies live in `0014_inventory.sql`.
 *   - §XIV: BUSINESS-CLASS — catalog refs, quantities, provenance ids, bounded
 *     reason text only. NO PII, NO money/payment/tender column.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { tenantProducts } from "../catalog/tenant-products";
import { stores } from "../stores";
import { tenants } from "../tenants";

/** Effect origin (RT-289 G2-2; decision 768). */
export const INVENTORY_EFFECT_ORIGINS = ["retail", "erp_external"] as const;
export type InventoryEffectOrigin = (typeof INVENTORY_EFFECT_ORIGINS)[number];

/** Retail-origin Inventory Business Event types (RT-289 G2-1; 905–909). */
export const RETAIL_INVENTORY_EVENT_TYPES = [
  "sale",
  "sale_void",
  "sale_return",
  "transfer",
  "count",
  "adjustment",
] as const;

/** ERP-origin Inventory Business Event types (RT-289 G2-1; 894–897, 910–913). */
export const ERP_INVENTORY_EVENT_TYPES = [
  "erp_procurement_receipt",
  "erp_manufacturing",
  "erp_opening_stock",
  "erp_correction",
] as const;

export const INVENTORY_EVENT_TYPES = [
  ...RETAIL_INVENTORY_EVENT_TYPES,
  ...ERP_INVENTORY_EVENT_TYPES,
] as const;
export type InventoryEventType = (typeof INVENTORY_EVENT_TYPES)[number];

/**
 * Inventory Status — the closed enum of RT-290 G4-2 (751). Only `sellable`
 * counts toward Sellable On Hand / ATS (733, 742); all six are physical.
 */
export const INVENTORY_STATUSES = [
  "sellable",
  "return_inspection",
  "quality_hold",
  "damaged",
  "expired",
  "recall_hold",
] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

/**
 * `stock_counts` — a recorded physical count for a (tenant, store, product).
 * Provenance for the `count_correction` movement created from its variance
 * (FR-021). The count itself does not mutate on-hand — only its correction
 * movement does. Created BEFORE stock_movements (which FKs stock_count_id).
 */
export const stockCounts = pgTable(
  "stock_counts",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    // Nullable per R5 (ad-hoc product); the counted product.
    tenantProductRef: uuid("tenant_product_ref").references(
      () => tenantProducts.id,
      { onDelete: "restrict" },
    ),
    countedQuantity: numeric("counted_quantity", {
      precision: 19,
      scale: 4,
    }).notNull(),
    // The compute-on-read on-hand captured at count time (provenance for the variance).
    derivedOnHandAtCount: numeric("derived_on_hand_at_count", {
      precision: 19,
      scale: 4,
    }).notNull(),
    stockingUnit: text("stocking_unit").notNull(),
    countedAt: timestamp("counted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Backs the composite FK from stock_movements.stock_count_id so a
    // correction movement can never attach to a count in another tenant/store.
    unique("uq_stock_counts_id_tenant_store").on(t.id, t.tenantId, t.storeId),
    index("idx_stock_counts_tenant_store_product").on(
      t.tenantId,
      t.storeId,
      t.tenantProductRef,
    ),
  ],
);

export type StockCountRow = typeof stockCounts.$inferSelect;
export type NewStockCountRow = typeof stockCounts.$inferInsert;

/**
 * `stock_movements` — the append-only stock ledger (data-model.md Entity 1).
 * On-hand for a (tenant, store, product) is the compute-on-read signed SUM of
 * its movements (FR-003); there is no materialized balance in v1.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    movementType: text("movement_type").notNull(),
    // SIGNED exact-decimal quantity in the stocking unit (FR-022); may be
    // negative; the on-hand SUM may go negative (allow-and-flag, FR-024).
    quantity: numeric("quantity", { precision: 19, scale: 4 }).notNull(),
    stockingUnit: text("stocking_unit").notNull(),
    // Nullable per R5 (ad-hoc / unresolved product); never auto-created (FR-023).
    tenantProductRef: uuid("tenant_product_ref").references(
      () => tenantProducts.id,
      { onDelete: "restrict" },
    ),
    reason: text("reason"),
    // Gate: business-event + receipt are NOT NULL (§X). received_at is the
    // security clock; occurred_at may be backfilled / out-of-order.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // LINEAGE ONLY — the Idempotency-Key value echoed onto the row. Manual
    // dedup lives in the 001/005 interceptor, NOT a movement index (R4/FR-030).
    idempotencyKey: text("idempotency_key"),
    // Backfill / external-origin provenance + dedup pair (R4/FR-031).
    sourceSystem: text("source_system"),
    externalId: text("external_id"),
    // Provenance only — references the CAPTURED 008 sale fact (FR-032/025).
    saleId: uuid("sale_id"),
    saleLineId: uuid("sale_line_id"),
    terminalEventRef: uuid("terminal_event_ref"),
    // Links transfer_out <-> transfer_in as one logical transfer (FR-020).
    transferGroupId: uuid("transfer_group_id"),
    // Set on a count_correction movement (FR-021); composite-FK into stock_counts.
    stockCountId: uuid("stock_count_id"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // ---- 0042 (RT-425): Inventory Effect columns (RT-289 G2-2) -------------
    // Explicit effect origin (768). Every writer on main is a Retail path.
    origin: text("origin").notNull().default("retail"),
    // The owning Inventory Business Event (761/762, G2-1); both or neither.
    // NULL on pre-0042 rows (history is not rewritten, 727/970).
    eventType: text("event_type"),
    eventRefId: uuid("event_ref_id"),
    // Set only on a correction effect (775); a same-tenant self-reference.
    compensatesEffectId: uuid("compensates_effect_id"),
    // Position (750). 0044 (RT-432, RT-290 G4-1…G4-5): every new row carries a
    // stock location of its own store and an inventory status; tracking stays
    // NULL until Gate 7 (RT-50). Pre-0044 rows keep NULL and are read as (the
    // store's primary location, sellable, no tracking) — never updated.
    stockLocationId: uuid("stock_location_id"),
    inventoryStatus: text("inventory_status"),
    trackingIdentity: text("tracking_identity"),
  },
  (t) => [
    check(
      "stock_movements_type_allowed",
      sql`${t.movementType} IN ('inbound','outbound','adjustment','transfer_out','transfer_in','count_correction')`,
    ),
    // A movement either carries BOTH provenance keys or NEITHER (a half-pair
    // can't dedup); enforces the backfill dedup contract's integrity.
    check(
      "stock_movements_provenance_pair",
      sql`(${t.sourceSystem} IS NULL) = (${t.externalId} IS NULL)`,
    ),
    // `reason` is a bounded short operator note (§III DB-enforced bound; §XIV
    // PII-safety). 500 chars — generous for a note, no repo char_length precedent.
    check(
      "stock_movements_reason_length",
      sql`${t.reason} IS NULL OR char_length(${t.reason}) <= 500`,
    ),
    // count_correction IFF stock_count_id set (FR-021): only a count_correction
    // links a stock_count, and every count_correction must (§III invariant).
    check(
      "stock_movements_count_correction_link",
      sql`(${t.movementType} = 'count_correction') = (${t.stockCountId} IS NOT NULL)`,
    ),
    // ONE movement-level dedup index (FR-031): backfill / external-origin
    // provenance. Partial — manual movements (NULL provenance) are NOT deduped
    // here (the interceptor handles them). No manual idempotency_key index.
    uniqueIndex("uq_stock_movements_tenant_source_external")
      .on(t.tenantId, t.sourceSystem, t.externalId)
      .where(sql`${t.sourceSystem} IS NOT NULL AND ${t.externalId} IS NOT NULL`),
    // On-hand is the SUM over (tenant, store, product); this index backs it.
    index("idx_stock_movements_tenant_store_product").on(
      t.tenantId,
      t.storeId,
      t.tenantProductRef,
    ),
    index("idx_stock_movements_transfer_group")
      .on(t.transferGroupId)
      .where(sql`${t.transferGroupId} IS NOT NULL`),
    // ---- 0042 (RT-425) -------------------------------------------------------
    check("stock_movements_origin_allowed", sql`${t.origin} IN ('retail', 'erp_external')`),
    // Values mirror INVENTORY_EVENT_TYPES (asserted by the schema-shape test).
    check(
      "stock_movements_event_type_allowed",
      sql`${t.eventType} IS NULL OR ${t.eventType} IN ('sale', 'sale_void', 'sale_return', 'transfer', 'count', 'adjustment', 'erp_procurement_receipt', 'erp_manufacturing', 'erp_opening_stock', 'erp_correction')`,
    ),
    check(
      "stock_movements_event_pair",
      sql`(${t.eventType} IS NULL) = (${t.eventRefId} IS NULL)`,
    ),
    // An event type belongs to exactly one origin (768, 905–913).
    check(
      "stock_movements_event_origin_consistent",
      sql`${t.eventType} IS NULL OR (${t.origin} = 'retail') = (${t.eventType} IN ('sale', 'sale_void', 'sale_return', 'transfer', 'count', 'adjustment'))`,
    ),
    check(
      "stock_movements_compensates_not_self",
      sql`${t.compensatesEffectId} IS NULL OR ${t.compensatesEffectId} <> ${t.id}`,
    ),
    // ---- 0044 (RT-432) -- all NOT VALID in SQL: enforced on new rows only ----
    check(
      "stock_movements_position_required",
      sql`${t.stockLocationId} IS NOT NULL AND ${t.inventoryStatus} IS NOT NULL`,
    ),
    // Values mirror INVENTORY_STATUSES (asserted by the schema-shape test).
    check(
      "stock_movements_inventory_status_allowed",
      sql`${t.inventoryStatus} IN ('sellable', 'return_inspection', 'quality_hold', 'damaged', 'expired', 'recall_hold')`,
    ),
    check("stock_movements_tracking_none", sql`${t.trackingIdentity} IS NULL`),
    // fk_stock_movements_location_store_tenant (stock_location_id, store_id,
    // tenant_id) -> stock_locations (id, store_id, tenant_id) is SQL-only.
    // Composite target for the same-tenant FKs (compensation; integration row).
    // The self-FK fk_stock_movements_compensates_tenant is SQL-only in 0042.
    uniqueIndex("uq_stock_movements_id_tenant").on(t.id, t.tenantId),
    index("idx_stock_movements_tenant_event")
      .on(t.tenantId, t.eventType, t.eventRefId)
      .where(sql`${t.eventType} IS NOT NULL`),
    // NOTE (issue #465, migration 0016): the established-unit guard
    // `stock_movements_one_unit_per_product` — an EXCLUDE USING gist constraint
    // enforcing at most one DISTINCT stocking_unit per (store_id,
    // tenant_product_ref) — is defined SQL-ONLY in
    // packages/db/drizzle/0016_inventory_unit_guard.sql. Drizzle's pg-core has
    // no exclusion-constraint builder, and the explicit SQL migration is the
    // DDL source of truth (this schema object is for query-builder typing). It
    // is the path-independent backstop for FR-022 under concurrency.
  ],
);

export type StockMovementRow = typeof stockMovements.$inferSelect;
export type NewStockMovementRow = typeof stockMovements.$inferInsert;
