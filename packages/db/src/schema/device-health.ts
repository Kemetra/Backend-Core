/**
 * `device_health` — RT-327 (AD-DEVICE-001 D-1, D-4): the current heartbeat
 * READ-MODEL of one paired POS terminal. Exactly one row per device, created by
 * the first stored heartbeat, replaced by every later stored one
 * (last-write-wins, no history).
 *
 * Holds NO secret, NO PII, NO money: versions, enumerations, a migration name
 * and timestamps (§XIV). Identity is REFERENCED (PK = FK to `devices`), never
 * copied.
 *
 * §X: `last_seen_at` is the database SERVER clock at the last stored beat, the
 * only input of liveness. `source_clock_at` is the terminal's own clock, kept
 * as provenance only and never used for liveness or compliance. A NULL
 * self-reported field means "unknown", never a default.
 *
 * Constraints, RLS and the same-tenant device check on writes live in
 * migration `0068_pos_device_health.sql`.
 */
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { devices } from "./devices";
import { tenants } from "./tenants";

export const deviceHealth = pgTable("device_health", {
  deviceId: uuid("device_id")
    .primaryKey()
    .references(() => devices.id, { onDelete: "restrict" }),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  appVersion: text("app_version"),
  updateChannel: text("update_channel"),
  updateState: text("update_state"),
  pendingVersion: text("pending_version"),
  schemaHead: text("schema_head"),
  sourceClockAt: timestamp("source_clock_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DeviceHealthRow = typeof deviceHealth.$inferSelect;
export type NewDeviceHealthRow = typeof deviceHealth.$inferInsert;
