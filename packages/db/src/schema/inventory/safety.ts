/**
 * Inventory safety — Drizzle schema (0072, Jira RT-449; RT-50 Gate 7 G7-6 /
 * G7-7; owner rulings H1–H8, RT-449 comment 13434).
 *
 *   - `tenant_inventory_safety_revisions`: one row per tenant holding its
 *     monotonic Inventory Safety Revision (> 0; a guard trigger refuses any
 *     step back). No row reads as revision 0.
 *   - `inventory_safety_changes`: one change per (tenant, revision) — its
 *     kind and the hold / recall / identity it names. Append-only. The POS
 *     `inventory-safety` feed's delta reads it (RT-449 PR 2).
 *   - `inventory_recalls`: the Recall event record (860). Append-only.
 *   - `tracking_holds`: a quality or recall hold on a tracking identity of
 *     the hold's own product. At most one ACTIVE hold per (identity, kind); a
 *     guard trigger lets an UPDATE only set the release, once.
 *   - `tracking_identity_expiry_corrections`: the expiry correction history
 *     (G7-2). Append-only. 0072's identity guard refuses an `expiry_date`
 *     change without its correction row in the same transaction.
 *
 * RLS: ENABLE + FORCE on all five. The composite FKs, triggers and policies
 * are defined in 0072's SQL. §XIV: BUSINESS-CLASS — opaque ids, codes, an
 * authority reference, bounded notes, dates, a counter, SHA-256 fingerprints,
 * timestamps. No PII, no money.
 */
import { sql } from "drizzle-orm";
import { bigint, check, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

export const TRACKING_HOLD_KINDS = ["quality_hold", "recall_hold"] as const;
export type TrackingHoldKind = (typeof TRACKING_HOLD_KINDS)[number];

export const INVENTORY_SAFETY_CHANGE_KINDS = [
  "hold_placed",
  "hold_released",
  "recall_created",
  "expiry_corrected",
  "tracking_profile_changed",
] as const;
export type InventorySafetyChangeKind = (typeof INVENTORY_SAFETY_CHANGE_KINDS)[number];

/** A machine reason code: lower snake case, 1–64 characters. */
export const SAFETY_REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const REASON_CODE_SQL = "'^[a-z][a-z0-9_]{0,63}$'";
const FINGERPRINT_SQL = "'^[0-9a-f]{64}$'";

export const tenantInventorySafetyRevisions = pgTable(
  "tenant_inventory_safety_revisions",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("tenant_inventory_safety_revisions_positive", sql`${t.revision} > 0`)],
);

export const inventoryRecalls = pgTable(
  "inventory_recalls",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    tenantProductRef: uuid("tenant_product_ref").notNull(),
    reasonCode: text("reason_code").notNull(),
    reference: text("reference").notNull(),
    note: text("note"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    commandFingerprint: text("command_fingerprint").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("inventory_recalls_reason_code_shape", sql`${t.reasonCode} ~ ${sql.raw(REASON_CODE_SQL)}`),
    check(
      "inventory_recalls_reference_shape",
      sql`char_length(${t.reference}) BETWEEN 1 AND 200 AND ${t.reference} = btrim(${t.reference})`,
    ),
    check("inventory_recalls_note_length", sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND 500`),
    check("inventory_recalls_fingerprint_shape", sql`${t.commandFingerprint} ~ ${sql.raw(FINGERPRINT_SQL)}`),
    uniqueIndex("uq_inventory_recalls_tenant_fingerprint").on(t.tenantId, t.commandFingerprint),
    uniqueIndex("uq_inventory_recalls_id_product_tenant").on(t.id, t.tenantProductRef, t.tenantId),
    uniqueIndex("uq_inventory_recalls_id_tenant").on(t.id, t.tenantId),
  ],
);

export type InventoryRecallRow = typeof inventoryRecalls.$inferSelect;

export const trackingHolds = pgTable(
  "tracking_holds",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    trackingIdentityId: uuid("tracking_identity_id").notNull(),
    tenantProductRef: uuid("tenant_product_ref").notNull(),
    kind: text("kind").notNull(),
    reasonCode: text("reason_code").notNull(),
    note: text("note"),
    recallId: uuid("recall_id"),
    commandFingerprint: text("command_fingerprint"),
    placedBy: uuid("placed_by").notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    releasedBy: uuid("released_by"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseNote: text("release_note"),
  },
  (t) => [
    check("tracking_holds_kind_allowed", sql`${t.kind} IN ('quality_hold', 'recall_hold')`),
    check("tracking_holds_recall_iff_recall_hold", sql`(${t.kind} = 'recall_hold') = (${t.recallId} IS NOT NULL)`),
    check("tracking_holds_release_paired", sql`(${t.releasedBy} IS NULL) = (${t.releasedAt} IS NULL)`),
    check(
      "tracking_holds_release_note_when_released",
      sql`${t.releaseNote} IS NULL OR (${t.releasedAt} IS NOT NULL AND char_length(${t.releaseNote}) BETWEEN 1 AND 500)`,
    ),
    check("tracking_holds_reason_code_shape", sql`${t.reasonCode} ~ ${sql.raw(REASON_CODE_SQL)}`),
    check("tracking_holds_note_length", sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND 500`),
    check(
      "tracking_holds_fingerprint_shape",
      sql`${t.commandFingerprint} IS NULL OR ${t.commandFingerprint} ~ ${sql.raw(FINGERPRINT_SQL)}`,
    ),
    uniqueIndex("uq_tracking_holds_active_identity_kind")
      .on(t.tenantId, t.trackingIdentityId, t.kind)
      .where(sql`${t.releasedAt} IS NULL`),
    uniqueIndex("uq_tracking_holds_tenant_fingerprint").on(t.tenantId, t.commandFingerprint),
    uniqueIndex("uq_tracking_holds_id_tenant").on(t.id, t.tenantId),
    index("idx_tracking_holds_recall").on(t.recallId).where(sql`${t.recallId} IS NOT NULL`),
  ],
);

export type TrackingHoldRow = typeof trackingHolds.$inferSelect;

export const trackingIdentityExpiryCorrections = pgTable(
  "tracking_identity_expiry_corrections",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    trackingIdentityId: uuid("tracking_identity_id").notNull(),
    tenantProductRef: uuid("tenant_product_ref").notNull(),
    oldExpiryDate: date("old_expiry_date"),
    newExpiryDate: date("new_expiry_date"),
    reasonCode: text("reason_code").notNull(),
    note: text("note"),
    commandFingerprint: text("command_fingerprint").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "tracking_identity_expiry_corrections_changes",
      sql`${t.oldExpiryDate} IS DISTINCT FROM ${t.newExpiryDate}`,
    ),
    check(
      "tracking_identity_expiry_corrections_reason_code_shape",
      sql`${t.reasonCode} ~ ${sql.raw(REASON_CODE_SQL)}`,
    ),
    check(
      "tracking_identity_expiry_corrections_note_length",
      sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND 500`,
    ),
    check(
      "tracking_identity_expiry_corrections_fingerprint_shape",
      sql`${t.commandFingerprint} ~ ${sql.raw(FINGERPRINT_SQL)}`,
    ),
    uniqueIndex("uq_tracking_identity_expiry_corrections_tenant_fingerprint").on(
      t.tenantId,
      t.commandFingerprint,
    ),
    index("idx_tracking_identity_expiry_corrections_identity").on(t.trackingIdentityId, t.createdAt),
  ],
);

export const inventorySafetyChanges = pgTable(
  "inventory_safety_changes",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    trackingHoldId: uuid("tracking_hold_id"),
    inventoryRecallId: uuid("inventory_recall_id"),
    trackingIdentityId: uuid("tracking_identity_id"),
    tenantProductRef: uuid("tenant_product_ref").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("inventory_safety_changes_revision_positive", sql`${t.revision} > 0`),
    check(
      "inventory_safety_changes_kind_allowed",
      sql`${t.kind} IN ('hold_placed', 'hold_released', 'recall_created', 'expiry_corrected', 'tracking_profile_changed')`,
    ),
    check(
      "inventory_safety_changes_hold_refs",
      sql`${t.kind} NOT IN ('hold_placed', 'hold_released') OR (${t.trackingHoldId} IS NOT NULL AND ${t.trackingIdentityId} IS NOT NULL)`,
    ),
    check(
      "inventory_safety_changes_recall_refs",
      sql`${t.kind} <> 'recall_created' OR ${t.inventoryRecallId} IS NOT NULL`,
    ),
    check(
      "inventory_safety_changes_expiry_refs",
      sql`${t.kind} <> 'expiry_corrected' OR ${t.trackingIdentityId} IS NOT NULL`,
    ),
    uniqueIndex("uq_inventory_safety_changes_tenant_revision").on(t.tenantId, t.revision),
  ],
);
