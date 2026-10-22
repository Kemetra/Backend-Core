/**
 * `refund_executions` — the REFUND EXECUTION (Jira RT-787; RT-271 R-1, R-3,
 * R-4). Policies, CHECKs and the composite FKs in `0067_refund_executions.sql`.
 *
 * One append-only row per settled cash payout of one refund allocation
 * (`sale_return_tenders` with an `allocation_ref`). Distinct from the return's
 * acceptance and from the allocation; a settled execution is never edited or
 * rolled back (Sales & Returns 1063). The return's refund obligation is
 * derived from these rows, never stored (RT-277).
 *
 *   - `execution_ref` (POS-minted) is unique per tenant; the provenance
 *     `(tenant_id, source_system, external_id)` is unique (R-3).
 *   - composite FKs pin the row to its return (and that return's sale and
 *     scope) and to an allocation OF that return with the same allocation_ref.
 *   - `settles_return` marks the execution that settled a return deferred at
 *     acceptance (R-7); at most one per return.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { saleReturns, saleReturnTenders } from "./sale-returns";

export const refundExecutions = pgTable(
  "refund_executions",
  {
    id: uuid("id").primaryKey().notNull(),
    executionRef: uuid("execution_ref").notNull(),
    returnId: uuid("return_id").notNull(),
    allocationId: uuid("allocation_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    allocationRef: uuid("allocation_ref").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    outcome: text("outcome").notNull(),
    evidenceMethod: text("evidence_method").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    shiftRef: uuid("shift_ref").notNull(),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    settlesReturn: boolean("settles_return").notNull().default(false),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    check("refund_executions_amount_positive", sql`${t.amount} > 0`),
    check("refund_executions_outcome_valid", sql`${t.outcome} IN ('settled')`),
    check("refund_executions_evidence_method_valid", sql`${t.evidenceMethod} IN ('drawer', 'manual')`),
    check(
      "refund_executions_source_system_length",
      sql`char_length(${t.sourceSystem}) BETWEEN 1 AND 100`,
    ),
    check(
      "refund_executions_external_id_length",
      sql`char_length(${t.externalId}) BETWEEN 1 AND 200`,
    ),
    uniqueIndex("uq_refund_executions_tenant_source_external").on(
      t.tenantId,
      t.sourceSystem,
      t.externalId,
    ),
    uniqueIndex("uq_refund_executions_tenant_execution_ref").on(t.tenantId, t.executionRef),
    uniqueIndex("uq_refund_executions_one_settling")
      .on(t.returnId)
      .where(sql`${t.settlesReturn}`),
    index("idx_refund_executions_return").on(t.returnId),
    index("idx_refund_executions_allocation").on(t.allocationId),
    index("idx_refund_executions_tenant_store").on(t.tenantId, t.storeId),
    foreignKey({
      name: "fk_refund_executions_return_tenant_store",
      columns: [t.returnId, t.tenantId, t.storeId],
      foreignColumns: [saleReturns.id, saleReturns.tenantId, saleReturns.storeId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_refund_executions_return_sale",
      columns: [t.returnId, t.saleId],
      foreignColumns: [saleReturns.id, saleReturns.saleId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_refund_executions_allocation",
      columns: [t.allocationId, t.returnId, t.allocationRef],
      foreignColumns: [saleReturnTenders.id, saleReturnTenders.returnId, saleReturnTenders.allocationRef],
    }).onDelete("restrict"),
  ],
);

export type RefundExecutionRow = typeof refundExecutions.$inferSelect;
export type NewRefundExecutionRow = typeof refundExecutions.$inferInsert;
