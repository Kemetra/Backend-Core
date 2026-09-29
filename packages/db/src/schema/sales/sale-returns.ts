/**
 * `sale_returns` + `sale_return_lines` + `sale_return_tenders` — line-aware
 * returns (Jira RT-73; RT-14 D1–D3). Policies and CHECKs in `0032_sale_returns.sql`.
 *
 * A return is a SEPARATE append-only record against a `sales` row; the sale
 * and its lines are never mutated (§X). The server prices every returned line
 * from the frozen sale line by the cumulative-difference rule (RT-73 comment
 * 10406) and records the refund payout as a fact (D3, cash only).
 *
 *   - `sale_returns`: dedup-unique on `(tenant_id, source_system, external_id)`;
 *     `return_seq` orders a sale's returns (assigned under the sales row lock);
 *     `business_date` is the return's own store-timezone day (RT-63 P2).
 *   - `sale_return_lines`: one row per returned sale line;
 *     `returned_quantity_after` freezes the cumulative quantity so a replay
 *     echoes the identical returnability snapshot.
 *   - `sale_return_tenders`: payout method + amount, in request order.
 *
 * Children carry a composite FK to `sale_returns (id, tenant_id, store_id)`.
 */
import { sql } from "drizzle-orm";
import {
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { saleLines } from "./sale-lines";
import { sales } from "./sales";

export const saleReturns = pgTable(
  "sale_returns",
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
    returnSeq: integer("return_seq").notNull(),
    returnedAt: timestamp("returned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    businessDate: date("business_date").notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    returnTotal: numeric("return_total", { precision: 19, scale: 4 }).notNull(),
    reason: text("reason"),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("sale_returns_return_seq_positive", sql`${t.returnSeq} > 0`),
    check("sale_returns_currency_code_format", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("sale_returns_return_total_non_negative", sql`${t.returnTotal} >= 0`),
    check(
      "sale_returns_reason_length",
      sql`${t.reason} IS NULL OR char_length(${t.reason}) BETWEEN 1 AND 500`,
    ),
    uniqueIndex("uq_sale_returns_tenant_source_external").on(
      t.tenantId,
      t.sourceSystem,
      t.externalId,
    ),
    index("idx_sale_returns_tenant_store").on(t.tenantId, t.storeId),
    unique("uq_sale_returns_id_tenant_store").on(t.id, t.tenantId, t.storeId),
    unique("uq_sale_returns_sale_seq").on(t.saleId, t.returnSeq),
    foreignKey({
      name: "fk_sale_returns_sale_tenant_store",
      columns: [t.saleId, t.tenantId, t.storeId],
      foreignColumns: [sales.id, sales.tenantId, sales.storeId],
    }).onDelete("restrict"),
  ],
);

export const saleReturnLines = pgTable(
  "sale_return_lines",
  {
    id: uuid("id").primaryKey().notNull(),
    returnId: uuid("return_id").notNull(),
    saleLineId: uuid("sale_line_id")
      .notNull()
      .references(() => saleLines.id, { onDelete: "restrict" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull(),
    lineAmount: numeric("line_amount", { precision: 19, scale: 4 }).notNull(),
    taxAmount: numeric("tax_amount", { precision: 19, scale: 4 }),
    returnedQuantityAfter: numeric("returned_quantity_after", {
      precision: 19,
      scale: 6,
    }).notNull(),
  },
  (t) => [
    check("sale_return_lines_quantity_positive", sql`${t.quantity} > 0`),
    check("sale_return_lines_line_amount_non_negative", sql`${t.lineAmount} >= 0`),
    check(
      "sale_return_lines_tax_amount_non_negative",
      sql`${t.taxAmount} IS NULL OR ${t.taxAmount} >= 0`,
    ),
    check(
      "sale_return_lines_cumulative_covers_quantity",
      sql`${t.returnedQuantityAfter} >= ${t.quantity}`,
    ),
    unique("uq_sale_return_lines_return_line").on(t.returnId, t.saleLineId),
    index("idx_sale_return_lines_sale_line").on(t.saleLineId),
    index("idx_sale_return_lines_tenant_store").on(t.tenantId, t.storeId),
    foreignKey({
      name: "fk_sale_return_lines_return_tenant_store",
      columns: [t.returnId, t.tenantId, t.storeId],
      foreignColumns: [saleReturns.id, saleReturns.tenantId, saleReturns.storeId],
    }).onDelete("restrict"),
  ],
);

export const saleReturnTenders = pgTable(
  "sale_return_tenders",
  {
    id: uuid("id").primaryKey().notNull(),
    returnId: uuid("return_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    method: text("method").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  },
  (t) => [
    check("sale_return_tenders_ordinal_non_negative", sql`${t.ordinal} >= 0`),
    check("sale_return_tenders_method_valid", sql`${t.method} IN ('cash')`),
    check("sale_return_tenders_amount_non_negative", sql`${t.amount} >= 0`),
    unique("uq_sale_return_tenders_return_ordinal").on(t.returnId, t.ordinal),
    index("idx_sale_return_tenders_tenant_store").on(t.tenantId, t.storeId),
    foreignKey({
      name: "fk_sale_return_tenders_return_tenant_store",
      columns: [t.returnId, t.tenantId, t.storeId],
      foreignColumns: [saleReturns.id, saleReturns.tenantId, saleReturns.storeId],
    }).onDelete("restrict"),
  ],
);

export type SaleReturnRow = typeof saleReturns.$inferSelect;
export type NewSaleReturnRow = typeof saleReturns.$inferInsert;
export type SaleReturnLineRow = typeof saleReturnLines.$inferSelect;
export type NewSaleReturnLineRow = typeof saleReturnLines.$inferInsert;
export type SaleReturnTenderRow = typeof saleReturnTenders.$inferSelect;
export type NewSaleReturnTenderRow = typeof saleReturnTenders.$inferInsert;
