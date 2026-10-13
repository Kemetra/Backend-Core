/**
 * Tracking identities and their ERPNext edge map — Drizzle schema (0045, Jira
 * RT-448; RT-50 Gate 7 G7-2, G7-3).
 *
 * `tracking_identities` — an Inventory-owned batch or serial of one product
 * (decisions 749, 853, 385, 454; RT-290 Q7). `code` is the lot / serial number
 * exactly as printed on the pack, matched exactly (313). `kind`, `code`, the
 * product and the origin are immutable: the
 * `tracking_identities_guard_identity` trigger rejects a change for every role.
 * `expiry_date` changes only through the governed expiry correction (RT-449).
 * Identities are ERP-born only (G7-3): `origin` is always `erp_external`.
 *
 * `erpnext_tracking_map` — the 1:1 edge map from an identity to the opaque
 * ERPNext Batch / Serial No document name (M-4, M-9). ERP vocabulary stays in
 * this table and the frozen posting resolution, never in Inventory contracts.
 *
 * Effects reference an identity through `stock_movements.tracking_identity_id`.
 * Nothing writes either table yet: identity birth is RT-453.
 *
 * RLS: ENABLE + FORCE on both; SELECT + INSERT tenant policies, NO UPDATE /
 * DELETE policy. The composite FKs, the guard trigger and the policies are
 * defined in 0045's SQL. §XIV: BUSINESS-CLASS — opaque ids, a kind, a printed
 * manufacturer code (no PII), dates and an opaque ERPNext name.
 */
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

/** Tracking identity kinds (G7-2; decision 749). `none` is the absence of a row. */
export const TRACKING_IDENTITY_KINDS = ["batch", "serial"] as const;
export type TrackingIdentityKind = (typeof TRACKING_IDENTITY_KINDS)[number];

/** Identity origins (G7-3): ERP-born only. */
export const TRACKING_IDENTITY_ORIGINS = ["erp_external"] as const;
export type TrackingIdentityOrigin = (typeof TRACKING_IDENTITY_ORIGINS)[number];

export const trackingIdentities = pgTable(
  "tracking_identities",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Composite FK (tenant_product_ref, tenant_id) -> tenant_products (id,
    // tenant_id) ON DELETE RESTRICT is SQL-only in 0045.
    tenantProductRef: uuid("tenant_product_ref").notNull(),
    kind: text("kind").notNull(),
    code: text("code").notNull(),
    expiryDate: date("expiry_date"),
    manufacturedOn: date("manufactured_on"),
    origin: text("origin").notNull().default("erp_external"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("tracking_identities_kind_allowed", sql`${t.kind} IN ('batch', 'serial')`),
    check(
      "tracking_identities_code_shape",
      sql`char_length(${t.code}) BETWEEN 1 AND 128 AND ${t.code} = btrim(${t.code})`,
    ),
    check("tracking_identities_origin_allowed", sql`${t.origin} IN ('erp_external')`),
    check(
      "tracking_identities_dates_ordered",
      sql`${t.manufacturedOn} IS NULL OR ${t.expiryDate} IS NULL OR ${t.manufacturedOn} <= ${t.expiryDate}`,
    ),
    uniqueIndex("uq_tracking_identities_product_kind_code").on(
      t.tenantId,
      t.tenantProductRef,
      t.kind,
      t.code,
    ),
    // The identity list's keyset order: expiry NULLS LAST is COALESCE(…, 'infinity').
    index("idx_tracking_identities_product_keyset").on(
      t.tenantProductRef,
      t.kind,
      sql`(COALESCE(${t.expiryDate}, 'infinity'::date))`,
      t.code,
      t.id,
    ),
    // Composite target for stock_movements: the identity of the effect's product.
    uniqueIndex("uq_tracking_identities_id_product_tenant").on(t.id, t.tenantProductRef, t.tenantId),
    // Composite target for the edge map: same tenant, same kind.
    uniqueIndex("uq_tracking_identities_id_tenant_kind").on(t.id, t.tenantId, t.kind),
  ],
);

export type TrackingIdentityRow = typeof trackingIdentities.$inferSelect;
export type NewTrackingIdentityRow = typeof trackingIdentities.$inferInsert;

export const erpnextTrackingMap = pgTable(
  "erpnext_tracking_map",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Composite FK (tracking_identity_id, tenant_id, kind) ->
    // tracking_identities (id, tenant_id, kind) ON DELETE RESTRICT is SQL-only.
    trackingIdentityId: uuid("tracking_identity_id").notNull(),
    kind: text("kind").notNull(),
    erpnextRef: text("erpnext_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("erpnext_tracking_map_kind_allowed", sql`${t.kind} IN ('batch', 'serial')`),
    check("erpnext_tracking_map_ref_length", sql`char_length(${t.erpnextRef}) BETWEEN 1 AND 140`),
    uniqueIndex("uq_erpnext_tracking_map_identity").on(t.trackingIdentityId),
    uniqueIndex("uq_erpnext_tracking_map_tenant_kind_ref").on(t.tenantId, t.kind, t.erpnextRef),
  ],
);

export type ErpnextTrackingMapRow = typeof erpnextTrackingMap.$inferSelect;
export type NewErpnextTrackingMapRow = typeof erpnextTrackingMap.$inferInsert;
