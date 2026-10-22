/**
 * Metric-label cardinality guard — Track B / P4 / T461.
 *
 * Implements the closed-allowlist + forbidden-deny-list discipline named
 * by `docs/observability/p4-redaction-cardinality-plan.md` §10 and
 * `docs/observability/signals.md` §6.
 *
 * Why this lives in `packages/shared`:
 *   - Track B's later API instrumentation slice (T470/T471) and the worker
 *     slice (T472) MUST share a single source of truth for which label
 *     keys are permitted on which signal.
 *   - Both processes register metrics; both must enforce the same rule.
 *   - Placing the registry here lets the metric-registration helpers in
 *     either process call `assertLabelKeys(...)` at registration time
 *     AND lets the test suites import the same data structure for static
 *     drift checks.
 *
 * What this file does NOT do:
 *   - Register any metric.
 *   - Start any OTel SDK.
 *   - Touch pino, BullMQ, or Redis.
 *
 * It is a pure data + validator module — zero side effects, no I/O.
 */

/**
 * Labels that MUST NEVER appear on any signal (FR-B-006, signals.md §6).
 *
 * Unbounded-cardinality keys (tenant/store/user/actor IDs) live in
 * STRUCTURED LOGS and TRACE ATTRIBUTES, not in metrics. The matrix
 * (`.specify/memory/redaction-matrix.md` §3.4) keeps them safe as log
 * fields; this set keeps them out of the metrics surface.
 *
 * The set is intentionally narrow — the **allowlist** (`ALLOWED_METRIC_LABELS`
 * below) is the primary control. The deny set is a tripwire for the four
 * most-common high-cardinality offenders we expect future contributors to
 * reach for, and for PII-suspect substitutes that an allowlist alone
 * could miss.
 */
export const FORBIDDEN_METRIC_LABELS: ReadonlySet<string> = new Set([
  // Mandatory-forbidden (FR-B-006, plan §11):
  "tenant_id",
  "tenantId",
  "store_id",
  "storeId",
  "user_id",
  "userId",
  "actor_id",
  "actorId",
  // PII-adjacent (matrix §3.2):
  "email",
  "phone",
  "name",
  "full_name",
  "fullName",
  "address",
  "ip_address",
  "ipAddress",
  // Credential-adjacent (matrix §3.1):
  "password",
  "token",
  "access_token",
  "refresh_token",
  "session_token",
  "api_key",
  "apiKey",
  "secret",
  "idempotency_key",
  "idempotencyKey",
  // Unbounded raw values (signals.md §6):
  "query",
  "query_text",
  "query_params",
  "error_message",
  "errorMessage",
  "field_name",
  "fieldName",
  "path", // rendered URL path; use `route` template instead
  "url",
  // Per-message identifiers — unbounded:
  "request_id",
  "requestId",
  "correlation_id",
  "correlationId",
  "trace_id",
  "traceId",
  "span_id",
  "spanId",
  "event_id",
  "eventId",
  "job_id",
  "jobId",
]);

/**
 * Closed allowlist: signal name → permitted label keys.
 *
 * Adding a metric MUST add an entry here. Adding a label to an existing
 * metric MUST update the entry. Two-step gate:
 *   1. The metric-registration helper calls `assertLabelKeys(name, keys)`.
 *      A missing entry or an unknown key throws.
 *   2. The cardinality test (`apps/api/test/observability/cardinality.spec.ts`)
 *      asserts every entry's value set is disjoint from
 *      `FORBIDDEN_METRIC_LABELS`. Drift in either direction fails CI.
 *
 * Entries here mirror `docs/observability/signals.md` §1, §2, §3.
 * They are documented (not yet emitted) — Track B P4 emission slices land
 * separately per the gating discipline in
 * `specs/004-platform-production-readiness/tasks.md`.
 */
export const ALLOWED_METRIC_LABELS: Readonly<Record<string, readonly string[]>> = {
  // ---- API signals (signals.md §1) ----
  http_request_count: ["route", "method", "status_class"],
  http_request_duration_seconds: ["route", "method"],
  http_error_4xx_total: ["route", "status"],
  http_error_5xx_total: ["route", "status"],
  auth_failure_total: ["cause"],
  tenant_context_failure_total: ["reason"],
  validation_failure_total: ["route"],
  suspicious_login_total: ["reason"],
  cross_tenant_rejection_total: ["route"],
  idempotency_replay_total: ["route"],
  idempotency_conflict_total: ["route"],
  idempotency_in_progress_total: ["route"],
  // ---- DB signals (signals.md §2) ----
  db_pool_in_use: [],
  db_pool_waiters: [],
  db_slow_query_total: ["query_class"],
  db_rls_context_failure_total: [],
  db_migration_status: ["state"],
  // ---- Redis / BullMQ / Worker (signals.md §3) ----
  redis_command_duration_seconds: ["command"],
  queue_lag_seconds: ["queue"],
  queue_failed_total: ["queue", "error_class"],
  queue_dead_letter_total: ["queue"],
  queue_retry_total: ["queue"],
  worker_job_duration_seconds: ["job_name"],
  worker_processing_failure_total: ["job_name", "error_class"],
  // ---- Track C outbox (signals.md §3.4) — registered, not emitted yet ----
  outbox_pending_total: ["event_type"],
  outbox_dead_letter_total: ["event_type"],
  outbox_drain_duration_seconds: ["event_type"],
  // ---- Catalog domain — 005 Wave 1 (signals.md §1.1) ----
  // Schema-only registration; emission lands in 005-WAVE1-SETUP (T501) and
  // 005-WAVE1-METRICS (T552/T553). `action` is bounded to the closed set
  // {linked, created, dismissed}; Wave 1 only emits `dismissed`. Wave 2
  // (link, create-new) will exercise the remaining two values.
  unknown_item_captured_total: [],
  unknown_item_resolved_total: ["action"],
  idempotency_token_mismatch_total: [],
  // ---- Catalog domain — 005 Wave 2 (signals.md §1.1; 003 §9 canonical) ----
  // Unlabeled per 003 tasks.md §13.2 ("No values, names, or PII in labels")
  // and 005 FR-043. The acting principal + correlation id called for by
  // FR-043 are carried by the `unknown_item.reconciliation_conflict_rejected`
  // AUDIT event (already live, T645), NOT by metric labels — principal/
  // correlation are high-cardinality / PII-adjacent and forbidden here (FR-B-006).
  // Emission lands in 005-WAVE2-METRICS (T651) at the conflict catch site.
  catalog_duplicate_alias_conflict_total: [],
  // ---- Inventory domain — 009-SIGNAL-NEGBAL (plan §3.3, FR-024) ----
  // A NEW signal (consciously introduced; NOT in the constitution §VII named
  // list — see 009 execution-map header). Increments when an outbound movement
  // (manual outbound / transfer_out / sale-linked backfill) drives a
  // (tenant, store, product) on-hand below zero under the allow-and-flag policy.
  // UNLABELED — the (tenant, store, product) it happened to is high-cardinality
  // / PII-adjacent and lives on the movement + audit rows, NOT here (the catalog
  // "domain-keyed, not attribute-keyed" precedent). Never a tenant/store label.
  inventory_negative_balance_total: [],

  // 010-US1-SNAPSHOT read-down (R6 / FR-070). Products excluded from the
  // sellable stream for a price-related reason (missing price / missing
  // currency / non-representable in the currency minor unit). UNLABELED — the
  // excluded product is recorded on the reconciliation backlog, NOT here (no
  // product/price/PII labels; same domain-keyed precedent as the catalog set).
  catalog_unpriced_issue_rate: [],

  // ---- ERPNext posting domain — 015-POLISH (spec §VII / plan §3.x) ----
  // A NEW signal (consciously introduced; NOT in the constitution §VII named
  // list — same posture as the 009/010 domain signals). Increments when an
  // erpnext_posting_status row becomes `permanently_rejected` — the
  // reconciliation / dead-letter flag the 017 surface drains. Both emit sites
  // (the connectorAckOutcome ack on the api side, and the worker
  // PostingRequestedConsumer 015-RESOLVE rejection at row creation) register the
  // SAME family name in their respective shared metrics module. UNLABELED — the
  // (tenant, store, sale, rejection_category) it happened to is high-cardinality
  // / business-sensitive and lives on the erpnext_posting_status row + audit,
  // NOT here (the 009/010 domain-keyed-not-attribute-keyed precedent).
  erpnext_posting_reconciliation_total: [],

  // ---- ERPNext reconciliation/repair domain — 017-POLISH (spec §VII) ----
  // Increments on every operator repair action recorded by 017 (a posting
  // re-offer OR a stock re-map/re-sync) — the REPAIR side of run -> report ->
  // repair. UNLABELED — the affected (tenant, store, target, outcome) lives on
  // the erpnext_reconciliation_repair_attempt row + audit_events, NOT metric
  // labels (the 009/010/015 domain-keyed-not-attribute-keyed precedent).
  erpnext_reconciliation_repair_total: [],

  // ---- ERPNext stock reconciliation sweep — RT-179 ----
  // Increments once per (tenant, store) the scheduled worker sweep considers:
  // `outcome` is the closed set {created, skipped_running, skipped_period,
  // skipped_ineligible} (a run was created; the store already had a running
  // stock run; a scheduled run already exists for this period; the tenant was
  // suspended or the store/stock map retired between listing and creation).
  // The (tenant, store) itself lives on
  // the run row + the sweep's structured log, NOT a metric label.
  erpnext_stock_reconciliation_sweep_total: ["outcome"],

  // ---- ERPNext stock run expiry — RT-688 (RT-187 D4/D5) ----
  // Gauge: `kind='stock'` runs still `running` past the 2 h run TTL, sampled
  // by the scheduled sweep. `outcome` is the closed set {report_incomplete,
  // report_complete}: the first is what the expiry fails (so it reads zero
  // after a healthy sweep); the second is never expired and points at a
  // reconciliation worker that did not process a completed report.
  erpnext_stock_run_stranded: ["outcome"],
  // Counter: stock runs the sweep moved `running → failed` past the TTL.
  // UNLABELED — the (tenant, store, run) lives on the run row, its audit row
  // and the sweep log, NOT metric labels.
  erpnext_stock_run_expired_total: [],

  // ---- ERPNext posting reversal dead-letter — RT-207 ----
  // Increments once when an `erpnext.posting.requested` reversal dead-letters in
  // the outbox while still awaiting its sale's `sale_post` posting row (the
  // RT-173 deferral ran out of attempts). The dead-lettered outbox row is the
  // record of truth; this counter is what operations alert on. UNLABELED — the
  // (tenant, sale, outbox event) lives on the outbox row + the worker's
  // structured `posting.reversal.dead_lettered` error log, NOT metric labels.
  erpnext_posting_reversal_deferred_dead_letter_total: [],

  // ---- Sale re-drive sweep — RT-457 ----
  // Adds the number of items the scheduled sweep recovered per tick: `reason`
  // is the closed set {sale_processing, sale_post_intent, reversal_intent}
  // (a stranded unprocessed sale was processed; a missing sale_post /
  // reversal erpnext.posting.requested event was re-emitted). The (tenant,
  // sale) lives in the sweep's structured log, NOT a metric label.
  sale_redrive_total: ["reason"],

  // ---- Sale / void / return Inventory Effects — RT-427 (owner decision 2) ----
  // Increments once per business line whose effect could not be written
  // exactly and was skipped instead of stalling the sale: `event_type` is the
  // closed set {sale, sale_void, sale_return}, `reason` the closed set
  // {unit_mismatch, quantity_precision, tracked_product}. Emitted by the
  // worker (sale) and the API (void, return). The (tenant, sale, line) lives
  // in the `inventory.sale_effect.skipped` warn log, NOT metric labels.
  inventory_sale_effect_skipped_total: ["event_type", "reason"],

  // ---- Connector boundary lifecycle — 018-POLISH (spec §FR-022a) ----
  // Increments on every connector credential/registration lifecycle action
  // (register / issue / rotate / revoke / disable) — operational visibility for
  // the pilot boundary. UNLABELED — the (tenant, instance, credential, actor)
  // lives on connector_registration / auth_tokens + audit_events, NOT metric
  // labels (the 009/010/015/017 domain-keyed-not-attribute-keyed precedent; a
  // per-instance/tenant label would be a cardinality + §XIV hazard).
  connector_lifecycle_total: [],

  // ---- Connector health — 020-POLISH (spec FR-018) ----
  // Increments on every ACCEPTED connector heartbeat (020-US2). Operational
  // visibility into how often connectors report liveness. UNLABELED — the
  // (tenant, instance) it came from is high-cardinality / §XIV-adjacent and
  // lives on connector_health + the 018 connector_registration, NOT here. A
  // per-instance/tenant/secret label would be a cardinality + §XIV hazard (the
  // 009/010/015/017/018 domain-keyed-not-attribute-keyed precedent).
  connector_heartbeat_total: [],

  // ---- POS device heartbeat — RT-327 (AD-DEVICE-001 D-1) ----
  // Increments once per POS heartbeat that reaches the store step: `outcome`
  // is the closed set {stored, throttled, refused}. `stored` wrote the device's
  // row, `throttled` fell inside the 60-second window and wrote nothing,
  // `refused` is a store that failed (counted and swallowed: the terminal still
  // gets its 200). NEVER a version, channel, device or tenant label: those are
  // on `device_health` and are a cardinality + §XIV hazard.
  pos_device_heartbeat_total: ["outcome"],

  // ---- POS build identity report — RT-719 ----
  // Increments once per build identity store that took effect on a reporting
  // operation: `outcome` is the closed set {recorded, unknown, failed}.
  // `recorded` stored a valid commit, `unknown` cleared the identity (no valid
  // commit), `failed` is a store that failed (counted and swallowed). NEVER a
  // commit, version, pin, device or tenant label: those are on `devices` and a
  // cardinality + §XIV hazard.
  pos_build_identity_report_total: ["outcome"],

  // ---- ERPNext product-master reconciliation/repair — 021-POLISH (spec §VII) ----
  // Increments on every operator repair action recorded by 021 (a backlog-item
  // confirm/suggest_confirm or a run-result re_point that drives 013's lifecycle)
  // AND on each persisted run completion outcome. UNLABELED — the affected
  // (tenant, product, item, outcome) lives on the
  // erpnext_product_reconciliation_repair_attempt / _result rows + audit_events,
  // NOT metric labels (the 009/010/015/017/018/020 domain-keyed-not-attribute-keyed
  // precedent; a per-tenant/product label would be a cardinality + §XIV hazard).
  erpnext_product_reconciliation_total: [],
  // Settlement & receivables domain — 035 T034 (spec section 7). UNLABELED — the
  // (tenant, store, payer, receivable, outcome) lives on the receivable /
  // payment_application / claim / remittance / reconciliation_result rows +
  // audit_events, NOT metric labels (the 009/010/015/017/018/020/021
  // domain-keyed-not-attribute-keyed precedent; a per-tenant/payer label would be
  // a cardinality + PII hazard).
  settlement_receivable_total: [],

  // ---- POS shift close approver — RT-17 follow-up (Jira RT-17 10955, option A) ----
  // Increments once when a shift close is FIRST recorded with a
  // `varianceApprovedByUserId` that fails the ingest standing check (the close
  // is still recorded; never refused). `reason` is the closed set
  // {approver_is_closer, inactive_membership, not_manager, no_store_access,
  // check_unavailable}. The tenant, store, shift and users are never labels.
  shift_close_approver_unverified_total: ["reason"],

  // ---- Console rate limiting — RT-619 (RT-574 D6) ----
  // One count per console request the guard evaluates (report / enforce only).
  // `class` ∈ {cheapRead, expensiveRead, write, jobOrPreview, onboarding,
  // incidentControl, exempt}; `outcome` ∈ {allowed, near_limit, would_limit,
  // limited, fail_open}; `route` is the bounded route template (same label as
  // http_error_4xx_total). Never a user, tenant or IP value.
  console_rate_limit_total: ["class", "outcome", "route"],
  // Histogram of count / limit per check; same bounded labels minus outcome.
  console_rate_limit_utilisation: ["class", "route"],

  // ---- AI gateway — RT-655 (RT-643 F-2, AD-AI-PROV-001 E-5/E-8) ----
  // One count per `AiGateway.run`. `feature` is a code-owned feature id (an
  // unregistered id is labelled `unknown`, never echoed); `outcome` is `ok` or
  // one member of the closed AI_FALLBACK_REASONS set. Per-tenant / per-store /
  // per-user attribution is NEVER a label (FR-B-006): it belongs to the
  // persisted usage ledger owned by RT-663, which this signal does not replace.
  ai_gateway_run_total: ["feature", "outcome"],
  // One count per provider request actually sent. `provider` and `route` come
  // from the static route allowlist (code-owned); `outcome` is the ModelResult
  // kind or `unavailable_<cause>` (closed). No model id, token count or cost.
  ai_gateway_provider_call_total: ["provider", "route", "outcome"],
};

/**
 * Reason returned when label validation fails. The discriminated union lets
 * callers (and tests) assert on the specific failure mode rather than
 * pattern-matching message strings.
 */
export type LabelValidationError =
  | { kind: "unknown_metric"; metric: string }
  | { kind: "forbidden_label"; metric: string; label: string }
  | { kind: "unallowed_label"; metric: string; label: string; allowed: readonly string[] };

/**
 * Validate that `labels` is acceptable for `metric` under the closed
 * allowlist. Returns `null` on success, or the specific failure shape on
 * rejection. Pure function — does not throw, does not mutate, does not
 * touch global state.
 *
 * Two failure modes:
 *   1. `unknown_metric` — `metric` is not registered in `ALLOWED_METRIC_LABELS`.
 *      The reviewer must add an entry there before instrumentation can
 *      register a new signal.
 *   2. `forbidden_label` / `unallowed_label` — a label key is either in
 *      `FORBIDDEN_METRIC_LABELS` (a hard tripwire) or not in the metric's
 *      allowed-labels list.
 *
 * The forbidden check fires BEFORE the allowed check so reviewers see the
 * highest-severity reason (a `tenant_id` slip would otherwise be reported
 * as "unallowed" when it's specifically forbidden — much less useful).
 */
export function validateMetricLabels(
  metric: string,
  labels: readonly string[],
): LabelValidationError | null {
  const allowed = ALLOWED_METRIC_LABELS[metric];
  if (!allowed) {
    return { kind: "unknown_metric", metric };
  }
  for (const label of labels) {
    if (FORBIDDEN_METRIC_LABELS.has(label)) {
      return { kind: "forbidden_label", metric, label };
    }
  }
  for (const label of labels) {
    if (!allowed.includes(label)) {
      return { kind: "unallowed_label", metric, label, allowed };
    }
  }
  return null;
}

/**
 * Strict variant — throws on failure. The future metric-registration
 * helper (Lane A / T470, T471 and Lane C / T472) MUST call this at
 * registration time so a forbidden label cannot reach a live SDK.
 */
export function assertMetricLabels(
  metric: string,
  labels: readonly string[],
): void {
  const err = validateMetricLabels(metric, labels);
  if (err === null) return;
  switch (err.kind) {
    case "unknown_metric":
      throw new Error(
        `Metric "${err.metric}" is not registered in ALLOWED_METRIC_LABELS. ` +
          `Add an entry to packages/shared/src/observability/metrics-labels.ts ` +
          `(and to docs/observability/signals.md) before registering it.`,
      );
    case "forbidden_label":
      throw new Error(
        `Metric "${err.metric}" rejects label "${err.label}": it is in ` +
          `FORBIDDEN_METRIC_LABELS (FR-B-006). High-cardinality / PII-adjacent ` +
          `keys belong in logs and traces, not in metric labels.`,
      );
    case "unallowed_label":
      throw new Error(
        `Metric "${err.metric}" rejects label "${err.label}": it is not in ` +
          `the allowlist [${err.allowed.join(", ")}]. Update ` +
          `ALLOWED_METRIC_LABELS if the label is appropriate, after a ` +
          `cardinality review (FR-B-012).`,
      );
  }
}
