/**
 * RT-812 baseline: every grant the API boot check verified before grants
 * moved to one fragment per feature (origin/main 7847a9e9). FROZEN: never add
 * an entry, script or table here. A new grant, deploy script or table goes in
 * its own `<slug>.grants.ts` beside this file (see CONTRIBUTING.md); the
 * grant-fragment spec fails if this file gains one. Entries keep their
 * original comments; removing a retired grant is fine.
 */
import {
  ALL_PRIVILEGES_EXCEPT_SELECT,
  ALL_TABLE_PRIVILEGES,
  type GrantFragment,
} from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: [
    "cashier-admissions-domain-grants.sql",
    "device-lifecycle-domain-grants.sql",
    "erpnext-posting-resolution-domain-grants.sql",
    "inventory-anchors-domain-grants.sql",
    "inventory-effect-integration-domain-grants.sql",
    "inventory-position-events-domain-grants.sql",
    "platform-support-sessions-domain-grants.sql",
    "refund-executions-domain-grants.sql",
    "sale-credit-reversals-domain-grants.sql",
    "sale-reprints-domain-grants.sql",
    "sale-responsibilities-domain-grants.sql",
    "shift-cash-up-domain-grants.sql",
    "shift-variance-policy-domain-grants.sql",
    "signin-memberships-domain-grants.sql",
    "stock-locations-domain-grants.sql",
    "tracking-foundation-domain-grants.sql",
  ],
  /**
   * RT-212: grants the domain (DATABASE_URL) role must hold. Runtime grants
   * are provisioned outside migrations, so a deploy that skips a grant step
   * would otherwise boot healthy while the affected routes return 500. Each
   * entry is one privilege; boot fails if any is missing.
   */
  domainRequired: [
    // RT-113 BC2 (0035): admissions are ended, never deleted.
    ["cashier_admissions", "SELECT"],
    ["cashier_admissions", "INSERT"],
    ["cashier_admissions", "UPDATE"],
    // The replay store also purges expired entries.
    ["cashier_admission_requests", "SELECT"],
    ["cashier_admission_requests", "INSERT"],
    ["cashier_admission_requests", "UPDATE"],
    ["cashier_admission_requests", "DELETE"],
    // RT-213: every device-authenticated request reads the device's tenant
    // status on this role (DeviceRepository, inside the tenant's RLS context).
    // Without the grant every till would be refused at once, so boot fails.
    ["tenants", "SELECT"],
    // RT-343: sign-in reads the user's memberships, joined to roles and
    // tenants, on this role (as /context/me and TenantContextGuard do).
    // Without these grants every Console sign-in would return 500.
    ["memberships", "SELECT"],
    ["roles", "SELECT"],
    // RT-17 (0036): the shift cash-up writes. `shifts` gains cash-up rows and
    // needs UPDATE: the close moves the shift to closed, and the 0036 triggers
    // lock the shift row FOR SHARE / FOR UPDATE, which requires UPDATE. The
    // three fact tables are append-only (no UPDATE, DELETE or TRUNCATE).
    ["shifts", "SELECT"],
    ["shifts", "INSERT"],
    ["shifts", "UPDATE"],
    ["shift_closes", "SELECT"],
    ["shift_closes", "INSERT"],
    ["shift_cash_movements", "SELECT"],
    ["shift_cash_movements", "INSERT"],
    ["shift_refund_claims", "SELECT"],
    ["shift_refund_claims", "INSERT"],
    // RT-330 (0037): the worker freezes a posting intent's resolution and the
    // feed and repair read it. Append-only (no UPDATE / DELETE policy).
    ["erpnext_posting_resolution", "SELECT"],
    ["erpnext_posting_resolution", "INSERT"],
    // RT-425 (0042): every manual movement, transfer and count writes its
    // effect's integration record, and the movement list reads it. UPDATE:
    // the state moves (RT-426). No DELETE policy; never DELETE or TRUNCATE.
    ["inventory_effect_integration", "SELECT"],
    ["inventory_effect_integration", "INSERT"],
    ["inventory_effect_integration", "UPDATE"],
    // RT-432 (0044): every inventory write resolves its effect's stock location
    // and the movement list / on-hand / location list read it. INSERT: creating a
    // store creates its primary location in the same transaction (the
    // stores_create_primary_location trigger runs as this role). No UPDATE /
    // DELETE policy; never UPDATE, DELETE or TRUNCATE.
    ["stock_locations", "SELECT"],
    ["stock_locations", "INSERT"],
    // RT-448 (0045): the tracking-identity list reads identities. Read-only in
    // this release: nothing writes identities or the edge map yet (RT-453), so
    // neither INSERT nor any erpnext_tracking_map privilege is required. No
    // UPDATE / DELETE policy; never UPDATE, DELETE or TRUNCATE.
    ["tracking_identities", "SELECT"],
    // RT-435 (0056): a status move or relocation writes its event record, and a
    // replay reads it back. Append-only (no UPDATE / DELETE policy); never UPDATE,
    // DELETE or TRUNCATE. The return landing policy is read and upserted. No
    // DELETE policy; never DELETE or TRUNCATE.
    ["inventory_position_events", "SELECT"],
    ["inventory_position_events", "INSERT"],
    ["tenant_inventory_settings", "SELECT"],
    ["tenant_inventory_settings", "INSERT"],
    ["tenant_inventory_settings", "UPDATE"],
    // RT-427 (0063): sale-effects activation writes the Inventory Anchor of
    // every store and the comparison reads it (API and worker share this role).
    // Append-only (no UPDATE / DELETE policy); never UPDATE, DELETE or TRUNCATE.
    // Apply with docs/operations/sql/inventory-anchors-domain-grants.sql.
    ["inventory_anchors", "SELECT"],
    ["inventory_anchors", "INSERT"],
    ["inventory_anchor_lines", "SELECT"],
    ["inventory_anchor_lines", "INSERT"],
    // RT-539 (0047): every reprint authorized or recorded writes one row, and
    // the next server copy number reads them. Append-only (no UPDATE / DELETE
    // policy); never UPDATE, DELETE or TRUNCATE.
    ["sale_reprints", "SELECT"],
    ["sale_reprints", "INSERT"],
    // RT-418 (0051): a credit capture writes the sale's responsibilities, and
    // the sale read and the posting feed (API and worker share this role) read
    // them. Append-only (no UPDATE / DELETE policy); never UPDATE, DELETE or
    // TRUNCATE.
    ["sale_responsibilities", "SELECT"],
    ["sale_responsibilities", "INSERT"],
    // RT-418, RT-572: the Console payer-account routes read, create and update payers, and a
    // credit capture locks its payer row FOR SHARE (which needs UPDATE) so the
    // payer cannot be suspended between the check and the sale. No DELETE.
    ["payer_account", "SELECT"],
    ["payer_account", "INSERT"],
    ["payer_account", "UPDATE"],
    // RT-577 (0054): a credit reversal writes its row and refund tenders, and its
    // projection and replay read them back; a cash-paying credit return writes
    // its approval id to the shared single-use ledger and reads it to refuse a
    // reuse. All append-only (no UPDATE / DELETE policy); never UPDATE, DELETE
    // or TRUNCATE. (A void's ledger row is written by the SECURITY DEFINER
    // sale_voids trigger and needs no grant.)
    ["sale_credit_reversals", "SELECT"],
    ["sale_credit_reversals", "INSERT"],
    ["sale_credit_reversal_tenders", "SELECT"],
    ["sale_credit_reversal_tenders", "INSERT"],
    ["sale_approval_uses", "SELECT"],
    ["sale_approval_uses", "INSERT"],
    // RT-787 (0067): a refund execution is written once and read back by its
    // replay, the return reads and the posting feed. Append-only (no UPDATE /
    // DELETE policy); never UPDATE, DELETE or TRUNCATE.
    ["refund_executions", "SELECT"],
    ["refund_executions", "INSERT"],
    // RT-387 (0050): the Console publishes policy revisions and every resolution
    // (device read, Console reads, the open's accept-and-flag check) reads them;
    // a close's approver verdict is written once after the commit and read back
    // by the close replay and the admin shift-close reads. Both tables are
    // append-only (no UPDATE / DELETE policy, a trigger refuses both); never
    // UPDATE, DELETE or TRUNCATE.
    ["cash_variance_policy_revisions", "SELECT"],
    ["cash_variance_policy_revisions", "INSERT"],
    ["shift_close_approver_checks", "SELECT"],
    ["shift_close_approver_checks", "INSERT"],
    // RT-365: the Console device revoke locks the device row FOR UPDATE (which
    // needs UPDATE) and sets the revoke fields. No earlier domain path wrote
    // `devices` (pairing only INSERTs), so a deploy that skips the grant must
    // fail here at boot, not answer 500 on every revoke. Apply:
    //   GRANT UPDATE ON devices TO <DATABASE_URL role>;
    ["devices", "UPDATE"],
    // RT-367: the Console pairing codes. INSERT: the issue (until RT-367 only
    // the owner-run CLI inserted codes, as the table owner). SELECT: the list,
    // the cancel and the one-replacement check. UPDATE: the cancel, and the
    // redemption's attempt count and burn. A deploy that skips the grant must
    // fail here at boot, not answer 500 on every issue. Apply with
    // docs/operations/sql/device-lifecycle-domain-grants.sql. No DELETE (spent
    // codes are kept for audit).
    ["pairing_codes", "SELECT"],
    ["pairing_codes", "INSERT"],
    ["pairing_codes", "UPDATE"],
    // RT-414 (0062): every platform-admin request into a non-member tenant reads
    // its support session; open inserts one, renew and end update it (FOR
    // UPDATE). Never deleted (0062's trigger); never DELETE or TRUNCATE. Apply
    // with docs/operations/sql/platform-support-sessions-domain-grants.sql.
    ["platform_support_sessions", "SELECT"],
    ["platform_support_sessions", "INSERT"],
    ["platform_support_sessions", "UPDATE"],
  ],
  /**
   * Tables the lookup role must hold NO listed privilege on (sales,
   * receivables, cashier admissions, shift cash-up, tenants, inventory, audit,
   * idempotency, outbox, membership mutation).
   * Each entry is a table and the privileges that are forbidden on it.
   */
  lookupForbidden: [
    ...[
      "sales",
      "sale_lines",
      "sale_tenders",
      "sale_voids",
      "sale_refunds",
      "sale_returns",
      "sale_return_lines",
      "sale_return_tenders",
      "sale_sync_deadletters",
      // RT-539 (0047): the receipt reprint record.
      "sale_reprints",
      // RT-418 (0051): payer responsibilities on the sale fact.
      "sale_responsibilities",
      // RT-577 (0054): credit-sale reversals, their refund tenders and the
      // shared approval-use ledger.
      "sale_credit_reversals",
      "sale_credit_reversal_tenders",
      "sale_approval_uses",
      // RT-787 (0067): refund executions.
      "refund_executions",
      "receivable",
      "claim",
      "claim_receivables",
      "payment_application",
      "remittance",
      "payer_account",
      // RT-113 BC2: cashier admission state and its replay store.
      "cashier_admissions",
      "cashier_admission_requests",
      // RT-17 (0036): shift cash-up facts. `shifts` holds the cash-up opens.
      "shifts",
      "shift_closes",
      "shift_cash_movements",
      "shift_refund_claims",
      // RT-387 (0050): the shift variance policy revisions and the persisted
      // approver verdict of a close.
      "cash_variance_policy_revisions",
      "shift_close_approver_checks",
      // RT-213: with BYPASSRLS any grant on tenants would expose every tenant
      // row. Device auth reads tenant status on the domain role instead.
      "tenants",
      "stock_movements",
      "stock_counts",
      // RT-425 (0042): the mutable per-effect inventory integration state.
      "inventory_effect_integration",
      // RT-432 (0044): stock locations (the inventory position grain).
      "stock_locations",
      // RT-448 (0045): tracking identities and their ERPNext edge map.
      "tracking_identities",
      "erpnext_tracking_map",
      // RT-435 (0056): status-move / relocation event records and the tenant
      // inventory settings.
      "inventory_position_events",
      "tenant_inventory_settings",
      // RT-427 (0063): the Inventory Anchors taken at sale-effects activation.
      "inventory_anchors",
      "inventory_anchor_lines",
      // RT-414 (0062): platform support sessions (platform-admin RLS only).
      "platform_support_sessions",
      "audit_events",
      "idempotency_keys",
      "outbox_events",
    ].map((table) => [table, ALL_TABLE_PRIVILEGES] as const),
    ["memberships", ALL_PRIVILEGES_EXCEPT_SELECT],
    ["store_access", ALL_PRIVILEGES_EXCEPT_SELECT],
    // RT-367: the lookup role reads a pairing code by hash at the anonymous
    // bootstrap (SELECT); every write (issue, cancel, burn) is the domain role's.
    ["pairing_codes", ALL_PRIVILEGES_EXCEPT_SELECT],
  ],
  lookupAllowed: [],
};
