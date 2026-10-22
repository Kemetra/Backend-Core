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
  AI_USAGE_RESERVATION_LOCK_NAMESPACE,
  listExpiredAiReservations,
  settleAiReservation,
  type AiUsageTelemetry,
  type AiUsageTerminalKind,
  type ExpiredAiReservationQuery,
  type SettleAiReservationInput,
  type SettleAiReservationResult,
} from "./helpers/ai-usage-settle";
export {
  AWAITING_POSTING_INTENT,
  INVENTORY_SETTINGS_LOCK_NAMESPACE,
  linkEffectsToPostingIntent,
  readSaleEffectsActivation,
  writeReturnEffects,
  writeSaleLineEffects,
  writeVoidEffects,
  type LinkEffectsInput,
  type ReturnEffectsInput,
  type SaleEffectsInput,
  type SaleEffectsOutcome,
  type SkippedEffectLine,
  type VoidEffectsInput,
} from "./helpers/inventory-effects/sale-effects";
export {
  activateSaleEffects,
  compareAnchorsToBin,
  type ActivateSaleEffectsInput,
  type ActivationOutcome,
  type ActivationRefusal,
  type ActivationRefusalCode,
  type AnchorComparisonRow,
  type AnchoredStore,
} from "./helpers/inventory-effects/activation";
export {
  buildCutoverEquivalenceReport,
  isStorePendingAware,
  readPendingAwarePositions,
  type CutoverEquivalenceRow,
  type PendingAwarePosition,
} from "./helpers/inventory-effects/pending-aware";
export {
  decideEffectLine,
  returnLineEffectKey,
  saleLineEffectKey,
  SKIPPED_EFFECT_REASONS,
  voidEffectKey,
  type EffectLineDecision,
  type EffectLineFacts,
  type SaleEffectEvent,
  type SkippedEffectReason,
} from "./helpers/inventory-effects/effect-lines";
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
