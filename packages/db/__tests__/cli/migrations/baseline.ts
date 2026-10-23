/**
 * RT-812 baseline: every migration on origin/main 7847a9e9, when the expected
 * chain moved from one hand-written list to one registry file per migration.
 * FROZEN: never add a migration here. A new migration adds its own
 * `./<id>.ts` exporting MIGRATION with a probe (see CONTRIBUTING.md);
 * `migration-registry.spec.ts` fails if this list gains an entry.
 *
 * Probes exist from 0046 on (the older migrations are asserted inline in
 * migrate.spec.ts). Each reads only its own migration's objects, so after any
 * single `down` exactly one probe changes. If a later migration changes objects
 * an earlier probe reads, update that probe's `applied` value.
 */
import {
  countColumns,
  countConstraints,
  countFunctions,
  countIndexes,
  countPolicies,
  countTables,
  countTriggers,
  countValidIndexes,
  type MigrationEntry,
  type MigrationProbe,
  type ProbeDb,
} from "../migration-probes";

export const BASELINE_HEAD = "0067_refund_executions";

/** A probe over a single valid index (the CONCURRENTLY migrations). */
const validIndex = (name: string): MigrationProbe => ({
  measure: async (db) => [await countValidIndexes(db, [name])],
  applied: ["1"],
  rolledBack: ["0"],
});

const zeros = (n: number): string[] => Array.from({ length: n }, () => "0");

const AI_ENTITLEMENT_TABLES = [
  "ai_plan_catalog",
  "ai_plan_catalog_features",
  "ai_plan_catalog_meters",
  "tenant_ai_entitlements",
  "tenant_ai_feature_opt_outs",
  "ai_usage_counters",
  "ai_usage_ledger",
];

const PROBES: Readonly<Record<string, MigrationProbe>> = {
  // RT-530: the six approval columns on sale_voids, their CHECK and the single-use index.
  "0046_sale_void_approval": {
    measure: async (db) => [
      await countColumns(db, "sale_voids", [
        "approval_id",
        "approved_by_user_id",
        "requested_by_user_id",
        "approval_policy_version",
        "approved_at",
        "void_business_date",
      ]),
      await countConstraints(db, ["sale_voids_approval_all_or_none"]),
      await countIndexes(db, ["uq_sale_voids_tenant_approval"]),
    ],
    applied: ["6", "1", "1"],
    rolledBack: zeros(3),
  },
  // RT-538: the nine receipt columns, line_seq, sale_reprints and its SELECT + INSERT policies.
  "0047_sale_history_capture": {
    measure: async (db) => [
      await countColumns(db, "sales", [
        "receipt_sale_number",
        "receipt_number",
        "receipt_terminal_label",
        "receipt_operator_display_name",
        "receipt_settled_at",
        "receipt_branch_name",
        "receipt_branch_address",
        "receipt_tax_registration_id",
        "receipt_change_given",
      ]),
      await countColumns(db, "sale_lines", ["line_seq"]),
      await countTables(db, ["sale_reprints"]),
      await countPolicies(db, ["sale_reprints"]),
    ],
    applied: ["9", "1", "1", "2"],
    rolledBack: zeros(4),
  },
  // RT-538: the store/business-date index, built CONCURRENTLY.
  "0048_sales_store_business_date_idx": validIndex("idx_sales_tenant_store_business_date"),
  // RT-385: policy revisions + approver verdicts (SELECT + INSERT each), six
  // frozen-policy columns on shifts, two tri-states on shift_closes.
  "0050_shift_variance_policy": {
    measure: async (db: ProbeDb) => {
      const tables = ["cash_variance_policy_revisions", "shift_close_approver_checks"];
      return [
        await countTables(db, tables),
        await countPolicies(db, tables),
        await db.count(`SELECT COUNT(*)::text AS count FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'shifts' AND column_name LIKE 'frozen_policy%'`),
        await countColumns(db, "shift_closes", ["approval_required_by_policy", "approval_missing"]),
      ];
    },
    applied: ["2", "4", "6", "2"],
    rolledBack: zeros(4),
  },
  // RT-418: sale_responsibilities (SELECT + INSERT), the two new columns, and
  // payer_account.credit_terms dropped (restored by the down).
  "0051_sale_responsibilities": {
    measure: async (db) => [
      await countTables(db, ["sale_responsibilities"]),
      await countPolicies(db, ["sale_responsibilities"]),
      await countColumns(db, "sales", ["responsibility_count"]),
      await countColumns(db, "erpnext_posting_resolution", ["payer_external_ref"]),
      await countColumns(db, "payer_account", ["credit_terms"]),
    ],
    applied: ["1", "2", "1", "1", "0"],
    rolledBack: ["0", "0", "0", "0", "1"],
  },
  // RT-577: three credit reversal tables (SELECT + INSERT each), the sale_voids
  // approval-use trigger and the two (id, sale_id) FK-target indexes.
  "0054_sale_credit_reversals": {
    measure: async (db) => {
      const tables = ["sale_credit_reversals", "sale_credit_reversal_tenders", "sale_approval_uses"];
      return [
        await countTables(db, tables),
        await countPolicies(db, tables),
        await countTriggers(db, ["sale_voids_record_approval_use"]),
        await countIndexes(db, ["uq_sale_voids_id_sale", "uq_sale_returns_id_sale"]),
      ];
    },
    applied: ["3", "6", "1", "2"],
    rolledBack: zeros(4),
  },
  // RT-663: seven AI entitlement tables (15 policies), four trigger functions,
  // the one default-deny catalog seed row.
  "0055_ai_entitlements_usage": {
    measure: async (db) => {
      const tables = await countTables(db, AI_ENTITLEMENT_TABLES);
      return [
        tables,
        await countPolicies(db, AI_ENTITLEMENT_TABLES),
        await countFunctions(db, [
          "ai_entitlements_append_only",
          "ai_plan_catalog_version_open",
          "ai_usage_counters_guard",
          "ai_usage_ledger_terminal_guard",
        ]),
        tables === "0" ? "0" : await db.count(`SELECT COUNT(*)::text AS count FROM ai_plan_catalog`),
      ];
    },
    applied: ["7", "15", "4", "1"],
    rolledBack: zeros(4),
  },
  // RT-435: event records (SELECT + INSERT), settings (SELECT + INSERT +
  // UPDATE) and the settings updated_at trigger.
  "0056_inventory_position_events": {
    measure: async (db) => {
      const tables = ["inventory_position_events", "tenant_inventory_settings"];
      return [
        await countTables(db, tables),
        await countPolicies(db, tables),
        await countTriggers(db, ["tenant_inventory_settings_set_updated_at"]),
      ];
    },
    applied: ["2", "5", "1"],
    rolledBack: zeros(3),
  },
  // RT-565 D7: one posting-freshness index each, built CONCURRENTLY.
  "0057_posting_status_posted_at_tenant_idx": validIndex("idx_erpnext_posting_status_posted_at_tenant"),
  "0058_posting_status_posted_at_store_idx": validIndex("idx_erpnext_posting_status_posted_at_store"),
  "0059_posting_status_pending_created_tenant_idx": validIndex("idx_erpnext_posting_status_pending_created_tenant"),
  "0060_posting_status_pending_created_store_idx": validIndex("idx_erpnext_posting_status_pending_created_store"),
  "0061_posting_status_legacy_posted_idx": validIndex("idx_erpnext_posting_status_legacy_posted"),
  // RT-414: the support-session table, its platform-admin policy, two guard
  // triggers and the guard function.
  "0062_platform_support_sessions": {
    measure: async (db) => [
      await countTables(db, ["platform_support_sessions"]),
      await countPolicies(db, ["platform_support_sessions"]),
      await countTriggers(db, ["platform_support_sessions_guard_row", "platform_support_sessions_guard_truncate"]),
      await countFunctions(db, ["platform_support_sessions_guard"]),
    ],
    applied: ["1", "1", "2", "1"],
    rolledBack: zeros(4),
  },
  // RT-427: the anchor tables (SELECT + INSERT each) and the two activation
  // columns on tenant_inventory_settings.
  "0063_inventory_effects_activation": {
    measure: async (db) => {
      const tables = ["inventory_anchors", "inventory_anchor_lines"];
      return [
        await countTables(db, tables),
        await countPolicies(db, tables),
        await countColumns(db, "tenant_inventory_settings", ["sale_effects_activated_at", "sale_effects_activated_by"]),
      ];
    },
    applied: ["2", "4", "2"],
    rolledBack: zeros(3),
  },
  // RT-735: one stock-movement history index each, built CONCURRENTLY.
  "0064_stock_movements_store_occurred_idx": validIndex("idx_stock_movements_tenant_store_occurred"),
  "0065_stock_movements_store_product_occurred_idx": validIndex("idx_stock_movements_tenant_store_product_occurred"),
  // RT-428: the widened, validated result-class CHECK admitting the pending-aware classes.
  "0066_reconciliation_pending_aware_classes": {
    measure: async (db) => [
      await db.count(`SELECT COUNT(*)::text AS count FROM pg_constraint
        WHERE conname = 'erpnext_reconciliation_result_class_valid'
          AND pg_get_constraintdef(oid) LIKE '%uom_mismatch%' AND convalidated`),
    ],
    applied: ["1"],
    rolledBack: ["0"],
  },
  // RT-787: refund_executions (SELECT + INSERT), the three allocation columns
  // on sale_return_tenders plus sale_returns.posting_deferred, the
  // original-tender trigger.
  "0067_refund_executions": {
    measure: async (db) => {
      const columns =
        Number(await countColumns(db, "sale_return_tenders", ["allocation_ref", "original_tender_ref", "instrument"])) +
        Number(await countColumns(db, "sale_returns", ["posting_deferred"]));
      return [
        await countTables(db, ["refund_executions"]),
        await countPolicies(db, ["refund_executions"]),
        String(columns),
        await countTriggers(db, ["sale_return_tenders_original_tender_check"]),
      ];
    },
    applied: ["1", "2", "4", "1"],
    rolledBack: zeros(4),
  },
};

const IDS = [
  "0000_initial",
  "0001_pos_operator_identity",
  "0002_shifts",
  "0003_session_active_store_tenant_invariant",
  "0004_audit_retention_marker",
  "0005_audit_retention_privileges",
  "0006_outbox_events",
  "0007_catalog",
  "0008_catalog_store_read_isolation",
  "0009_catalog_store_empty_guc_fix",
  "0010_catalog_tenant_empty_guc_fix",
  "0011_catalog_store_carveout_sentinel",
  "0012_sales",
  "0013_store_timezone",
  "0014_inventory",
  "0015_pos_catalog_read_down",
  "0016_inventory_unit_guard",
  "0017_erpnext_item_map",
  "0018_erpnext_warehouse_map",
  "0019_erpnext_posting_status",
  "0020_erpnext_reconciliation",
  "0021_connector_registration",
  "0022_connector_health",
  "0023_erpnext_product_reconciliation",
  "0024_pairing_codes",
  "0025_external_identity_links",
  "0026_sale_sync_status",
  "0027_settlement_receivables",
  "0028_outbox_claim_recovery",
  "0029_session_credential_hash",
  "0030_session_membership_trigger",
  "0031_outbox_tenant_fk",
  "0032_sale_returns",
  "0033_sale_tenders",
  "0034_audit_events_append_only",
  "0035_cashier_admissions",
  "0036_shift_cash_up",
  "0037_erpnext_posting_resolution",
  "0038_erpnext_posting_resolution_backfill",
  "0039_erpnext_posting_reconciliation_evidence",
  "0040_device_lifecycle",
  "0041_sale_tender_ref",
  "0042_inventory_effects_journal",
  "0043_inventory_effect_integration_backfill",
  "0044_stock_locations_position_grain",
  "0045_tracking_foundation",
  "0046_sale_void_approval",
  "0047_sale_history_capture",
  "0048_sales_store_business_date_idx",
  "0050_shift_variance_policy",
  "0051_sale_responsibilities",
  "0054_sale_credit_reversals",
  "0055_ai_entitlements_usage",
  "0056_inventory_position_events",
  "0057_posting_status_posted_at_tenant_idx",
  "0058_posting_status_posted_at_store_idx",
  "0059_posting_status_pending_created_tenant_idx",
  "0060_posting_status_pending_created_store_idx",
  "0061_posting_status_legacy_posted_idx",
  "0062_platform_support_sessions",
  "0063_inventory_effects_activation",
  "0064_stock_movements_store_occurred_idx",
  "0065_stock_movements_store_product_occurred_idx",
  "0066_reconciliation_pending_aware_classes",
  "0067_refund_executions",
];

export const BASELINE_MIGRATIONS: readonly MigrationEntry[] = IDS.map((id) => {
  const probe = PROBES[id];
  return probe ? { id, probe } : { id };
});
