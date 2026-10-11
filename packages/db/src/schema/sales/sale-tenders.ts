/**
 * `sale_tenders` — how a sale was paid (Jira RT-77; RT-10 D1/D2). Policies and
 * CHECKs in `0033_sale_tenders.sql`.
 *
 * A child of the immutable sale fact, written in the capture transaction and
 * never mutated (§X). Amounts are NET of change, in the sale's currency
 * (copied from the sale), and sum to `sales.pos_total` exactly — enforced by
 * the capture service. It is not a payment-allocation ledger (ADR-0005).
 *
 *   - RT-360 (0041): `tender_ref` is the tender line's identity and
 *     `sequence` its apply order (both NULL on legacy rows). A ref-less tender
 *     is one per method (`uq_sale_tenders_sale_method_legacy`); ref-bearing
 *     tenders may share a method and are unique by ref and by sequence;
 *   - D2 methods only;
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
  smallint,
  text,
  timestamp,
  uniqueIndex,
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
    tenderRef: uuid("tender_ref"),
    sequence: smallint("sequence"),
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
    check("sale_tenders_sequence_positive", sql`${t.sequence} IS NULL OR ${t.sequence} >= 1`),
    uniqueIndex("uq_sale_tenders_sale_method_legacy")
      .on(t.saleId, t.method)
      .where(sql`${t.tenderRef} IS NULL`),
    uniqueIndex("uq_sale_tenders_sale_tender_ref")
      .on(t.saleId, t.tenderRef)
      .where(sql`${t.tenderRef} IS NOT NULL`),
    uniqueIndex("uq_sale_tenders_sale_sequence")
      .on(t.saleId, t.sequence)
      .where(sql`${t.sequence} IS NOT NULL`),
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
