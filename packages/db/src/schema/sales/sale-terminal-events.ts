/**
 * `sale_voids` + `sale_refunds` — append-only terminal events. (data-model.md §3/§4)
 *
 * Each is a SEPARATE record referencing a `sales` row. Recording a void or
 * refund NEVER mutates the original sale or its lines (§X) — "voided" /
 * "refunded" are derived from the presence of a terminal event, not a mutable
 * status on the sale.
 *
 * Both tables share the provenance + idempotency shape:
 *   - Dedup-unique on `(tenant_id, source_system, external_id)` (FR-013) —
 *     a re-delivered terminal event is not double-applied.
 *   - `payload_hash` = SHA-256 canonical (gate C).
 *   - RLS-enabled + FORCE, fail-closed by `tenant_id`. Policies in `0012_sales.sql`.
 *
 * `sale_refunds` additionally preserves the POS-reported refund amount
 * verbatim (FR-012/030) as `numeric(19,4)` + ISO currency. NO tender / payment
 * columns on either table (gate A.5 — deferred to 010).
 *
 * NOTE on file placement: the 008-SCHEMA allowed_files named
 * `schema/sales/{sales,sale-lines}.ts`; the two terminal-event tables
 * (data-model.md §3/§4) are co-located here in the same `sales/` schema
 * directory rather than spread across two more single-table files. Flagged at
 * authoring time as a one-file expansion within the same schema surface.
 */
import { sql } from "drizzle-orm";
import {
  char,
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { sales } from "./sales";

export const saleVoids = pgTable(
  "sale_voids",
  {
    id: uuid("id").primaryKey().notNull(),
    // FK is composite (sale_id, tenant_id, store_id) — declared below.
    saleId: uuid("sale_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    // Gate B: terminal stamp (server clock) is NOT NULL.
    voidedAt: timestamp("voided_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // RT-63 P2 (0032): the void's own business day in the store timezone,
    // computed once at insert and never recomputed.
    businessDate: date("business_date").notNull(),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_sale_voids_tenant_source_external").on(
      t.tenantId,
      t.sourceSystem,
      t.externalId,
    ),
    index("idx_sale_voids_sale").on(t.saleId),
    // RT-14 D2 (0032): at most one void per sale.
    uniqueIndex("uq_sale_voids_one_per_sale").on(t.saleId),
    index("idx_sale_voids_tenant_store").on(t.tenantId, t.storeId),
    foreignKey({
      name: "fk_sale_voids_sale_tenant_store",
      columns: [t.saleId, t.tenantId, t.storeId],
      foreignColumns: [sales.id, sales.tenantId, sales.storeId],
    }).onDelete("restrict"),
  ],
);

export const saleRefunds = pgTable(
  "sale_refunds",
  {
    id: uuid("id").primaryKey().notNull(),
    // FK is composite (sale_id, tenant_id, store_id) — declared below.
    saleId: uuid("sale_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    // Gate B: terminal stamp (server clock) is NOT NULL.
    refundedAt: timestamp("refunded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // POS-reported refund amount, preserved verbatim (FR-012/030).
    posRefundAmount: numeric("pos_refund_amount", {
      precision: 19,
      scale: 4,
    }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "sale_refunds_currency_code_format",
      sql`${t.currencyCode} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "sale_refunds_pos_refund_amount_non_negative",
      sql`${t.posRefundAmount} >= 0`,
    ),
    uniqueIndex("uq_sale_refunds_tenant_source_external").on(
      t.tenantId,
      t.sourceSystem,
      t.externalId,
    ),
    index("idx_sale_refunds_sale").on(t.saleId),
    index("idx_sale_refunds_tenant_store").on(t.tenantId, t.storeId),
    foreignKey({
      name: "fk_sale_refunds_sale_tenant_store",
      columns: [t.saleId, t.tenantId, t.storeId],
      foreignColumns: [sales.id, sales.tenantId, sales.storeId],
    }).onDelete("restrict"),
  ],
);

export type SaleVoidRow = typeof saleVoids.$inferSelect;
export type NewSaleVoidRow = typeof saleVoids.$inferInsert;
export type SaleRefundRow = typeof saleRefunds.$inferSelect;
export type NewSaleRefundRow = typeof saleRefunds.$inferInsert;
