/**
 * Inventory effect integration state — Drizzle schema (0042, Jira RT-425).
 *
 * `inventory_effect_integration` is the MUTABLE per-effect integration record
 * (RT-289 G2-3; decisions 771, 772, 774). The effect itself — a
 * `stock_movements` row — stays immutable and append-only; only this record's
 * state moves. One row per effect (PK `effect_id`).
 *
 * States: not_posted | pending | confirmed | rejected |
 * reconciliation_required | external | erp_neutral.
 *   - not_posted: a Retail effect with no ERP posting intent yet (RT-289 Q2).
 *   - pending / confirmed / rejected / reconciliation_required: an ERP posting
 *     intent (`erpnext_posting_status`) represents the effect; ERP posting
 *     outcomes move these (RT-426). A transition never inserts, edits or
 *     deletes an effect (771).
 *   - external: an ERP-origin effect (Gate 8 / RT-293).
 *   - erp_neutral: a Retail effect whose event nets to zero within one ERP
 *     mapping bucket, so it needs no ERP representation (RT-290 M-5, Q10;
 *     added by 0044, assigned by RT-435). No intent, no document.
 *
 * RLS: ENABLE + FORCE; SELECT + INSERT + UPDATE policies, NO DELETE policy
 * (0042). The same-tenant composite FKs to `stock_movements (id, tenant_id)`
 * and `erpnext_posting_status (id, tenant_id)` are defined in 0042's SQL.
 * §XIV: BUSINESS-CLASS — codes, opaque ids, an ERP document reference,
 * timestamps, a bounded reason. No PII, no money.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

export const INVENTORY_INTEGRATION_STATES = [
  "not_posted",
  "pending",
  "confirmed",
  "rejected",
  "reconciliation_required",
  "external",
  "erp_neutral",
] as const;
export type InventoryIntegrationState = (typeof INVENTORY_INTEGRATION_STATES)[number];

export const inventoryEffectIntegration = pgTable(
  "inventory_effect_integration",
  {
    effectId: uuid("effect_id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    state: text("state").notNull(),
    // The ERP posting intent that represents the effect (pending onward).
    postingStatusId: uuid("posting_status_id"),
    // ERPNext document {doctype, name} JSON text, as erpnext_posting_status.
    erpDocumentRef: text("erp_document_ref"),
    // Server time of the `posted` ack that confirmed the effect (G2-4).
    erpConfirmedAt: timestamp("erp_confirmed_at", { withTimezone: true }),
    stateReason: text("state_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "inventory_effect_integration_state_allowed",
      sql`${t.state} IN ('not_posted', 'pending', 'confirmed', 'rejected', 'reconciliation_required', 'external', 'erp_neutral')`,
    ),
    // An ERP intent exists exactly for the intent-bearing states.
    check(
      "inventory_effect_integration_intent_link",
      sql`(${t.postingStatusId} IS NOT NULL) = (${t.state} IN ('pending', 'confirmed', 'rejected', 'reconciliation_required'))`,
    ),
    check(
      "inventory_effect_integration_confirmed_at",
      sql`(${t.state} = 'confirmed') = (${t.erpConfirmedAt} IS NOT NULL)`,
    ),
    check(
      "inventory_effect_integration_confirmed_document",
      sql`${t.state} <> 'confirmed' OR ${t.erpDocumentRef} IS NOT NULL`,
    ),
    check(
      "inventory_effect_integration_not_posted_bare",
      sql`${t.state} <> 'not_posted' OR ${t.erpDocumentRef} IS NULL`,
    ),
    check(
      "inventory_effect_integration_erp_neutral_bare",
      sql`${t.state} <> 'erp_neutral' OR ${t.erpDocumentRef} IS NULL`,
    ),
    check(
      "inventory_effect_integration_reason_length",
      sql`${t.stateReason} IS NULL OR char_length(${t.stateReason}) <= 500`,
    ),
    index("idx_inventory_effect_integration_tenant_state").on(t.tenantId, t.state),
    index("idx_inventory_effect_integration_posting")
      .on(t.postingStatusId)
      .where(sql`${t.postingStatusId} IS NOT NULL`),
  ],
);

export type InventoryEffectIntegrationRow = typeof inventoryEffectIntegration.$inferSelect;
export type NewInventoryEffectIntegrationRow = typeof inventoryEffectIntegration.$inferInsert;
