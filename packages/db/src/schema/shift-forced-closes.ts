/**
 * `shift_forced_closes` — a manager's force close of a stuck shift, recorded
 * as NOT COUNTED (`0070_shift_forced_closes.sql`; Jira RT-742, [GATED];
 * contract `pos-shifts.openapi.yaml` 1.4.0-draft `forceCloseShift`).
 *
 * One per shift: the closing manager, the calling terminal, the server clock,
 * the reason and the natural-key payload hash. No total of any kind: it is
 * not a `shift_closes` row (Constitution §III). The shift moves to the
 * existing `closed_forced` state; this row is what says "not counted".
 *
 * Composite FKs pin the shift to the same tenant, store and opening terminal
 * (legacy shifts included) and the calling terminal to the same tenant and
 * store. Append-only for every role; tenant-RLS-forced with SELECT and INSERT
 * policies only. Policies and triggers live in the SQL migration.
 */
import { sql } from "drizzle-orm";
import { check, customType, foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { devices } from "./devices";
import { shifts } from "./shifts";
import { stores } from "./stores";
import { tenants } from "./tenants";
import { users } from "./users";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const shiftForcedCloses = pgTable(
  "shift_forced_closes",
  {
    shiftId: uuid("shift_id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    openingDeviceId: uuid("opening_device_id").notNull(),
    closedFromDeviceId: uuid("closed_from_device_id").notNull(),
    closedByUserId: uuid("closed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
    forcedReason: text("forced_reason").notNull(),
    payloadHash: bytea("payload_hash").notNull(),
  },
  (t) => [
    foreignKey({
      name: "fk_shift_forced_closes_shift",
      columns: [t.shiftId, t.tenantId, t.storeId, t.openingDeviceId],
      foreignColumns: [shifts.shiftId, shifts.tenantId, shifts.storeId, shifts.openingDeviceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_shift_forced_closes_closed_from_device",
      columns: [t.closedFromDeviceId, t.tenantId, t.storeId],
      foreignColumns: [devices.id, devices.tenantId, devices.storeId],
    }).onDelete("restrict"),
    check("shift_forced_closes_reason_length", sql`char_length(${t.forcedReason}) BETWEEN 1 AND 200`),
    check("shift_forced_closes_payload_hash_len", sql`octet_length(${t.payloadHash}) = 32`),
    index("idx_shift_forced_closes_tenant_store").on(t.tenantId, t.storeId),
  ],
);

export type ShiftForcedCloseDbRow = typeof shiftForcedCloses.$inferSelect;
export type NewShiftForcedCloseDbRow = typeof shiftForcedCloses.$inferInsert;
