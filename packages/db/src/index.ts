/**
 * Public surface of `@data-pulse-2/db`.
 *
 * The `./schema` subpath remains the canonical source for table objects;
 * importing from here gets you the helpers + middleware + schema in one
 * spot. The CLI (src/cli/migrate.ts) is reached via the `bin` entry, not
 * via this barrel.
 *
 * Named re-exports (not `export *`) from audit-insert intentionally omit
 * `_makeInsertAuditEvent` — that internal seam is for tests only and must
 * not become part of the package's public API.
 */
export * from "./schema";
export * from "./helpers/with-tenant";
export * from "./middleware/tenant-context";
export { insertAuditEvent, type AuditEventInsertRow } from "./helpers/audit-insert";
export * from "./outbox";
export {
  lockPostingFeedSequence,
  POSTING_FEED_LOCK_NAMESPACE,
} from "./helpers/posting-feed-lock";
export {
  createStockReconciliationRun,
  failStockReconciliationRun,
  STOCK_RECONCILIATION_RUN_COLUMNS,
  stockRunReportCompleteSql,
  type CreateStockReconciliationRunInput,
  type CreateStockReconciliationRunResult,
  type FailStockReconciliationRunInput,
  type StockReconciliationRunFailureReason,
  type StockReconciliationRunRow,
  type StockReconciliationRunTrigger,
} from "./helpers/stock-reconciliation-run";
