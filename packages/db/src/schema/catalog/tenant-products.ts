/**
 * `tenant_products` — Tenant Catalog. (data-model.md §3)
 *
 * Authoritative record for a tenant's owned products. Every tenant-facing
 * product lives here.
 *
 * Key invariants:
 *   - Q1: `default_price` is `numeric(19,4)`; never floating point.
 *   - Q2: `default_currency_code` is `char(3)`. NULL only when
 *         `default_price` is NULL (paired by CHECK).
 *   - Q5: `source_global_product_id` is `uuid NULL` provenance reference.
 *         NO FK to `global_products` — copy-on-adopt snapshot prevents
 *         platform-side lifecycle from cascading into tenant data.
 *   - Q6: No variant columns (`parent_product_id`, `variant_group_id`,
 *         `variant_attributes`). Variants deferred from v1.
 *   - Q7: `category_id` references the FLAT `tenant_product_categories`
 *         table; `ON DELETE SET NULL` so retiring a category does not
 *         retire its products.
 *   - Q11: `tax_category` is `text NOT NULL` opaque label.
 *   - 0045 (RT-448, RT-50 Gate 7 G7-1): the Tracking Profile. Catalog declares
 *         `tracking_mode` none | batch | serial (default none) and
 *         `expiry_required` (batch only) (852, 384, 386). After the product has
 *         an inventory effect or a captured sale line, a profile change is
 *         refused (387): the API's guarded setter answers 409 and the
 *         `tenant_products_guard_tracking_profile` trigger (SQL-only in 0045)
 *         is the backstop for every other writer.
 *
 * RLS-enabled by `tenant_id`. Policy lives in `0001_catalog.sql`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
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
import { tenantProductCategories } from "./tenant-product-categories";

/** Catalog Tracking Profile modes (RT-50 Gate 7 G7-1; decision 384). */
export const TRACKING_MODES = ["none", "batch", "serial"] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

export const tenantProducts = pgTable(
  "tenant_products",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    categoryId: uuid("category_id").references(
      () => tenantProductCategories.id,
      { onDelete: "set null" },
    ),
    defaultPrice: numeric("default_price", { precision: 19, scale: 4 }),
    defaultCurrencyCode: char("default_currency_code", { length: 3 }),
    isActive: boolean("is_active").notNull().default(true),
    taxCategory: text("tax_category").notNull(),
    // Q5: no FK constraint. Soft provenance reference only.
    sourceGlobalProductId: uuid("source_global_product_id"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    correlationId: uuid("correlation_id"),
    // ---- 0045 (RT-448): Tracking Profile (G7-1) ------------------------------
    trackingMode: text("tracking_mode").notNull().default("none"),
    expiryRequired: boolean("expiry_required").notNull().default(false),
  },
  (t) => [
    check(
      "tenant_products_name_length",
      sql`length(${t.name}) BETWEEN 1 AND 500`,
    ),
    check(
      "tenant_products_currency_paired",
      sql`(${t.defaultPrice} IS NULL AND ${t.defaultCurrencyCode} IS NULL) OR (${t.defaultPrice} IS NOT NULL AND ${t.defaultCurrencyCode} IS NOT NULL)`,
    ),
    check(
      "tenant_products_tax_category_length",
      sql`length(${t.taxCategory}) BETWEEN 1 AND 50`,
    ),
    // ---- 0045 (RT-448) ---------------------------------------------------------
    // Values mirror TRACKING_MODES (asserted by the tracking schema-shape test).
    check(
      "tenant_products_tracking_mode_allowed",
      sql`${t.trackingMode} IN ('none', 'batch', 'serial')`,
    ),
    check(
      "tenant_products_expiry_requires_batch",
      sql`NOT ${t.expiryRequired} OR ${t.trackingMode} = 'batch'`,
    ),
    // Composite target for the same-tenant FK from tracking_identities.
    uniqueIndex("uq_tenant_products_id_tenant").on(t.id, t.tenantId),
    index("idx_tenant_products_tenant_active")
      .on(t.tenantId, t.id)
      .where(sql`${t.retiredAt} IS NULL`),
    index("idx_tenant_products_tenant_category")
      .on(t.tenantId, t.categoryId)
      .where(sql`${t.retiredAt} IS NULL`),
    index("idx_tenant_products_source_global")
      .on(t.sourceGlobalProductId)
      .where(sql`${t.sourceGlobalProductId} IS NOT NULL`),
  ],
);

export type TenantProductRow = typeof tenantProducts.$inferSelect;
export type NewTenantProductRow = typeof tenantProducts.$inferInsert;
