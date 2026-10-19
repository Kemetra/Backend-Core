/**
 * Inventory position events and tenant inventory settings — Drizzle schema
 * (0056, Jira RT-435).
 *
 * `inventory_position_events` is the event record of a status move (G4-2,
 * 842–844) or a relocation (800) — both typed `adjustment` Business Events
 * (G2-1, 838; RT-435 D3), as `stock_counts` is a count's. Each event owns
 * exactly two effects (`stock_movements` rows): `-quantity` at the from
 * position and `+quantity` at the to position, with `event_type='adjustment'`,
 * `event_ref_id` = the event id and the DC-1 provenance key
 * `<kind>:<eventId>:from|to`. Under the V1 mapping profile both effects are
 * `erp_neutral` at creation (M-5, Q10).
 *
 * `tracking_identity_id` is the identity both effects carry (RT-50 comment
 * 11775). It is NULL until tracked selling (RT-451) writes one.
 *
 * `tenant_inventory_settings` holds the per-tenant return landing status
 * (Q6, 849): `sellable` (the default; no row reads as it) or
 * `return_inspection`.
 *
 * RLS: ENABLE + FORCE on both. Events: SELECT + INSERT, NO UPDATE / DELETE
 * (append-only). Settings: SELECT + INSERT + UPDATE, NO DELETE. The composite
 * FKs (locations to the event's store and tenant; product and tracking
 * identity to the tenant) and the policies are defined in 0056's SQL.
 * §XIV: BUSINESS-CLASS — opaque ids, codes, an exact quantity, a bounded note,
 * a SHA-256 fingerprint, timestamps. No PII, no money.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

export const INVENTORY_POSITION_EVENT_KINDS = ["status_move", "relocation"] as const;
export type InventoryPositionEventKind = (typeof INVENTORY_POSITION_EVENT_KINDS)[number];

/**
 * The governed Reason Codes of a status move (839; RT-435 D1). Which
 * (from_status -> to_status) pairs each one allows is an API rule.
 * `quality_hold` and `recall` are reserved for the tracking-hold workflow
 * (RT-449).
 */
export const INVENTORY_REASON_CODES = [
  "damage",
  "expiry",
  "quality_hold",
  "recall",
  "inspection_restock",
  "inspection_damage",
  "hold_release",
  "correction",
] as const;
export type InventoryReasonCode = (typeof INVENTORY_REASON_CODES)[number];

/** Where a return line's effect lands (Q6, 849). */
export const RETURN_LANDING_STATUSES = ["sellable", "return_inspection"] as const;
export type ReturnLandingStatus = (typeof RETURN_LANDING_STATUSES)[number];

export const inventoryPositionEvents = pgTable(
  "inventory_position_events",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id").notNull(),
    kind: text("kind").notNull(),
    tenantProductRef: uuid("tenant_product_ref").notNull(),
    quantity: numeric("quantity", { precision: 19, scale: 4 }).notNull(),
    stockingUnit: text("stocking_unit").notNull(),
    fromLocationId: uuid("from_location_id").notNull(),
    toLocationId: uuid("to_location_id").notNull(),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    reasonCode: text("reason_code"),
    note: text("note"),
    trackingIdentityId: uuid("tracking_identity_id"),
    commandFingerprint: text("command_fingerprint").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("inventory_position_events_kind_allowed", sql`${t.kind} IN ('status_move', 'relocation')`),
    check("inventory_position_events_quantity_positive", sql`${t.quantity} > 0`),
    check(
      "inventory_position_events_unit_length",
      sql`char_length(${t.stockingUnit}) BETWEEN 1 AND 32`,
    ),
    check(
      "inventory_position_events_status_allowed",
      sql`${t.fromStatus} IN ('sellable', 'return_inspection', 'quality_hold', 'damaged', 'expired', 'recall_hold') AND ${t.toStatus} IN ('sellable', 'return_inspection', 'quality_hold', 'damaged', 'expired', 'recall_hold')`,
    ),
    check(
      "inventory_position_events_status_move_shape",
      sql`${t.kind} <> 'status_move' OR (${t.fromLocationId} = ${t.toLocationId} AND ${t.fromStatus} <> ${t.toStatus} AND ${t.reasonCode} IS NOT NULL)`,
    ),
    check(
      "inventory_position_events_relocation_shape",
      sql`${t.kind} <> 'relocation' OR (${t.fromLocationId} <> ${t.toLocationId} AND ${t.fromStatus} = ${t.toStatus})`,
    ),
    check(
      "inventory_position_events_reason_code_allowed",
      sql`${t.reasonCode} IS NULL OR ${t.reasonCode} IN ('damage', 'expiry', 'quality_hold', 'recall', 'inspection_restock', 'inspection_damage', 'hold_release', 'correction')`,
    ),
    check(
      "inventory_position_events_correction_note",
      sql`${t.reasonCode} IS DISTINCT FROM 'correction' OR ${t.note} IS NOT NULL`,
    ),
    check(
      "inventory_position_events_note_length",
      sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND 500`,
    ),
    check(
      "inventory_position_events_fingerprint_shape",
      sql`${t.commandFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    uniqueIndex("uq_inventory_position_events_tenant_fingerprint").on(
      t.tenantId,
      t.commandFingerprint,
    ),
    index("idx_inventory_position_events_tenant_store_created").on(
      t.tenantId,
      t.storeId,
      t.createdAt,
    ),
  ],
);

export type InventoryPositionEventRow = typeof inventoryPositionEvents.$inferSelect;
export type NewInventoryPositionEventRow = typeof inventoryPositionEvents.$inferInsert;

export const tenantInventorySettings = pgTable(
  "tenant_inventory_settings",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    returnLandingStatus: text("return_landing_status").notNull().default("sellable"),
    updatedBy: uuid("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "tenant_inventory_settings_return_landing_allowed",
      sql`${t.returnLandingStatus} IN ('sellable', 'return_inspection')`,
    ),
  ],
);

export type TenantInventorySettingsRow = typeof tenantInventorySettings.$inferSelect;
