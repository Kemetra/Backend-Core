/**
 * Stock Locations — Drizzle schema (0044, Jira RT-432).
 *
 * A Stock Location is a tenant-scoped place inside exactly one Store (RT-290
 * G4-1; decisions 746, 747). Every store has exactly one `primary` location:
 * 0044 creates it for every existing store, and the `stores_create_primary_location`
 * trigger creates it for every new store in the same transaction. The primary
 * designation is immutable; further `storage` locations are allowed by the
 * model but not yet exposed for writing.
 *
 * Identity (tenant, store, kind, code) never changes — the
 * `stock_locations_guard_identity` trigger rejects it for every role. The
 * primary is always active (`stock_locations_primary_active`).
 *
 * RLS: ENABLE + FORCE; SELECT + INSERT tenant policies, NO UPDATE / DELETE
 * policy (0044). The FK to `stores (tenant_id, id)` cascades so a store purge
 * removes its unused locations; a location an effect references blocks the
 * purge through `stock_movements`' own RESTRICT FK on store_id. The triggers,
 * the composite unique target and the policies are defined in 0044's SQL.
 * §XIV: BUSINESS-CLASS — opaque ids, a short code and name, a kind, a flag.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

export const STOCK_LOCATION_KINDS = ["primary", "storage"] as const;
export type StockLocationKind = (typeof STOCK_LOCATION_KINDS)[number];

/** The code and name 0044 gives every store's primary location. */
export const PRIMARY_LOCATION_CODE = "PRIMARY";

export const stockLocations = pgTable(
  "stock_locations",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Composite FK (tenant_id, store_id) -> stores (tenant_id, id) ON DELETE
    // CASCADE is SQL-only in 0044.
    storeId: uuid("store_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("stock_locations_kind_allowed", sql`${t.kind} IN ('primary', 'storage')`),
    check("stock_locations_primary_active", sql`${t.kind} <> 'primary' OR ${t.isActive}`),
    check("stock_locations_code_length", sql`char_length(${t.code}) BETWEEN 1 AND 64`),
    check("stock_locations_name_length", sql`char_length(${t.name}) BETWEEN 1 AND 200`),
    uniqueIndex("uq_stock_locations_store_primary")
      .on(t.storeId)
      .where(sql`${t.kind} = 'primary'`),
    // Composite target for the same-store, same-tenant FK from stock_movements.
    uniqueIndex("uq_stock_locations_id_store_tenant").on(t.id, t.storeId, t.tenantId),
    // uq_stock_locations_store_code is on (store_id, lower(code)) — SQL-only.
  ],
);

export type StockLocationRow = typeof stockLocations.$inferSelect;
export type NewStockLocationRow = typeof stockLocations.$inferInsert;
