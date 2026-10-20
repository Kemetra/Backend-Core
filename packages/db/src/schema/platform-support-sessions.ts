/**
 * `platform_support_sessions` — a platform admin's support session in a
 * tenant they are not a member of (Jira RT-414, RT-391 D2). CHECKs, the
 * partial UNIQUE index, the guard triggers and the platform-admin-only RLS
 * policy live in `drizzle/0062_platform_support_sessions.sql`.
 *
 *   - A support session is LIVE while `ended_at IS NULL`; at most one live
 *     row per auth session (`platform_support_sessions_live_auth_session_idx`).
 *   - It is `active` while live and `expires_at` is in the future, `expired`
 *     once it has passed (computed, never stored).
 *   - Renewal moves `renewed_at` / `expires_at`, never past `renewal_cap_at`
 *     (`opened_at` + 8 hours). Ending sets `ended_at` / `end_reason`; an ended
 *     row is frozen.
 *
 * No email, token or secret is stored; `ticket_ref` is pattern-bound.
 */
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sessions } from "./sessions";
import { tenants } from "./tenants";
import { users } from "./users";

export const SUPPORT_PURPOSES = ["customer_support", "incident", "onboarding"] as const;
export type SupportPurpose = (typeof SUPPORT_PURPOSES)[number];

export const SUPPORT_SESSION_END_REASONS = [
  "operator",
  "replaced",
  "tenant_switched",
  "signed_out",
] as const;
export type SupportSessionEndReason = (typeof SUPPORT_SESSION_END_REASONS)[number];

export const platformSupportSessions = pgTable("platform_support_sessions", {
  id: uuid("id").primaryKey().notNull(),
  authSessionId: uuid("auth_session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "restrict" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  purpose: text("purpose").$type<SupportPurpose>().notNull(),
  ticketRef: text("ticket_ref"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  renewedAt: timestamp("renewed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  renewalCapAt: timestamp("renewal_cap_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason").$type<SupportSessionEndReason>(),
});

export type PlatformSupportSessionRow = typeof platformSupportSessions.$inferSelect;
