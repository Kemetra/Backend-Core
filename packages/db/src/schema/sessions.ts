/**
 * `sessions` — dashboard session record. (data-model.md §9)
 *
 * Constraints declared in SQL:
 *   - CHECK: `active_store_id IS NULL` OR `active_tenant_id IS NOT NULL`
 *   - Trigger `sessions_active_store_tenant_check` enforces that
 *     `active_store_id`'s tenant matches `active_tenant_id` (Invariant I-4,
 *     migration 0003).
 *   - Partial indexes for active sessions and absolute-expiry sweeps.
 *
 * NO RLS (sessions are user-scoped, not tenant-scoped). The dashboard
 * cookie is NOT `id`. `id` is a UUIDv7 row key. The cookie is a separate
 * CSPRNG value; only its SHA-256 is stored in `credential_hash`.
 */
import { customType, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { stores } from "./stores";
import { tenants } from "./tenants";
import { users } from "./users";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  /**
   * SHA-256 of the raw `dp2_session` cookie. The raw value is returned to
   * the browser once and is never stored. Lookup is by this hash.
   */
  credentialHash: bytea("credential_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  activeTenantId: uuid("active_tenant_id").references(() => tenants.id, {
    onDelete: "set null",
  }),
  activeStoreId: uuid("active_store_id").references(() => stores.id, {
    onDelete: "set null",
  }),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  absoluteExpiresAt: timestamp("absolute_expires_at", {
    withTimezone: true,
  }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  userAgent: text("user_agent"),
  ipAtIssue: text("ip_at_issue"),
});

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
