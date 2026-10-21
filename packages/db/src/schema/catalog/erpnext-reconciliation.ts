/**
 * `erpnext_reconciliation_*` — ERPNext Reconciliation & Repair state (017
 * data-model.md §2). Three tables — 017's OWN operational reconciliation state.
 *
 * 017 is the arc's operational reconciliation surface (run → report → repair). It
 * READS (never mirrors) the 015 `erpnext_posting_status` dead-letters, the 014
 * `erpnext_warehouse_map` mapping, and the 009 `stock_movements` ledger; it OWNS:
 *
 *   1. `erpnext_reconciliation_run` — one reconciliation execution. **STOCK-ONLY**
 *      in v1 (data-model §2.1): the posting dead-letter backlog (US1) is a LIVE
 *      READ-PROJECTION over the 015 rows, NOT a run — a `kind='posting'` run would
 *      never produce result rows, so it is not modeled. The `kind` CHECK reserves
 *      room to add `'posting'` later only if a posting-snapshot run is ever needed.
 *   2. `erpnext_reconciliation_result` — one classified line of a run's mismatch
 *      report, in **014's mismatch-class vocabulary ONLY** (014 data-model §6.2,
 *      finalized; the 015 posting categories live on the 015 rows, read in place,
 *      never mirrored — READ-NOT-MIRROR / R2). `result_state` is 017's OWN
 *      orthogonal workflow status. Single-column `run_id` FK to the run PK
 *      (id is a UUIDv7 PK + RLS scopes both rows to one tenant, so a composite
 *      `(run_id, tenant_id)` FK needing an extra unique buys nothing).
 *   3. `erpnext_reconciliation_repair_attempt` — APPEND-ONLY audit of every repair
 *      (`re_post` / `re_map` / `re_sync` / `drain`). `target_ref_id` is POLYMORPHIC
 *      (the 015 `erpnext_posting_status.id` for a posting repair, or a result id
 *      for a stock repair) — deliberately NO FK (the 0019 `source_ref_id` / 0018
 *      `erpnext_warehouse_ref` / 013 `erpnext_item_ref` no-FK rationale).
 *
 * Mutable tenant-owned resources: run (running → completed/failed) + result
 * (open → repaired/accepted) get SELECT+INSERT+UPDATE RLS; repair_attempt is
 * APPEND-ONLY (SELECT+INSERT only). NO DELETE policy anywhere — retention is a
 * status, not a row removal (§XIV). Policies live in the 0020 migration. RLS-
 * enabled + FORCE by `tenant_id`. TENANT-only tables — `store_id` is a tenant-
 * local FK, not a second RLS axis.
 *
 * NO money / valuation / PII column — these are BUSINESS-class operational
 * records (refs, provenance, mismatch classes, counts, qty). The `summary` /
 * `detail` jsonb carry counts + operator-facing qty values + refs ONLY. The
 * audit-of-record write (FR-014) is a separate in-transaction `INSERT INTO
 * audit_events` done by the 017 service/worker — NOT modeled here.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { users } from "../users";

export const erpnextReconciliationRun = pgTable(
  "erpnext_reconciliation_run",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // A stock run is always store-scoped (it needs the 014 mapping).
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    // STOCK-ONLY in v1 — the posting backlog is a read-projection, not a run.
    kind: text("kind").notNull().default("stock"),
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Counts by mismatch class — BUSINESS-class counts ONLY, never PII/money.
    summary: jsonb("summary"),
    setBy: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    correlationId: uuid("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("erpnext_reconciliation_run_kind_valid", sql`${t.kind} IN ('stock')`),
    check(
      "erpnext_reconciliation_run_trigger_valid",
      sql`${t.trigger} IN ('on_demand', 'scheduled')`,
    ),
    check(
      "erpnext_reconciliation_run_status_valid",
      sql`${t.status} IN ('running', 'completed', 'failed')`,
    ),
    check(
      "erpnext_reconciliation_run_finished_when_terminal",
      sql`(${t.status} = 'running') = (${t.finishedAt} IS NULL)`,
    ),
    index("idx_erpnext_reconciliation_run_tenant_time").on(
      t.tenantId,
      t.startedAt.desc(),
    ),
  ],
);

export const erpnextReconciliationResult = pgTable(
  "erpnext_reconciliation_result",
  {
    id: uuid("id").primaryKey().notNull(),
    // Single-column FK to the run PK (data-model §2.2 / advisor #1).
    runId: uuid("run_id")
      .notNull()
      .references(() => erpnextReconciliationRun.id, { onDelete: "restrict" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // 014's mismatch-class vocabulary ONLY (014 data-model §6.2). The 015 posting
    // categories are NOT here — read in place on the 015 rows (READ-NOT-MIRROR).
    mismatchClass: text("mismatch_class").notNull(),
    // The originating ref for a stock line (the product ref); NULL for an
    // aggregate line. POLYMORPHIC — deliberately NO FK.
    sourceRefId: uuid("source_ref_id"),
    sourceSystem: text("source_system"),
    externalId: text("external_id"),
    // 017's OWN orthogonal workflow status (distinct from the mismatch class).
    resultState: text("result_state").notNull().default("open"),
    // Operator-facing values (DP2 vs ERPNext qty etc.) — qty/refs, never PII/money.
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "erpnext_reconciliation_result_class_valid",
      // 0066 (RT-428) adds the pending-aware classes 927–929 and uom_mismatch.
      sql`${t.mismatchClass} IN ('match', 'quantity_divergence', 'unmapped_store', 'unmapped_item', 'dp2_only', 'erpnext_only', 'negative_balance_flagged', 'expected_pending_erp', 'expected_pending_retail', 'erp_snapshot_stale', 'uom_mismatch')`,
    ),
    check(
      "erpnext_reconciliation_result_state_valid",
      sql`${t.resultState} IN ('open', 'repaired', 'accepted')`,
    ),
    index("idx_erpnext_reconciliation_result_run").on(
      t.tenantId,
      t.runId,
      t.mismatchClass,
    ),
  ],
);

export const erpnextReconciliationRepairAttempt = pgTable(
  "erpnext_reconciliation_repair_attempt",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    targetKind: text("target_kind").notNull(),
    // The 015 erpnext_posting_status.id (posting) OR a result id (stock).
    // POLYMORPHIC — deliberately NO FK.
    targetRefId: uuid("target_ref_id").notNull(),
    repairKind: text("repair_kind").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    outcome: text("outcome").notNull(),
    // Echoed when a posting repair resolves to a posted document (O-3).
    resolvedDocumentRef: text("resolved_document_ref"),
    correlationId: uuid("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "erpnext_reconciliation_repair_attempt_target_kind_valid",
      sql`${t.targetKind} IN ('posting', 'stock')`,
    ),
    check(
      "erpnext_reconciliation_repair_attempt_repair_kind_valid",
      sql`${t.repairKind} IN ('re_post', 're_map', 're_sync', 'drain')`,
    ),
    check(
      "erpnext_reconciliation_repair_attempt_outcome_valid",
      sql`${t.outcome} IN ('eligible_again', 'still_failing', 'no_op_echo')`,
    ),
    index("idx_erpnext_reconciliation_repair_attempt_target").on(
      t.tenantId,
      t.targetKind,
      t.targetRefId,
    ),
  ],
);

export type ErpnextReconciliationRunRow =
  typeof erpnextReconciliationRun.$inferSelect;
export type NewErpnextReconciliationRunRow =
  typeof erpnextReconciliationRun.$inferInsert;
export type ErpnextReconciliationResultRow =
  typeof erpnextReconciliationResult.$inferSelect;
export type NewErpnextReconciliationResultRow =
  typeof erpnextReconciliationResult.$inferInsert;
export type ErpnextReconciliationRepairAttemptRow =
  typeof erpnextReconciliationRepairAttempt.$inferSelect;
export type NewErpnextReconciliationRepairAttemptRow =
  typeof erpnextReconciliationRepairAttempt.$inferInsert;
