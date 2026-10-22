/**
 * Inventory Anchors — Drizzle schema (0063, Jira RT-427).
 *
 * An Inventory Anchor is the metadata baseline taken from ERP-confirmed Bin
 * state when sale effects are activated for a tenant (RT-289 DC-8, Q3;
 * decisions 778–781, 786). It is NEVER an inventory movement (779): the
 * effects recorded from `activated_at` on count on top of it, and the
 * `coverage` object records what it absorbed (the pre-activation manual
 * movements, Bin items with no Retail product).
 *
 *   - `inventory_anchors`: one row per (tenant, store, generation), at the
 *     store's inbound position (primary / sellable in V1, M-8), with the stock
 *     reconciliation run whose Bin snapshot it was taken from (780).
 *   - `inventory_anchor_lines`: one row per (anchor, product): the Bin quantity
 *     exactly as ERPNext reported it, its stock UOM and Item reference.
 *
 * RLS: ENABLE + FORCE on both; SELECT + INSERT only (an anchor is immutable;
 * a re-baseline adds a generation, 786). The composite FKs (location to the
 * anchor's store and tenant; lines to the anchor and product of the tenant)
 * and the policies are defined in 0063's SQL.
 * §XIV: BUSINESS-CLASS — opaque ids and ERP references, exact quantities and
 * units, timestamps, a coverage object of counts. No PII, no money.
 */
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

export const inventoryAnchors = pgTable(
  "inventory_anchors",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id").notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    inventoryStatus: text("inventory_status").notNull().default("sellable"),
    generation: integer("generation").notNull(),
    // FK to erpnext_reconciliation_run(id) is SQL-only in 0063.
    sourceRunId: uuid("source_run_id").notNull(),
    snapshotReadAt: timestamp("snapshot_read_at", { withTimezone: true }).notNull(),
    snapshotRecordedAt: timestamp("snapshot_recorded_at", { withTimezone: true }).notNull(),
    erpnextWarehouseRef: text("erpnext_warehouse_ref").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
    coverage: jsonb("coverage").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "inventory_anchors_status_allowed",
      sql`${t.inventoryStatus} IN ('sellable', 'return_inspection', 'quality_hold', 'damaged', 'expired', 'recall_hold')`,
    ),
    check("inventory_anchors_generation_positive", sql`${t.generation} >= 1`),
    check(
      "inventory_anchors_warehouse_ref_length",
      sql`char_length(${t.erpnextWarehouseRef}) BETWEEN 1 AND 140`,
    ),
    check("inventory_anchors_coverage_object", sql`jsonb_typeof(${t.coverage}) = 'object'`),
    uniqueIndex("uq_inventory_anchors_store_generation").on(t.tenantId, t.storeId, t.generation),
    uniqueIndex("uq_inventory_anchors_id_tenant").on(t.id, t.tenantId),
  ],
);

export type InventoryAnchorRow = typeof inventoryAnchors.$inferSelect;
export type NewInventoryAnchorRow = typeof inventoryAnchors.$inferInsert;

export const inventoryAnchorLines = pgTable(
  "inventory_anchor_lines",
  {
    id: uuid("id").primaryKey().notNull(),
    anchorId: uuid("anchor_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    tenantProductRef: uuid("tenant_product_ref").notNull(),
    // Exact Bin quantity (the stock-view pattern: 15 integer, 6 decimal digits).
    quantity: numeric("quantity", { precision: 21, scale: 6 }).notNull(),
    erpStockUom: text("erp_stock_uom").notNull(),
    erpnextItemRef: text("erpnext_item_ref").notNull(),
  },
  (t) => [
    check("inventory_anchor_lines_uom_length", sql`char_length(${t.erpStockUom}) BETWEEN 1 AND 140`),
    check(
      "inventory_anchor_lines_item_ref_length",
      sql`char_length(${t.erpnextItemRef}) BETWEEN 1 AND 140`,
    ),
    uniqueIndex("uq_inventory_anchor_lines_anchor_product").on(t.anchorId, t.tenantProductRef),
  ],
);

export type InventoryAnchorLineRow = typeof inventoryAnchorLines.$inferSelect;
export type NewInventoryAnchorLineRow = typeof inventoryAnchorLines.$inferInsert;
