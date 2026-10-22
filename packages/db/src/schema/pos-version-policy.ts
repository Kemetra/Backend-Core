/**
 * `pos_version_policy` — RT-327 (AD-DEVICE-001 D-2): the GLOBAL POS version
 * policy, one row per update channel (`lab`, `canary`, `stable`). Platform
 * level: not tenant-editable and not overridable per tenant, so the table has
 * no tenant column.
 *
 * `min_supported_version <= recommended_version <= latest_version` in
 * semantic-version precedence is enforced by the API (422), not by the
 * database. `revision` is bumped by every effective change and is the
 * compare-and-set token of the next one. `updated_by_user_id` is a user id,
 * never an email.
 *
 * RLS (migration `0068_pos_device_health.sql`): ENABLE + FORCE; SELECT is open
 * to every context, INSERT and UPDATE need the platform-admin GUC; no DELETE
 * policy.
 */
import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./users";

export const posVersionPolicy = pgTable("pos_version_policy", {
  channel: text("channel").primaryKey(),
  latestVersion: text("latest_version").notNull(),
  recommendedVersion: text("recommended_version").notNull(),
  minSupportedVersion: text("min_supported_version").notNull(),
  minSupportedGraceUntil: timestamp("min_supported_grace_until", { withTimezone: true }).notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: uuid("updated_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
});

export type PosVersionPolicyRow = typeof posVersionPolicy.$inferSelect;
export type NewPosVersionPolicyRow = typeof posVersionPolicy.$inferInsert;
