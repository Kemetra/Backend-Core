/**
 * `sale_lines` — per-line snapshot of a captured sale. (data-model.md §2)
 *
 * One row per sold line; child of `sales`. Snapshot frozen at capture
 * (FR-002/003): `line_name` / `unit_price` / `tax_amount` / `unit` are the
 * values as charged and MUST NOT change when the referenced tenant product /
 * override / price history later changes. `tenant_product_ref` is lineage
 * only (nullable — ad-hoc lines have none, FR-004; no tenant product is
 * auto-created from a line).
 *
 * Key invariants:
 *   - Money: `unit_price` / `line_amount` are `numeric(19,4)` NOT NULL;
 *     `tax_amount` is `numeric(19,4)` nullable (single per-line snapshot tax,
 *     gate A.2 — the SaaS does not recompute tax). All non-negative.
 *   - `quantity` is `numeric(19,6)` (sub-unit quantities allowed), non-negative.
 *   - `currency_code` `char(3)` matches the parent sale currency.
 *   - Lines inherit the parent's `occurred_at` / `business_date` (gate B —
 *     no own time columns).
 *   - RLS-enabled + FORCE, fail-closed by `tenant_id`. Policy in `0012_sales.sql`.
 */
import { sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { sales } from "./sales";

export const saleLines = pgTable(
  "sale_lines",
  {
    id: uuid("id").primaryKey().notNull(),
    // FK is composite (sale_id, tenant_id, store_id) — declared in the table
    // extra-config below so a line can only attach to a same-tenant/store sale.
    saleId: uuid("sale_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    // Frozen snapshot fields (FR-003).
    lineName: text("line_name").notNull(),
    unitPrice: numeric("unit_price", { precision: 19, scale: 4 }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull(),
    lineAmount: numeric("line_amount", { precision: 19, scale: 4 }).notNull(),
    // Single per-line snapshot tax (gate A.2); nullable when not reported.
    taxAmount: numeric("tax_amount", { precision: 19, scale: 4 }),
    unit: text("unit").notNull(),
    // Optional lineage only (FR-003); NULL for ad-hoc lines (FR-004).
    tenantProductRef: uuid("tenant_product_ref"),
    // RT-538 (0047): the line's original receipt position (1-based); NULL for
    // lines captured before RT-539 stores it.
    lineSeq: integer("line_seq"),
  },
  (t) => [
    check(
      "sale_lines_currency_code_format",
      sql`${t.currencyCode} ~ '^[A-Z]{3}$'`,
    ),
    check("sale_lines_unit_price_non_negative", sql`${t.unitPrice} >= 0`),
    check("sale_lines_line_amount_non_negative", sql`${t.lineAmount} >= 0`),
    check("sale_lines_quantity_non_negative", sql`${t.quantity} >= 0`),
    check(
      "sale_lines_tax_amount_non_negative",
      sql`${t.taxAmount} IS NULL OR ${t.taxAmount} >= 0`,
    ),
    check("sale_lines_line_seq_positive", sql`${t.lineSeq} IS NULL OR ${t.lineSeq} >= 1`),
    index("idx_sale_lines_sale").on(t.saleId),
    index("idx_sale_lines_tenant_store").on(t.tenantId, t.storeId),
    // Composite FK → sales(id, tenant_id, store_id): a line can only attach to
    // a sale in the SAME tenant + store (cross-tenant linkage impossible).
    foreignKey({
      name: "fk_sale_lines_sale_tenant_store",
      columns: [t.saleId, t.tenantId, t.storeId],
      foreignColumns: [sales.id, sales.tenantId, sales.storeId],
    }).onDelete("restrict"),
  ],
);

export type SaleLineRow = typeof saleLines.$inferSelect;
export type NewSaleLineRow = typeof saleLines.$inferInsert;
