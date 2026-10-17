/**
 * Credit-sale reversals (Jira RT-577; contract `pos-sales/sales.yaml`
 * 1.11.0-draft `recordCreditSaleReversal`; owner rulings D6 / D7 / D8,
 * 2026-10-17). Policies, CHECKs, the backfill and the sale_voids trigger are in
 * `0054_sale_credit_reversals.sql`.
 *
 *   - `sale_credit_reversals`: one row per credit reversal, extending exactly
 *     one `sale_voids` or `sale_returns` row OF THE SAME SALE with the
 *     server-computed allocation (total = refundable + adjustment), the payer
 *     adjustment, the actor and role, the reason and the D6 second approval of
 *     a cash-paying return. Append-only.
 *   - `sale_credit_reversal_tenders`: the refund paid out, in request order
 *     (a void mirrors the collected tenders; a return is cash only).
 *   - `sale_approval_uses`: the shared single-use ledger of approval ids across
 *     recordVoid and credit reversals (filled for voids by a trigger).
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
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { payerAccount } from "../settlement/payer-account";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { saleReturns } from "./sale-returns";
import { sales } from "./sales";
import { saleVoids } from "./sale-terminal-events";

export const saleApprovalUses = pgTable(
  "sale_approval_uses",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    approvalId: uuid("approval_id").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "sale_approval_uses_pkey", columns: [t.tenantId, t.approvalId] }),
    check("sale_approval_uses_source_valid", sql`${t.source} IN ('void', 'credit_return')`),
  ],
);

export const saleCreditReversals = pgTable(
  "sale_credit_reversals",
  {
    id: uuid("id").primaryKey().notNull().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    saleId: uuid("sale_id").notNull(),
    kind: text("kind").notNull(),
    voidId: uuid("void_id"),
    returnId: uuid("return_id"),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    businessDate: date("business_date").notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    reversalTotal: numeric("reversal_total", { precision: 19, scale: 4 }).notNull(),
    refundableAmount: numeric("refundable_amount", { precision: 19, scale: 4 }).notNull(),
    adjustmentAmount: numeric("adjustment_amount", { precision: 19, scale: 4 }).notNull(),
    payerId: uuid("payer_id").notNull(),
    adjustmentRef: uuid("adjustment_ref"),
    actorUserId: uuid("actor_user_id").notNull(),
    actorRole: text("actor_role").notNull(),
    reason: text("reason").notNull(),
    approvalId: uuid("approval_id"),
    approvedByUserId: uuid("approved_by_user_id"),
    requestedByUserId: uuid("requested_by_user_id"),
    approvalPolicyVersion: text("approval_policy_version"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("sale_credit_reversals_kind_valid", sql`${t.kind} IN ('void', 'return')`),
    check(
      "sale_credit_reversals_allocation_sums",
      sql`${t.refundableAmount} + ${t.adjustmentAmount} = ${t.reversalTotal}`,
    ),
    foreignKey({
      name: "fk_sale_credit_reversals_sale_tenant_store",
      columns: [t.saleId, t.tenantId, t.storeId],
      foreignColumns: [sales.id, sales.tenantId, sales.storeId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_sale_credit_reversals_return_tenant_store",
      columns: [t.returnId, t.tenantId, t.storeId],
      foreignColumns: [saleReturns.id, saleReturns.tenantId, saleReturns.storeId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_sale_credit_reversals_void_sale",
      columns: [t.voidId, t.saleId],
      foreignColumns: [saleVoids.id, saleVoids.saleId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_sale_credit_reversals_return_sale",
      columns: [t.returnId, t.saleId],
      foreignColumns: [saleReturns.id, saleReturns.saleId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_sale_credit_reversals_payer_tenant",
      columns: [t.payerId, t.tenantId],
      foreignColumns: [payerAccount.id, payerAccount.tenantId],
    }).onDelete("restrict"),
    unique("uq_sale_credit_reversals_id_tenant_store").on(t.id, t.tenantId, t.storeId),
    unique("uq_sale_credit_reversals_void").on(t.voidId),
    unique("uq_sale_credit_reversals_return").on(t.returnId),
    uniqueIndex("uq_sale_credit_reversals_tenant_source_external").on(t.tenantId, t.sourceSystem, t.externalId),
    index("idx_sale_credit_reversals_sale").on(t.saleId),
    index("idx_sale_credit_reversals_tenant_store").on(t.tenantId, t.storeId),
  ],
);

export const saleCreditReversalTenders = pgTable(
  "sale_credit_reversal_tenders",
  {
    id: uuid("id").primaryKey().notNull().default(sql`gen_random_uuid()`),
    reversalId: uuid("reversal_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    method: text("method").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    tenderRef: uuid("tender_ref"),
    reference: text("reference"),
  },
  (t) => [
    check("sale_credit_reversal_tenders_method_valid", sql`${t.method} IN ('cash', 'card_external')`),
    check("sale_credit_reversal_tenders_amount_non_negative", sql`${t.amount} >= 0`),
    foreignKey({
      name: "fk_sale_credit_reversal_tenders_reversal_tenant_store",
      columns: [t.reversalId, t.tenantId, t.storeId],
      foreignColumns: [saleCreditReversals.id, saleCreditReversals.tenantId, saleCreditReversals.storeId],
    }).onDelete("restrict"),
    unique("uq_sale_credit_reversal_tenders_reversal_ordinal").on(t.reversalId, t.ordinal),
    index("idx_sale_credit_reversal_tenders_tenant_store").on(t.tenantId, t.storeId),
  ],
);

export type SaleCreditReversalRow = typeof saleCreditReversals.$inferSelect;
export type SaleCreditReversalTenderRow = typeof saleCreditReversalTenders.$inferSelect;
export type SaleApprovalUseRow = typeof saleApprovalUses.$inferSelect;
