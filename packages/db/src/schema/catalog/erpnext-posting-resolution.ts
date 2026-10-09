/**
 * `erpnext_posting_resolution` — the frozen ERP resolution of a posting intent
 * (RT-330, RT-326 phase 1a; migration 0037).
 *
 * One row per (intent, resolution_version, sale line): the ERP item ref and
 * warehouse ref the intent will post with, the ids of the maps they came from,
 * and who resolved them (`system` at creation, `operator` on a repair re-head,
 * `backfill` for intents that existed before 0037). The posting feed reads the
 * version named by `erpnext_posting_status.current_resolution_version`, so a
 * later retire or re-point of an item map never strands or retargets an
 * accepted intent (RT-316 V1).
 *
 * Append-only: SELECT + INSERT RLS policies only. A correction is a new
 * resolution_version, never an edit. Composite FK (intent_id, tenant_id) ->
 * erpnext_posting_status (id, tenant_id) is declared in the 0037 SQL migration.
 * TENANT-only RLS by `tenant_id`.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { saleLines } from "../sales/sale-lines";
import { tenants } from "../tenants";

export const erpnextPostingResolution = pgTable(
  "erpnext_posting_resolution",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // The posting intent (erpnext_posting_status.id). Composite FK in 0037.
    intentId: uuid("intent_id").notNull(),
    resolutionVersion: integer("resolution_version").notNull(),
    saleLineId: uuid("sale_line_id")
      .notNull()
      .references(() => saleLines.id, { onDelete: "restrict" }),
    erpnextItemRef: text("erpnext_item_ref").notNull(),
    // Provenance: the map rows the refs were read from (no FK — maps are
    // append-only history, mirroring the 013/014 ref columns).
    itemMapId: uuid("item_map_id").notNull(),
    warehouseRef: text("warehouse_ref").notNull(),
    warehouseMapId: uuid("warehouse_map_id").notNull(),
    resolvedBy: text("resolved_by").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "pk_erpnext_posting_resolution",
      columns: [t.intentId, t.resolutionVersion, t.saleLineId],
    }),
    check(
      "erpnext_posting_resolution_version_positive",
      sql`${t.resolutionVersion} >= 1`,
    ),
    check(
      "erpnext_posting_resolution_item_ref_nonempty",
      sql`length(${t.erpnextItemRef}) > 0`,
    ),
    check(
      "erpnext_posting_resolution_warehouse_ref_nonempty",
      sql`length(${t.warehouseRef}) > 0`,
    ),
    check(
      "erpnext_posting_resolution_resolved_by_valid",
      sql`${t.resolvedBy} IN ('system', 'operator', 'backfill')`,
    ),
    index("idx_erpnext_posting_resolution_tenant").on(t.tenantId),
  ],
);

export type ErpnextPostingResolution = typeof erpnextPostingResolution.$inferSelect;
export type NewErpnextPostingResolution = typeof erpnextPostingResolution.$inferInsert;
