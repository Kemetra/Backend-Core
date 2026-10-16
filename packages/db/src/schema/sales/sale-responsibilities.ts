/**
 * `sale_responsibilities` — who owes how much of a sale (Jira RT-418; owner
 * decision R-1, RT-413 comment 11669; contract RT-417 `SaleResponsibility`).
 * Policies and CHECKs in `0049_sale_responsibilities.sql`.
 *
 * A child of the immutable sale fact, written in the capture transaction and
 * never mutated (§X). NOT a receivable: no balance and no state; ERPNext owns
 * what is later collected. `sum(tenders) + sum(responsibilities) = posTotal`
 * is enforced by the capture service. `sales.responsibility_count` records
 * how many rows capture wrote (the posting feed's visibility guard).
 *
 *   - amount > 0 and sequence >= 1; one row per payer and per sequence;
 *   - composite FK to `sales (id, tenant_id, store_id)`;
 *   - composite FK to `payer_account (id, tenant_id)`: never another tenant's
 *     payer.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  smallint,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { payerAccount } from "../settlement/payer-account";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { sales } from "./sales";

export const saleResponsibilities = pgTable(
  "sale_responsibilities",
  {
    id: uuid("id").primaryKey().notNull().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    saleId: uuid("sale_id").notNull(),
    payerId: uuid("payer_id").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    sequence: smallint("sequence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("sale_responsibilities_amount_positive", sql`${t.amount} > 0`),
    check("sale_responsibilities_sequence_positive", sql`${t.sequence} >= 1`),
    foreignKey({
      name: "fk_sale_responsibilities_sale_tenant_store",
      columns: [t.saleId, t.tenantId, t.storeId],
      foreignColumns: [sales.id, sales.tenantId, sales.storeId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_sale_responsibilities_payer_tenant",
      columns: [t.payerId, t.tenantId],
      foreignColumns: [payerAccount.id, payerAccount.tenantId],
    }).onDelete("restrict"),
    unique("uq_sale_responsibilities_sale_payer").on(t.saleId, t.payerId),
    unique("uq_sale_responsibilities_sale_sequence").on(t.saleId, t.sequence),
    index("idx_sale_responsibilities_tenant_store").on(t.tenantId, t.storeId),
    index("idx_sale_responsibilities_payer").on(t.payerId),
  ],
);

export type SaleResponsibilityRow = typeof saleResponsibilities.$inferSelect;
export type NewSaleResponsibilityRow = typeof saleResponsibilities.$inferInsert;
