/**
 * `sale_tenders` — how a sale was paid (Jira RT-77; RT-10 D1/D2). Policies and
 * CHECKs in `0033_sale_tenders.sql`.
 *
 * A child of the immutable sale fact, written in the capture transaction and
 * never mutated (§X). Amounts are NET of change, in the sale's currency
 * (copied from the sale), and sum to `sales.pos_total` exactly — enforced by
 * the capture service. It is not a payment-allocation ledger (ADR-0005).
 *
 *   - one entry per method (`uq_sale_tenders_sale_method`); D2 methods only;
 *   - `reference` is card_external only, in the contract shape;
 *   - composite FK to `sales (id, tenant_id, store_id)`.
 */
import { sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { sales } from "./sales";

export const saleTenders = pgTable(
  "sale_tenders",
  {
    id: uuid("id").primaryKey().notNull(),
    saleId: uuid("sale_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    method: text("method").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    reference: text("reference"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("sale_tenders_method_valid", sql`${t.method} IN ('cash', 'card_external')`),
    check("sale_tenders_amount_non_negative", sql`${t.amount} >= 0`),
    check("sale_tenders_currency_code_format", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check(
      "sale_tenders_reference_card_only",
      sql`${t.reference} IS NULL OR (${t.method} = 'card_external' AND ${t.reference} ~ '^[A-Z0-9]{1,6}$')`,
    ),
    unique("uq_sale_tenders_sale_method").on(t.saleId, t.method),
    index("idx_sale_tenders_tenant_store").on(t.tenantId, t.storeId),
    foreignKey({
      name: "fk_sale_tenders_sale_tenant_store",
      columns: [t.saleId, t.tenantId, t.storeId],
      foreignColumns: [sales.id, sales.tenantId, sales.storeId],
    }).onDelete("restrict"),
  ],
);

export type SaleTenderRow = typeof saleTenders.$inferSelect;
export type NewSaleTenderRow = typeof saleTenders.$inferInsert;
