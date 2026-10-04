/**
 * `cashier_admissions` and `cashier_admission_requests` — the server-side
 * cashier admission authority (Jira RT-113 BC2; decisions D2 / D8 / D9 in
 * comment 10763, accepted basis in 10826). Policies, CHECKs and the partial
 * UNIQUE index live in `drizzle/0035_cashier_admissions.sql`.
 *
 *   - An admission is LIVE while `ended_at IS NULL`; at most one live row per
 *     (tenant, store, user) (`uq_cashier_admissions_live`).
 *   - A heartbeat renews `renewed_at` / `expires_at` on the same row; an
 *     expired live row is ended lazily with `end_reason = 'expired'`.
 *   - `cashier_admission_requests` is the device-scoped idempotency store:
 *     sha256 of the key and of the canonical body, the admission produced and
 *     the replayable `admitted` body. The raw key is never stored.
 *
 * Both tables are tenant-RLS-forced. No PIN, hash of a PIN, grant body or
 * secret is stored (RT-113 D2 / AD-2).
 */
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { devices } from "./devices";
import { stores } from "./stores";
import { tenants } from "./tenants";
import { users } from "./users";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const cashierAdmissions = pgTable(
  "cashier_admissions",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "restrict" }),
    mode: text("mode").notNull(),
    offlineAdmittedAt: timestamp("offline_admitted_at", { withTimezone: true }),
    // Same-tenant composite FK, declared below.
    takeoverOf: uuid("takeover_of"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: text("end_reason"),
  },
  (t) => [
    unique("uq_cashier_admissions_tenant_id").on(t.tenantId, t.id),
    foreignKey({
      name: "fk_cashier_admissions_takeover_of_tenant",
      columns: [t.tenantId, t.takeoverOf],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_cashier_admissions_store_tenant",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
    check("cashier_admissions_mode_valid", sql`${t.mode} IN ('online', 'reconcile_offline')`),
    check(
      "cashier_admissions_offline_time_reconcile_only",
      sql`${t.offlineAdmittedAt} IS NULL OR ${t.mode} = 'reconcile_offline'`,
    ),
    check(
      "cashier_admissions_end_reason_valid",
      sql`${t.endReason} IS NULL OR ${t.endReason} IN ('device_end', 'takeover', 'expired')`,
    ),
    check(
      "cashier_admissions_ended_has_reason",
      sql`(${t.endedAt} IS NULL) = (${t.endReason} IS NULL)`,
    ),
    check(
      "cashier_admissions_window_valid",
      sql`${t.renewedAt} >= ${t.createdAt} AND ${t.expiresAt} > ${t.renewedAt}`,
    ),
    check(
      "cashier_admissions_takeover_not_self",
      sql`${t.takeoverOf} IS NULL OR ${t.takeoverOf} <> ${t.id}`,
    ),
    uniqueIndex("uq_cashier_admissions_live")
      .on(t.tenantId, t.storeId, t.userId)
      .where(sql`${t.endedAt} IS NULL`),
    index("idx_cashier_admissions_device_live")
      .on(t.tenantId, t.deviceId)
      .where(sql`${t.endedAt} IS NULL`),
  ],
);

export const cashierAdmissionRequests = pgTable(
  "cashier_admission_requests",
  {
    id: uuid("id").primaryKey().notNull().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "restrict" }),
    keyHash: bytea("key_hash").notNull(),
    requestHash: bytea("request_hash").notNull(),
    // Same-tenant composite FK, declared below.
    admissionId: uuid("admission_id").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("uq_cashier_admission_requests_key").on(t.tenantId, t.deviceId, t.keyHash),
    foreignKey({
      name: "fk_cashier_admission_requests_admission_tenant",
      columns: [t.tenantId, t.admissionId],
      foreignColumns: [cashierAdmissions.tenantId, cashierAdmissions.id],
    }).onDelete("restrict"),
    check("cashier_admission_requests_key_hash_len", sql`octet_length(${t.keyHash}) = 32`),
    check(
      "cashier_admission_requests_request_hash_len",
      sql`octet_length(${t.requestHash}) = 32`,
    ),
    check("cashier_admission_requests_window_valid", sql`${t.expiresAt} > ${t.createdAt}`),
    index("idx_cashier_admission_requests_admission").on(t.admissionId),
  ],
);

export type CashierAdmissionRow = typeof cashierAdmissions.$inferSelect;
export type NewCashierAdmissionRow = typeof cashierAdmissions.$inferInsert;
export type CashierAdmissionRequestRow = typeof cashierAdmissionRequests.$inferSelect;
export type NewCashierAdmissionRequestRow = typeof cashierAdmissionRequests.$inferInsert;
