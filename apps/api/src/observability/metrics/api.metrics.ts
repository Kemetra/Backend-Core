/**
 * API metric definitions — T470 / Track B / P4.
 *
 * Registers every API-layer signal from `docs/observability/signals.md` §1
 * with the OTel global Meter and exposes typed emission helpers.
 *
 * Label-policy enforcement (two layers):
 *   1. `assertMetricLabels` is called at module load for each signal.
 *      A forbidden or unregistered label throws immediately — it cannot
 *      reach a live SDK (FR-B-006, FR-B-012).
 *   2. Helper parameter types admit only the declared label keys. A call
 *      site cannot pass `tenant_id` because the helper's TypeScript
 *      signature excludes it (compile-time enforcement of FR-B-006).
 *
 * No DB or worker signals — those are T471 (DB) and T472 (worker).
 * Idempotency signals are Track D (T477) — not included here.
 *
 * Instruments are no-op until a MetricReader is registered (T470's future
 * `startOtel` extension with `metricsExporter`). Tests exercise the
 * helpers safely without a live SDK.
 *
 * Constitution §VII / FR-B-001 / FR-B-006 / FR-B-012.
 */
import {
  assertMetricLabels,
  getMeter,
  type Attributes,
  type Counter,
  type Histogram,
} from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Bounded cause / reason enums (signals.md §1)
// ---------------------------------------------------------------------------
// Values are outcome-derived — never credential-derived. No email, password,
// token, tenant_id, or user_id may appear here (FR-B-006 + redaction matrix).

/** Five bounded auth-failure causes. All are safe metric label values. */
export const AUTH_FAILURE_CAUSES = [
  "bad_password",
  "bad_token",
  "expired",
  "missing",
  "rate_limited",
] as const satisfies readonly string[];
export type AuthFailureCause = (typeof AUTH_FAILURE_CAUSES)[number];

/** Three bounded tenant-context failure reasons. */
export const TENANT_CONTEXT_FAILURE_REASONS = [
  "missing",
  "invalid",
  "cross_tenant",
] as const satisfies readonly string[];
export type TenantContextFailureReason = (typeof TENANT_CONTEXT_FAILURE_REASONS)[number];

/** Three bounded suspicious-login reasons. */
export const SUSPICIOUS_LOGIN_REASONS = [
  "rapid_retry",
  "geo_anomaly",
  "unknown_device",
] as const satisfies readonly string[];
export type SuspiciousLoginReason = (typeof SUSPICIOUS_LOGIN_REASONS)[number];

/** HTTP status classes used for request-count bucketing. */
export const HTTP_STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const satisfies readonly string[];
export type HttpStatusClass = (typeof HTTP_STATUS_CLASSES)[number];

/**
 * Bounded terminal-state actions for `unknown_item_resolved_total`.
 *
 * Owner: 005 spec §6 (FR-002 resolution states). Cardinality is closed at
 * three values; any expansion requires an FR change. Wave 1 emits only
 * `dismissed`; `linked` and `created` land in Wave 2 (blocked on 003
 * PHASE3_RED_WAVE — see specs/005-pos-catalog-sync-reconciliation/plan.md §4).
 *
 * Cardinality review (FR-B-012): closed set, not forbidden, not PII-adjacent.
 */
export const UNKNOWN_ITEM_RESOLVED_ACTIONS = [
  "linked",
  "created",
  "dismissed",
] as const satisfies readonly string[];
export type UnknownItemResolvedAction = (typeof UNKNOWN_ITEM_RESOLVED_ACTIONS)[number];

/**
 * Bounded reasons for `shift_close_approver_unverified_total` (RT-17
 * follow-up, Jira RT-17 comment 10955 option A). Why the approver of a
 * recorded shift close could not be verified at ingest; the close is
 * recorded regardless. Closed set: never an id, a role code from the
 * database, or an error message.
 */
export const SHIFT_CLOSE_APPROVER_UNVERIFIED_REASONS = [
  "approver_is_closer",
  "inactive_membership",
  "not_manager",
  "no_store_access",
  "check_unavailable",
] as const satisfies readonly string[];
export type ShiftCloseApproverUnverifiedReason = (typeof SHIFT_CLOSE_APPROVER_UNVERIFIED_REASONS)[number];

// ---------------------------------------------------------------------------
// Module-load label-policy validation
// ---------------------------------------------------------------------------
// assertMetricLabels throws if a label is forbidden or not in the closed
// allowlist (ALLOWED_METRIC_LABELS in packages/shared). Called once at
// registration time; cannot be deferred to emit time.

assertMetricLabels("http_request_count", ["route", "method", "status_class"]);
assertMetricLabels("http_request_duration_seconds", ["route", "method"]);
assertMetricLabels("http_error_4xx_total", ["route", "status"]);
assertMetricLabels("http_error_5xx_total", ["route", "status"]);
assertMetricLabels("auth_failure_total", ["cause"]);
assertMetricLabels("tenant_context_failure_total", ["reason"]);
assertMetricLabels("validation_failure_total", ["route"]);
assertMetricLabels("suspicious_login_total", ["reason"]);
assertMetricLabels("cross_tenant_rejection_total", ["route"]);
assertMetricLabels("idempotency_replay_total", ["route"]);
assertMetricLabels("idempotency_conflict_total", ["route"]);
assertMetricLabels("idempotency_in_progress_total", ["route"]);
// Catalog domain — 005 Wave 1 (signals.md §1.1; registry CATALOG_METRIC_NAMES below)
assertMetricLabels("unknown_item_captured_total", []);
assertMetricLabels("unknown_item_resolved_total", ["action"]);
assertMetricLabels("idempotency_token_mismatch_total", []);
// Catalog domain — 005 Wave 2 (signals.md §1.1; allowlist via 005-WAVE2-METRICS-ALLOWLIST)
assertMetricLabels("catalog_duplicate_alias_conflict_total", []);
// Inventory domain — 009-SIGNAL-NEGBAL (plan §3.3, FR-024). UNLABELED.
assertMetricLabels("inventory_negative_balance_total", []);
// Catalog domain — 010-US1-SNAPSHOT (read-down R6, FR-070). UNLABELED — no
// product/price/PII in labels; the excluded product is on the reconciliation
// backlog, not the metric.
assertMetricLabels("catalog_unpriced_issue_rate", []);
// ERPNext posting domain — 015-POLISH (spec §VII). UNLABELED — the
// (tenant, store, sale, category) lives on the erpnext_posting_status row +
// audit, not metric labels (009/010 domain-keyed precedent).
assertMetricLabels("erpnext_posting_reconciliation_total", []);
// ERPNext reconciliation/repair domain — 017-POLISH (spec §VII). UNLABELED — the
// (tenant, store, target, outcome) lives on the repair_attempt row + audit_events.
assertMetricLabels("erpnext_reconciliation_repair_total", []);
// Connector boundary lifecycle — 018-POLISH (spec §FR-022a). UNLABELED — the
// (tenant, instance, credential, actor) lives on connector_registration /
// auth_tokens + audit_events, not metric labels.
assertMetricLabels("connector_lifecycle_total", []);
// Connector health — 020-POLISH (spec FR-018). UNLABELED — the (tenant,
// instance) lives on connector_health + connector_registration, not labels.
assertMetricLabels("connector_heartbeat_total", []);
// ERPNext product-master reconciliation/repair — 021-POLISH (spec §VII). UNLABELED
// — the (tenant, product, item, outcome) lives on the
// erpnext_product_reconciliation_repair_attempt / _result rows + audit_events.
assertMetricLabels("erpnext_product_reconciliation_total", []);
// Settlement & receivables domain — 035 T034 (spec §7). UNLABELED — the
// (tenant, store, payer, receivable, outcome) lives on the receivable /
// payment_application / claim / remittance / reconciliation_result rows +
// audit_events, not metric labels (the 009/010/015/017/018/020/021 precedent).
assertMetricLabels("settlement_receivable_total", []);
// POS shift close approver — RT-17 follow-up (10955 option A). `reason` is the
// closed SHIFT_CLOSE_APPROVER_UNVERIFIED_REASONS set; no tenant/store/user label.
assertMetricLabels("shift_close_approver_unverified_total", ["reason"]);

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

const meter = getMeter("api");

const _httpRequestCount: Counter = meter.createCounter("http_request_count", {
  description: "Total API requests by route, method, and status class.",
});
const _httpRequestDuration: Histogram = meter.createHistogram(
  "http_request_duration_seconds",
  {
    description: "API request duration in seconds by route and method.",
    unit: "s",
  },
);
const _httpError4xx: Counter = meter.createCounter("http_error_4xx_total", {
  description: "Total 4xx error responses by route and status code.",
});
const _httpError5xx: Counter = meter.createCounter("http_error_5xx_total", {
  description: "Total 5xx error responses by route and status code.",
});
const _authFailure: Counter = meter.createCounter("auth_failure_total", {
  description: "Authentication failures by cause.",
});
const _tenantContextFailure: Counter = meter.createCounter(
  "tenant_context_failure_total",
  { description: "Tenant context resolution failures by reason." },
);
const _validationFailure: Counter = meter.createCounter("validation_failure_total", {
  description: "Request validation failures by route.",
});
const _suspiciousLogin: Counter = meter.createCounter("suspicious_login_total", {
  description: "Suspicious login attempts by reason.",
});
const _crossTenantRejection: Counter = meter.createCounter(
  "cross_tenant_rejection_total",
  { description: "Cross-tenant access rejections by route." },
);
const _idempotencyReplay: Counter = meter.createCounter(
  "idempotency_replay_total",
  { description: "Idempotent replay responses by route." },
);
const _idempotencyConflict: Counter = meter.createCounter(
  "idempotency_conflict_total",
  { description: "Idempotency key conflicts (409) by route." },
);
const _idempotencyInProgress: Counter = meter.createCounter(
  "idempotency_in_progress_total",
  { description: "In-flight idempotency collisions (425) by route." },
);
// Catalog domain — 005 Wave 1 (signals.md §1.1)
const _unknownItemCaptured: Counter = meter.createCounter(
  "unknown_item_captured_total",
  { description: "Successful POS captures of an unknown item into the unknown_items review queue." },
);
const _unknownItemResolved: Counter = meter.createCounter(
  "unknown_item_resolved_total",
  {
    description:
      "Terminal-state transitions out of unknown_items.resolution_status='pending'. Labels: action ∈ {linked, created, dismissed}. Wave 1 emits only `dismissed`.",
  },
);
const _idempotencyTokenMismatch: Counter = meter.createCounter(
  "idempotency_token_mismatch_total",
  {
    description:
      "Catalog-domain idempotency-key replay with mismatched payload (FR-021c). Co-increments with platform idempotency_conflict_total{route} on the catalog capture route.",
  },
);
const _catalogDuplicateAliasConflict: Counter = meter.createCounter(
  "catalog_duplicate_alias_conflict_total",
  {
    description:
      "Reconciliation rejections caused by an alias unique-index violation (005 FR-043 / 003 §9). Increments on the link and create-new conflict paths. Unlabeled — principal/correlation attribution is on the reconciliation_conflict_rejected audit event, not metric labels.",
  },
);

const _inventoryNegativeBalance: Counter = meter.createCounter(
  "inventory_negative_balance_total",
  {
    description:
      "Outbound movements (manual outbound / transfer_out / sale-linked backfill) that drove a (tenant, store, product) on-hand below zero under the allow-and-flag policy (009 FR-024). Unlabeled — the affected key is high-cardinality / PII-adjacent and lives on the movement + audit rows, not metric labels.",
  },
);

const _catalogUnpricedIssue: Counter = meter.createCounter(
  "catalog_unpriced_issue_rate",
  {
    description:
      "Products excluded from the read-down sellable stream because the resolved price is missing / has no currency / is non-representable in the currency minor unit (010 R5/R6, FR-041/044). Unlabeled — the excluded product is recorded on the reconciliation backlog, not in metric labels (no product/price/PII).",
  },
);

const _erpnextReconciliationRepair: Counter = meter.createCounter(
  "erpnext_reconciliation_repair_total",
  {
    description:
      "Operator repair actions recorded by 017 (a posting re-offer OR a stock re-map/re-sync) — the REPAIR side of run -> report -> repair (017 spec §VII). Emitted by repairPosting + repairStock. Unlabeled — the (tenant, store, target, outcome) lives on the erpnext_reconciliation_repair_attempt row + audit_events, not metric labels.",
  },
);

const _erpnextPostingReconciliation: Counter = meter.createCounter(
  "erpnext_posting_reconciliation_total",
  {
    description:
      "ERPNext posting rows that became permanently_rejected — the reconciliation / dead-letter flag the 017 surface drains (015 spec §VII). Emitted by connectorAckOutcome on a permanently_rejected / retry-budget-exhausted ack. Unlabeled — the (tenant, store, sale, category) lives on the erpnext_posting_status row + audit, not metric labels.",
  },
);

const _connectorLifecycle: Counter = meter.createCounter(
  "connector_lifecycle_total",
  {
    description:
      "Connector credential/registration lifecycle actions (register / issue / rotate / revoke / disable) — operational visibility for the 018 pilot boundary. Unlabeled — the (tenant, instance, credential, actor) lives on connector_registration / auth_tokens + audit_events, not metric labels.",
  },
);

const _connectorHeartbeat: Counter = meter.createCounter(
  "connector_heartbeat_total",
  {
    description:
      "Accepted connector liveness heartbeats (020-US2 / spec FR-018). Operational visibility into how often connectors report in. Unlabeled — the (tenant, instance) it came from lives on connector_health + the 018 connector_registration, not metric labels (the 009/010/015/017/018 domain-keyed-not-attribute-keyed precedent; a per-instance/tenant label would be a cardinality + §XIV hazard).",
  },
);

const _erpnextProductReconciliation: Counter = meter.createCounter(
  "erpnext_product_reconciliation_total",
  {
    description:
      "Operator repair actions + run-completion outcomes recorded by 021 product-master reconciliation (a backlog-item confirm/suggest_confirm or run-result re_point driving 013's lifecycle, and a completed two-sided run) — the run -> report -> repair surface (021 spec §VII). Emitted by repairBacklogItem / repairResult + the run processor. Unlabeled — the (tenant, product, item, outcome) lives on the erpnext_product_reconciliation_repair_attempt / _result rows + audit_events, not metric labels.",
  },
);
const _settlementReceivable: Counter = meter.createCounter(
  "settlement_receivable_total",
  {
    description:
      "Settlement & receivables lifecycle events recorded by 035 (a receivable opened from a POS settlement intent, a cash application, a claim submission, or a remittance reconciliation) — the open -> apply -> claim -> reconcile surface (035 spec §7). Emitted by ReceivableService / ClaimService. Unlabeled — the (tenant, store, payer, receivable, outcome) lives on the receivable / payment_application / claim / remittance / reconciliation_result rows + audit_events, not metric labels.",
  },
);

const _shiftCloseApproverUnverified: Counter = meter.createCounter(
  "shift_close_approver_unverified_total",
  {
    description:
      "Shift closes first recorded with a variance approver that failed the ingest standing check (RT-17 10955 option A): the approver is the closer, has no active membership, holds no owner / tenant_admin / store_manager role, has no access to the store, or the check could not run. The close is recorded regardless (never refused). Labeled by the closed `reason` set only — the tenant, store, shift and users are on the shift_closes row, not metric labels.",
  },
);

// ---------------------------------------------------------------------------
// Attribute types — TypeScript compile-time label enforcement (FR-B-006)
// ---------------------------------------------------------------------------
// Each type admits ONLY the allowed label keys for its signal. A call site
// that adds `tenant_id` or any forbidden key won't compile.

export interface HttpRequestAttrs {
  route: string;
  method: string;
  status_class: HttpStatusClass;
}

export interface HttpDurationAttrs {
  route: string;
  method: string;
}

export interface HttpErrorAttrs {
  route: string;
  status: string;
}

export interface AuthFailureAttrs {
  cause: AuthFailureCause;
}

export interface TenantContextFailureAttrs {
  reason: TenantContextFailureReason;
}

export interface ValidationFailureAttrs {
  route: string;
}

export interface SuspiciousLoginAttrs {
  reason: SuspiciousLoginReason;
}

export interface CrossTenantRejectionAttrs {
  route: string;
}

export interface IdempotencyRouteAttrs {
  route: string;
}

/**
 * Attributes for `unknown_item_resolved_total`. The only catalog-domain
 * counter that carries a label — the bounded `action` discriminator.
 * `unknown_item_captured_total` and `idempotency_token_mismatch_total`
 * are unlabeled (domain-keyed, not route-keyed; see signals.md §1.1 Notes).
 */
export interface UnknownItemResolvedAttrs {
  action: UnknownItemResolvedAction;
}

/** Attributes for `shift_close_approver_unverified_total`: the closed `reason` only. */
export interface ShiftCloseApproverUnverifiedAttrs {
  reason: ShiftCloseApproverUnverifiedReason;
}

// ---------------------------------------------------------------------------
// Emission helpers
// ---------------------------------------------------------------------------

/** Increment the HTTP request counter. Called from the logging interceptor. */
export function recordHttpRequest(attrs: HttpRequestAttrs): void {
  _httpRequestCount.add(1, attrs as unknown as Attributes);
}

/**
 * Record an HTTP request duration observation (seconds).
 * Called from the logging interceptor alongside `recordHttpRequest`.
 */
export function recordHttpDuration(attrs: HttpDurationAttrs, durationSeconds: number): void {
  _httpRequestDuration.record(durationSeconds, attrs as unknown as Attributes);
}

/** Increment the 4xx error counter. Called from the exception filter. */
export function recordHttp4xxError(attrs: HttpErrorAttrs): void {
  _httpError4xx.add(1, attrs as unknown as Attributes);
}

/** Increment the 5xx error counter. Called from the exception filter. */
export function recordHttp5xxError(attrs: HttpErrorAttrs): void {
  _httpError5xx.add(1, attrs as unknown as Attributes);
}

/**
 * Increment auth_failure_total for the given cause.
 * Emission sites: auth.guard.ts (bad_token/expired/missing),
 * auth.service.ts (bad_password), rate-limit.ts (rate_limited).
 */
export function recordAuthFailure(attrs: AuthFailureAttrs): void {
  _authFailure.add(1, attrs as unknown as Attributes);
}

/**
 * Increment tenant_context_failure_total.
 * Emission site: tenant-context.guard.ts resolution failures.
 */
export function recordTenantContextFailure(attrs: TenantContextFailureAttrs): void {
  _tenantContextFailure.add(1, attrs as unknown as Attributes);
}

/**
 * Increment validation_failure_total.
 * Emission site: exception.filter.ts ZodError branch.
 * No field_class label — see signals.md §8 finding 2.
 */
export function recordValidationFailure(attrs: ValidationFailureAttrs): void {
  _validationFailure.add(1, attrs as unknown as Attributes);
}

/**
 * Increment suspicious_login_total.
 * Emission sites: auth.service.ts / rate-limit.ts detection paths.
 */
export function recordSuspiciousLogin(attrs: SuspiciousLoginAttrs): void {
  _suspiciousLogin.add(1, attrs as unknown as Attributes);
}

/**
 * Increment cross_tenant_rejection_total.
 * Emission site: tenant-context.guard.ts cross-tenant throw path (T475).
 */
export function recordCrossTenantRejection(attrs: CrossTenantRejectionAttrs): void {
  _crossTenantRejection.add(1, attrs as unknown as Attributes);
}

/**
 * Increment idempotency_replay_total.
 * Emission site: IdempotencyInterceptor replay short-circuit path.
 */
export function recordIdempotencyReplay(attrs: IdempotencyRouteAttrs): void {
  _idempotencyReplay.add(1, attrs as unknown as Attributes);
}

/**
 * Increment idempotency_conflict_total.
 * Emission site: IdempotencyInterceptor 409 conflict path.
 */
export function recordIdempotencyConflict(attrs: IdempotencyRouteAttrs): void {
  _idempotencyConflict.add(1, attrs as unknown as Attributes);
}

/**
 * Increment idempotency_in_progress_total.
 * Emission site: IdempotencyInterceptor 425 in-progress path.
 */
export function recordIdempotencyInProgress(attrs: IdempotencyRouteAttrs): void {
  _idempotencyInProgress.add(1, attrs as unknown as Attributes);
}

/**
 * Increment unknown_item_captured_total (005 FR-081).
 * Emission site: UnknownItemsService.captureUnknownItem success path
 * (lands in 005-WAVE1-CAPTURE-HAPPY / T511).
 */
export function recordUnknownItemCaptured(): void {
  _unknownItemCaptured.add(1);
}

/**
 * Increment unknown_item_resolved_total{action} (005 FR-081).
 * Emission sites (lands in subsequent Wave 1 / Wave 2 slices):
 *   - action="dismissed" → UnknownItemsService.dismissUnknownItem (T541, Wave 1)
 *   - action="linked"    → reconciliation link path (Wave 2)
 *   - action="created"   → reconciliation create-new path (Wave 2)
 */
export function recordUnknownItemResolved(attrs: UnknownItemResolvedAttrs): void {
  _unknownItemResolved.add(1, attrs as unknown as Attributes);
}

/**
 * Increment idempotency_token_mismatch_total (005 FR-021c, FR-082).
 * Emission site: IdempotencyInterceptor's collision branch
 * (`idempotency.interceptor.ts`), inline at the same site that fires
 * the platform-axis `recordIdempotencyConflict`. This is the final
 * shape after two prior approaches failed: an async exception filter
 * (PR #386 evidence) and a route-level RxJS interceptor (PR #389
 * evidence). Co-increments with the
 * platform-level recordIdempotencyConflict — both are intentional;
 * see signals.md §1.1 Notes.
 */
export function recordIdempotencyTokenMismatch(): void {
  _idempotencyTokenMismatch.add(1);
}

/**
 * Increment catalog_duplicate_alias_conflict_total (005 FR-043 / 003 §9).
 * Emission sites: ReconciliationService link + create-new paths, at the
 * post-transaction `alias_conflict` rejection discriminator (T651, Wave 2).
 * Unlabeled — see the instrument description.
 */
export function recordDuplicateAliasConflict(): void {
  _catalogDuplicateAliasConflict.add(1);
}

/**
 * Increment inventory_negative_balance_total (009 FR-024 / plan §3.3).
 * Emission site: InventoryService outbound write paths (createStockMovement,
 * createStockTransfer source leg, backfillSaleLinkedOutbound) when the post-
 * write derived on-hand for the affected (store, product) is below zero.
 * Unlabeled — the affected key is high-cardinality / PII-adjacent and lives on
 * the movement + audit rows, not here. Allow-and-flag: this is a SIGNAL, never
 * an error — emission MUST NOT alter or block the movement write.
 */
export function recordInventoryNegativeBalance(): void {
  _inventoryNegativeBalance.add(1);
}

/**
 * Increment catalog_unpriced_issue_rate (010 R6 / FR-070).
 * Emission site: ReadDownService snapshot/delta resolution, once per product
 * excluded from the sellable stream for a PRICE-related reason (missing price /
 * missing currency / non-representable). Unlabeled — the excluded product goes
 * to the reconciliation backlog, not metric labels. This is a SIGNAL on a
 * read path: emission MUST NOT alter the response (the row is simply absent).
 */
export function recordCatalogUnpricedIssue(): void {
  _catalogUnpricedIssue.add(1);
}

/**
 * Increment erpnext_posting_reconciliation_total (015-POLISH, spec §VII).
 * Emission site: ErpnextPostingService.ackOutcome, once per row that becomes
 * `permanently_rejected` (a connector permanently_rejected ack OR a
 * retry-budget-exhausted failed_transient). Unlabeled — the affected
 * (tenant, store, sale, category) is on the erpnext_posting_status row + audit,
 * not metric labels. A SIGNAL — emission MUST NOT alter the ack outcome.
 */
export function recordErpnextPostingReconciliation(): void {
  _erpnextPostingReconciliation.add(1);
}

/**
 * Increment erpnext_reconciliation_repair_total (017-POLISH, spec §VII).
 * Emission site: ErpnextReconciliationService.repairPosting + repairStock, once
 * per recorded repair action. Unlabeled — the (tenant, store, target, outcome)
 * is on the erpnext_reconciliation_repair_attempt row + audit_events, not metric
 * labels. A SIGNAL — emission MUST NOT alter the repair outcome.
 */
export function recordErpnextReconciliationRepair(): void {
  _erpnextReconciliationRepair.add(1);
}

/**
 * Increment connector_lifecycle_total (018-POLISH, spec §FR-022a).
 * Emission site: ConnectorRegistrationService register / issue / rotate /
 * revoke / disable, once per recorded lifecycle action. Unlabeled — the
 * (tenant, instance, credential, actor) is on connector_registration /
 * auth_tokens + audit_events, not metric labels. A SIGNAL — emission MUST NOT
 * alter the lifecycle outcome.
 */
export function recordConnectorLifecycle(): void {
  _connectorLifecycle.add(1);
}

/**
 * Increment connector_heartbeat_total (020-US2, spec FR-018).
 * Emission site: ConnectorHealthService.recordHeartbeat, once per ACCEPTED
 * heartbeat (after the 018 usability predicate passed at the guard). Unlabeled —
 * the (tenant, instance) it came from lives on connector_health + the 018
 * connector_registration, not metric labels. A SIGNAL — emission MUST NOT alter
 * the heartbeat outcome.
 */
export function recordConnectorHeartbeat(): void {
  _connectorHeartbeat.add(1);
}

/**
 * Increment erpnext_product_reconciliation_total (021-POLISH, spec §VII).
 * Emission sites: ErpnextProductReconciliationService.repairBacklogItem +
 * repairResult (per recorded repair) and the run processor (per completed run).
 * Unlabeled — the (tenant, product, item, outcome) is on the
 * erpnext_product_reconciliation_repair_attempt / _result rows + audit_events,
 * not metric labels. A SIGNAL — emission MUST NOT alter the repair/run outcome.
 */
export function recordErpnextProductReconciliation(): void {
  _erpnextProductReconciliation.add(1);
}

/**
 * Increment settlement_receivable_total (035 T034, spec §7).
 * Emission sites: ReceivableService.openFromIntent / applyPayment +
 * ClaimService.submitClaim / reconcileRemittance (per recorded lifecycle event).
 * Unlabeled — the (tenant, store, payer, receivable, outcome) is on the
 * receivable / payment_application / claim / remittance / reconciliation_result
 * rows + audit_events, not metric labels. A SIGNAL — emission MUST NOT alter the
 * settlement outcome.
 */
export function recordSettlementReceivable(): void {
  _settlementReceivable.add(1);
}

/**
 * Increment shift_close_approver_unverified_total{reason} (RT-17 follow-up,
 * Jira RT-17 comment 10955 option A).
 * Emission site: ShiftCashUpService.closeShift, once per FIRST record of a
 * close whose `varianceApprovedByUserId` fails the standing check (never on a
 * replay). A SIGNAL — emission MUST NOT alter or refuse the close.
 */
export function recordShiftCloseApproverUnverified(attrs: ShiftCloseApproverUnverifiedAttrs): void {
  _shiftCloseApproverUnverified.add(1, attrs as unknown as Attributes);
}

// ---------------------------------------------------------------------------
// Signal-name registry — used by T460 signal-presence tests
// ---------------------------------------------------------------------------

/**
 * Canonical names of all API signals registered by this module.
 * Tests import this to verify every signal is in ALLOWED_METRIC_LABELS and
 * obeys the label policy. Drift between this array and the actual instrument
 * creation above fails CI.
 */
export const API_METRIC_NAMES = [
  "http_request_count",
  "http_request_duration_seconds",
  "http_error_4xx_total",
  "http_error_5xx_total",
  "auth_failure_total",
  "tenant_context_failure_total",
  "validation_failure_total",
  "suspicious_login_total",
  "cross_tenant_rejection_total",
  "idempotency_replay_total",
  "idempotency_conflict_total",
  "idempotency_in_progress_total",
] as const satisfies readonly string[];

export type ApiMetricName = (typeof API_METRIC_NAMES)[number];

/**
 * Canonical names of catalog-domain signals registered by this module
 * for 005 Wave 1. Sibling of `API_METRIC_NAMES` (Track B platform signals)
 * and `DB_METRIC_NAMES` (in db.metrics.ts). The per-track registry pattern
 * keeps each spec's drift contract self-contained — extending this list
 * does NOT change `API_METRIC_NAMES`, which is locked at 12 entries
 * (nine base + three idempotency) per T444 cataloging.
 *
 * Owner: 005-pos-catalog-sync-reconciliation. See signals.md §1.1.
 */
export const CATALOG_METRIC_NAMES = [
  "unknown_item_captured_total",
  "unknown_item_resolved_total",
  "idempotency_token_mismatch_total",
  "catalog_duplicate_alias_conflict_total",
] as const satisfies readonly string[];

export type CatalogMetricName = (typeof CATALOG_METRIC_NAMES)[number];

/**
 * Canonical names of inventory-domain signals (009). Sibling registry of
 * API_METRIC_NAMES / CATALOG_METRIC_NAMES / DB_METRIC_NAMES — the per-track
 * pattern keeps each spec's drift contract self-contained (adding here does NOT
 * perturb the locked API_METRIC_NAMES count). Owner: 009-inventory-stock-ledger.
 */
export const INVENTORY_METRIC_NAMES = [
  "inventory_negative_balance_total",
] as const satisfies readonly string[];

export type InventoryMetricName = (typeof INVENTORY_METRIC_NAMES)[number];

/**
 * Canonical names of POS shift signals (RT-17). Sibling registry of the
 * per-track lists above; adding here does not perturb API_METRIC_NAMES.
 */
export const POS_SHIFTS_METRIC_NAMES = [
  "shift_close_approver_unverified_total",
] as const satisfies readonly string[];

export type PosShiftsMetricName = (typeof POS_SHIFTS_METRIC_NAMES)[number];
