/**
 * `devices` — per-terminal trust factor for POS operator sign-in.
 * Source of truth for the column shape: ADR 0001 D7.
 *
 * Tenant- and store-scoped; device tokens are stored as SHA-256 hashes only
 * (never plaintext). Revocation is supported via `revoked_at`. Sign-in
 * requires both a verified Clerk JWT (human identity) and a validated
 * device row (terminal trust).
 *
 * RLS is enabled by `tenant_id`; policy mirrors the standard tenant
 * isolation predicate. Partial active-token index, CHECK constraints, and
 * the `updated_at` trigger live in
 * `drizzle/0001_pos_operator_identity.sql`.
 *
 * Lifecycle columns (RT-138 / RT-287, migration `0040_device_lifecycle`,
 * declared here by RT-365): expiry, activity last-seen, revoke attribution
 * (reason enum + note CHECKs), the rotation overlap and retire. Their CHECKs
 * live in the migration. 0040 must be applied before code that declares them
 * deploys: Drizzle `select()` names every declared column.
 */
import { sql } from "drizzle-orm";
import { customType, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { stores } from "./stores";
import { tenants } from "./tenants";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  storeId: uuid("store_id")
    .notNull()
    .references(() => stores.id, { onDelete: "restrict" }),
  label: text("label"),
  tokenHash: bytea("token_hash").notNull().unique(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // 0040 (RT-364): device lifecycle.
  expiresAt: timestamp("expires_at", { withTimezone: true })
    .notNull()
    .default(sql`(now() + interval '90 days')`),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedBy: uuid("revoked_by"),
  revokeReason: text("revoke_reason"),
  revokeNote: text("revoke_note"),
  previousTokenHash: bytea("previous_token_hash"),
  previousValidUntil: timestamp("previous_valid_until", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  retiredBy: uuid("retired_by"),
  retireReason: text("retire_reason"),
}, (t) => [
  // 0070 (RT-742): the composite FK target pinning a force close's calling
  // terminal to its tenant and store.
  unique("uq_devices_tenant_store_target").on(t.id, t.tenantId, t.storeId),
]);

export type DeviceRow = typeof devices.$inferSelect;
export type NewDeviceRow = typeof devices.$inferInsert;
