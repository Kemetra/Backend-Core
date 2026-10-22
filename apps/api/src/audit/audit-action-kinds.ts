/**
 * audit-action-kinds.ts — the code-owned action-kind registry (RT-567 D-1,
 * RT-687).
 *
 * Every audit `action` has a `kind`:
 *   - `read`   — the audited request only returned data; no business or
 *                session state changed (list/read/pull requests).
 *   - `change` — anything else: a state change, a security or session event,
 *                a rejected attempt.
 *
 * The kind is DERIVED from `action` at read time and never stored, so
 * historical rows are classified without a migration or backfill.
 *
 * Rules
 * -----
 *   - D-2: an action not in `READ_ACTION_CODES` is `change`. Hiding an
 *     unclassified event from an audit view is the worse failure.
 *   - D-3: entries are never removed. Audit rows are append-only (0034), so a
 *     code whose route is gone still needs its kind for old rows. Move a
 *     retired code onto `RETIRED_READ_CODES` instead of deleting it.
 *
 * The drift guard (`test/audit/audit-action-kinds.drift.spec.ts`) sweeps the
 * real AppModule: every `GET` `@Auditable` code must be here, no non-`GET`
 * code may be, and every code here must be a live `GET` `@Auditable` code or
 * on `RETIRED_READ_CODES`.
 */

export const AUDIT_ACTION_KINDS = ["read", "change"] as const;
export type AuditActionKind = (typeof AUDIT_ACTION_KINDS)[number];

/** `read` codes whose `@Auditable` route still exists. Sorted. */
const LIVE_READ_CODES = [
  "cash_variance_policy.device_read",
  "cash_variance_policy.store_read",
  "cash_variance_policy.store_revisions_listed",
  "cash_variance_policy.tenant_read",
  "cash_variance_policy.tenant_revisions_listed",
  "catalog.deltas.read",
  "catalog.snapshot.read",
  "console_sales.detail_read",
  "console_sales.listed",
  // RT-649: the console sales summary.
  "console_sales.summary_read",
  // RT-719: the fleet baseline read.
  "devices.fleet_baseline_read",
  "devices.impact_read",
  "devices.listed",
  "devices.read",
  "erpnext.bin_view.pulled",
  "erpnext.postings.pulled",
  "erpnext_reconciliation.backlog.listed",
  "erpnext_sync_ops.posting_backlog.listed",
  "erpnext_sync_ops.reconciliation_runs.listed",
  "erpnext_sync_ops.summary.read",
  "pairing_codes.listed",
  // RT-548 / RT-689: the POS readSale.
  "pos_sales.detail_read",
  // RT-787: the POS return reads (RT-490 R-8).
  "pos_sales.return_read",
  "pos_sales.returns_listed",
  "sale_history.detail_read",
  "sale_history.listed",
  "sale_sync_ops.audit_timeline.read",
  "sale_sync_ops.needs_repair.listed",
  "sale_sync_ops.status.read",
  "settlement.payer_account.listed",
  "settlement.receivable.listed",
  "settlement.receivable.read",
  "shift_closes.listed",
  "shift_closes.read",
] as const;

/**
 * `read` codes whose route was removed (D-3). Kept so historical rows keep
 * their kind. Adding a code here is a review decision: the drift guard
 * accepts it without a live route.
 */
export const RETIRED_READ_CODES: readonly string[] = [];

/** Every `read` code, live and retired. */
export const READ_ACTION_CODES: readonly string[] = [
  ...LIVE_READ_CODES,
  ...RETIRED_READ_CODES,
];

const READ_SET: ReadonlySet<string> = new Set(READ_ACTION_CODES);

/** The kind of `action`. Unregistered codes are `change` (D-2). */
export function kindOf(action: string): AuditActionKind {
  return READ_SET.has(action) ? "read" : "change";
}
