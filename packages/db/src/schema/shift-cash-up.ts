/**
 * `shift_closes`, `shift_cash_movements` and `shift_refund_claims` — the
 * immutable cash-up facts of RT-17 slice 2 (`0036_shift_cash_up.sql`;
 * [GATED] approval: Jira RT-17 comments 10760 + 10919 + 10920).
 *
 *   - `shift_closes`: the ShiftClosed fact, one per shift. The POS totals are
 *     recorded verbatim; CHECKs hold the arithmetic invariant
 *     (`expected_cash = opening_float + cash_sales_total − cash_refunds_total
 *     + pay_in_total − pay_out_total`, `variance = counted_cash −
 *     expected_cash`). Its composite FK pins the shift's tenant, store,
 *     device, currency and opening float.
 *   - `shift_cash_movements`: pay-in / pay-out facts on an open shift.
 *   - `shift_refund_claims`: a close's `cashRefundReturnRefs`; a return is
 *     claimed by at most one close (`return_id` is the PK).
 *
 * All three are append-only for every role (UPDATE / DELETE / TRUNCATE raise
 * 42501) and tenant-RLS-forced with SELECT and INSERT policies only. Policies
 * and triggers live in the SQL migration.
 */
import { sql } from "drizzle-orm";
import {
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { devices } from "./devices";
import { saleReturns } from "./sales/sale-returns";
import { shifts } from "./shifts";
import { stores } from "./stores";
import { tenants } from "./tenants";
import { users } from "./users";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

const money = (name: string) => numeric(name, { precision: 19, scale: 4 });

export const shiftCloses = pgTable(
  "shift_closes",
  {
    shiftId: uuid("shift_id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "restrict" }),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
    closingUserId: uuid("closing_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    closeKind: text("close_kind").notNull(),
    forcedReason: text("forced_reason"),
    openingFloat: money("opening_float").notNull(),
    cashSalesTotal: money("cash_sales_total").notNull(),
    cashRefundsTotal: money("cash_refunds_total").notNull(),
    payInTotal: money("pay_in_total").notNull(),
    payOutTotal: money("pay_out_total").notNull(),
    expectedCash: money("expected_cash").notNull(),
    countedCash: money("counted_cash").notNull(),
    variance: money("variance").notNull(),
    saleCount: integer("sale_count").notNull(),
    varianceApprovedByUserId: uuid("variance_approved_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    payloadHash: bytea("payload_hash").notNull(),
  },
  (t) => [
    foreignKey({
      name: "fk_shift_closes_shift",
      columns: [t.shiftId, t.tenantId, t.storeId, t.deviceId, t.currencyCode, t.openingFloat],
      foreignColumns: [
        shifts.shiftId,
        shifts.tenantId,
        shifts.storeId,
        shifts.openingDeviceId,
        shifts.currencyCode,
        shifts.openingFloat,
      ],
    }).onDelete("restrict"),
    unique("uq_shift_closes_shift_tenant_store").on(t.shiftId, t.tenantId, t.storeId),
    check("shift_closes_close_kind_valid", sql`${t.closeKind} IN ('normal', 'forced')`),
    check(
      "shift_closes_forced_reason_iff_forced",
      sql`(${t.closeKind} = 'forced') = (${t.forcedReason} IS NOT NULL)`,
    ),
    check(
      "shift_closes_forced_reason_length",
      sql`${t.forcedReason} IS NULL OR char_length(${t.forcedReason}) BETWEEN 1 AND 200`,
    ),
    check("shift_closes_currency_code_format", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check(
      "shift_closes_amounts_non_negative",
      sql`${t.openingFloat} >= 0 AND ${t.cashSalesTotal} >= 0 AND ${t.cashRefundsTotal} >= 0
        AND ${t.payInTotal} >= 0 AND ${t.payOutTotal} >= 0 AND ${t.expectedCash} >= 0
        AND ${t.countedCash} >= 0`,
    ),
    check(
      "shift_closes_amounts_not_nan",
      sql`${t.openingFloat} <> 'NaN'::numeric AND ${t.cashSalesTotal} <> 'NaN'::numeric
        AND ${t.cashRefundsTotal} <> 'NaN'::numeric AND ${t.payInTotal} <> 'NaN'::numeric
        AND ${t.payOutTotal} <> 'NaN'::numeric AND ${t.expectedCash} <> 'NaN'::numeric
        AND ${t.countedCash} <> 'NaN'::numeric AND ${t.variance} <> 'NaN'::numeric`,
    ),
    check("shift_closes_sale_count_non_negative", sql`${t.saleCount} >= 0`),
    check(
      "shift_closes_expected_cash_arithmetic",
      sql`${t.expectedCash} = ${t.openingFloat} + ${t.cashSalesTotal} - ${t.cashRefundsTotal}
        + ${t.payInTotal} - ${t.payOutTotal}`,
    ),
    check(
      "shift_closes_variance_arithmetic",
      sql`${t.variance} = ${t.countedCash} - ${t.expectedCash}`,
    ),
    check("shift_closes_payload_hash_len", sql`octet_length(${t.payloadHash}) = 32`),
    index("idx_shift_closes_tenant_store").on(t.tenantId, t.storeId),
  ],
);

export const shiftCashMovements = pgTable(
  "shift_cash_movements",
  {
    id: uuid("id").primaryKey().notNull(),
    shiftId: uuid("shift_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "restrict" }),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    kind: text("kind").notNull(),
    amount: money("amount").notNull(),
    reasonCode: text("reason_code").notNull(),
    note: text("note"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    payloadHash: bytea("payload_hash").notNull(),
  },
  (t) => [
    foreignKey({
      name: "fk_shift_cash_movements_shift",
      columns: [t.shiftId, t.tenantId, t.storeId, t.deviceId, t.currencyCode],
      foreignColumns: [
        shifts.shiftId,
        shifts.tenantId,
        shifts.storeId,
        shifts.openingDeviceId,
        shifts.currencyCode,
      ],
    }).onDelete("restrict"),
    check("shift_cash_movements_kind_valid", sql`${t.kind} IN ('pay_in', 'pay_out')`),
    check("shift_cash_movements_amount_positive", sql`${t.amount} > 0`),
    check("shift_cash_movements_amount_not_nan", sql`${t.amount} <> 'NaN'::numeric`),
    check(
      "shift_cash_movements_reason_code_valid",
      sql`${t.reasonCode} IN ('bank_drop', 'float_top_up', 'petty_expense', 'other')`,
    ),
    check(
      "shift_cash_movements_note_length",
      sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND 200`,
    ),
    check("shift_cash_movements_currency_code_format", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("shift_cash_movements_payload_hash_len", sql`octet_length(${t.payloadHash}) = 32`),
    index("idx_shift_cash_movements_shift").on(t.tenantId, t.shiftId, t.occurredAt),
  ],
);

export const shiftRefundClaims = pgTable(
  "shift_refund_claims",
  {
    returnId: uuid("return_id").primaryKey().notNull(),
    shiftId: uuid("shift_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
  },
  (t) => [
    foreignKey({
      name: "fk_shift_refund_claims_close",
      columns: [t.shiftId, t.tenantId, t.storeId],
      foreignColumns: [shiftCloses.shiftId, shiftCloses.tenantId, shiftCloses.storeId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_shift_refund_claims_return",
      columns: [t.returnId, t.tenantId, t.storeId],
      foreignColumns: [saleReturns.id, saleReturns.tenantId, saleReturns.storeId],
    }).onDelete("restrict"),
    check("shift_refund_claims_ordinal_non_negative", sql`${t.ordinal} >= 0`),
    unique("uq_shift_refund_claims_shift_ordinal").on(t.shiftId, t.ordinal),
  ],
);

export type ShiftCloseDbRow = typeof shiftCloses.$inferSelect;
export type NewShiftCloseDbRow = typeof shiftCloses.$inferInsert;
export type ShiftCashMovementDbRow = typeof shiftCashMovements.$inferSelect;
export type NewShiftCashMovementDbRow = typeof shiftCashMovements.$inferInsert;
export type ShiftRefundClaimDbRow = typeof shiftRefundClaims.$inferSelect;
export type NewShiftRefundClaimDbRow = typeof shiftRefundClaims.$inferInsert;
