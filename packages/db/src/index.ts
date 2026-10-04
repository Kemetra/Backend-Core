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
  createStockReconciliationRun,
  STOCK_RECONCILIATION_RUN_COLUMNS,
  type CreateStockReconciliationRunInput,
  type CreateStockReconciliationRunResult,
  type StockReconciliationRunRow,
  type StockReconciliationRunTrigger,
} from "./helpers/stock-reconciliation-run";
