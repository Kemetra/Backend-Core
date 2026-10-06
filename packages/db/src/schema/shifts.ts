/**
 * `shifts` — POS shift lifecycle (0002), extended by `0036_shift_cash_up`
 * (RT-17 slice 2) for the thin, cash-only cash-up.
 *
 *   - `source = 'legacy'`: a row written by the audit-ingest `shift.open`
 *     path (and every pre-0036 row). It carries no cash-up field.
 *   - `source = 'cash_up'`: an openShift fact. It carries the shift currency,
 *     the opening float, the store-local business date, the server receipt
 *     time, the recording actor and the payload hash. At most one is open per
 *     (tenant, device) (`uq_shifts_cash_up_open_device`).
 *
 * A cash-up row is guarded by a trigger (`shifts_cash_up_guard`): it moves
 * open → closed / closed_forced once, only with its `shift_closes` row, and
 * is never deleted. Policies, CHECKs and triggers live in the SQL migrations.
 */
import {
  char,
  check,
  customType,
  date,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { stores } from "./stores";
import { users } from "./users";
import { devices } from "./devices";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const shifts = pgTable(
  "shifts",
  {
    shiftId: uuid("shift_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    openingCashierUserId: uuid("opening_cashier_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    openingDeviceId: uuid("opening_device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "restrict" }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    lifecycleState: text("lifecycle_state").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // 0036 (RT-17): cash-up columns. NULL on every legacy row.
    source: text("source").notNull().default("legacy"),
    currencyCode: char("currency_code", { length: 3 }),
    openingFloat: numeric("opening_float", { precision: 19, scale: 4 }),
    businessDate: date("business_date"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    payloadHash: bytea("payload_hash"),
  },
  (t) => [
    check("shifts_lifecycle_state_check", sql`${t.lifecycleState} IN ('open', 'closed', 'closed_forced')`),
    check("shifts_source_valid", sql`${t.source} IN ('legacy', 'cash_up')`),
    check(
      "shifts_cash_up_fields_present",
      sql`${t.source} = 'legacy' OR (${t.currencyCode} IS NOT NULL AND ${t.openingFloat} IS NOT NULL
        AND ${t.businessDate} IS NOT NULL AND ${t.receivedAt} IS NOT NULL
        AND ${t.recordedByUserId} IS NOT NULL AND ${t.payloadHash} IS NOT NULL)`,
    ),
    check(
      "shifts_legacy_fields_absent",
      sql`${t.source} = 'cash_up' OR (${t.currencyCode} IS NULL AND ${t.openingFloat} IS NULL
        AND ${t.businessDate} IS NULL AND ${t.receivedAt} IS NULL
        AND ${t.recordedByUserId} IS NULL AND ${t.payloadHash} IS NULL)`,
    ),
    check(
      "shifts_currency_code_format",
      sql`${t.currencyCode} IS NULL OR ${t.currencyCode} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "shifts_opening_float_non_negative",
      sql`${t.openingFloat} IS NULL OR ${t.openingFloat} >= 0`,
    ),
    check(
      "shifts_payload_hash_len",
      sql`${t.payloadHash} IS NULL OR octet_length(${t.payloadHash}) = 32`,
    ),
    // Composite FK targets for the 0036 fact tables.
    unique("uq_shifts_cash_up_movement_target").on(
      t.shiftId,
      t.tenantId,
      t.storeId,
      t.openingDeviceId,
      t.currencyCode,
    ),
    unique("uq_shifts_cash_up_close_target").on(
      t.shiftId,
      t.tenantId,
      t.storeId,
      t.openingDeviceId,
      t.currencyCode,
      t.openingFloat,
    ),
    uniqueIndex("uq_shifts_cash_up_open_device")
      .on(t.tenantId, t.openingDeviceId)
      .where(sql`${t.source} = 'cash_up' AND ${t.lifecycleState} = 'open'`),
  ],
);

export type ShiftDbRow = typeof shifts.$inferSelect;
export type NewShiftDbRow = typeof shifts.$inferInsert;
