/**
 * T461 — Metric-label cardinality static check.
 *
 * Drives the closed-allowlist + forbidden-deny-list discipline named by
 * `docs/observability/p4-redaction-cardinality-plan.md` §10 and
 * `docs/observability/signals.md` §6.
 *
 * Test responsibilities:
 *   1. Every entry in `ALLOWED_METRIC_LABELS` has label keys that are
 *      DISJOINT from `FORBIDDEN_METRIC_LABELS`. Drift in either direction
 *      (a forbidden label sneaking into an allowed list, or a duplicate
 *      entry) fails CI before any runtime registration can happen.
 *   2. Forbidden labels include the four mandatory-forbidden keys named
 *      in FR-B-006: `tenant_id`, `store_id`, `user_id`, `actor_id`.
 *   3. `validateMetricLabels` reports the correct discriminated-union
 *      reason for each failure mode (unknown metric, forbidden label,
 *      unallowed label). The strict `assertMetricLabels` variant throws
 *      with a message naming the offending metric and label.
 *
 * No OTel SDK boot, no Testcontainer, no Nest app — this is a pure-data
 * static check on the source-of-truth allowlist. The same allowlist is
 * the one future T470/T471/T472 emission slices will register against.
 */
import {
  ALLOWED_METRIC_LABELS,
  FORBIDDEN_METRIC_LABELS,
  assertMetricLabels,
  validateMetricLabels,
} from "@data-pulse-2/shared";

describe("metrics-labels — closed allowlist invariants", () => {
  it("every catalogued signal has a label entry (even if the array is empty)", () => {
    // The allowlist must be exhaustive. An empty array means "no labels"
    // (e.g., `db_rls_context_failure_total`); missing the key entirely is
    // a defect.
    for (const [metric, labels] of Object.entries(ALLOWED_METRIC_LABELS)) {
      expect(metric).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(Array.isArray(labels)).toBe(true);
    }
  });

  it("no allowed label is also in FORBIDDEN_METRIC_LABELS", () => {
    const offenders: Array<{ metric: string; label: string }> = [];
    for (const [metric, labels] of Object.entries(ALLOWED_METRIC_LABELS)) {
      for (const label of labels) {
        if (FORBIDDEN_METRIC_LABELS.has(label)) {
          offenders.push({ metric, label });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("FORBIDDEN_METRIC_LABELS includes the four mandatory-forbidden keys (FR-B-006)", () => {
    expect(FORBIDDEN_METRIC_LABELS.has("tenant_id")).toBe(true);
    expect(FORBIDDEN_METRIC_LABELS.has("store_id")).toBe(true);
    expect(FORBIDDEN_METRIC_LABELS.has("user_id")).toBe(true);
    expect(FORBIDDEN_METRIC_LABELS.has("actor_id")).toBe(true);
  });

  it("FORBIDDEN_METRIC_LABELS includes PII-suspect and credential keys", () => {
    // Spot-check matrix §3.1 / §3.2 representatives.
    expect(FORBIDDEN_METRIC_LABELS.has("email")).toBe(true);
    expect(FORBIDDEN_METRIC_LABELS.has("phone")).toBe(true);
    expect(FORBIDDEN_METRIC_LABELS.has("password")).toBe(true);
    expect(FORBIDDEN_METRIC_LABELS.has("api_key")).toBe(true);
    expect(FORBIDDEN_METRIC_LABELS.has("idempotency_key")).toBe(true);
  });

  it("FORBIDDEN_METRIC_LABELS includes unbounded per-message identifiers", () => {
    // request_id / correlation_id / trace_id are LOG fields, not metric labels.
    expect(FORBIDDEN_METRIC_LABELS.has("request_id")).toBe(true);
    expect(FORBIDDEN_METRIC_LABELS.has("correlation_id")).toBe(true);
    expect(FORBIDDEN_METRIC_LABELS.has("trace_id")).toBe(true);
  });

  it("rejects raw path (rendered URL) — only the route template is allowed", () => {
    // signals.md §6: rendered URL paths carry tenant ids; use `route` template.
    expect(FORBIDDEN_METRIC_LABELS.has("path")).toBe(true);
    expect(FORBIDDEN_METRIC_LABELS.has("url")).toBe(true);
  });
});

describe("validateMetricLabels — discriminated-union failure modes", () => {
  it("returns null when the labels match the allowlist exactly", () => {
    expect(validateMetricLabels("http_request_count", ["route", "method", "status_class"])).toBeNull();
    expect(validateMetricLabels("http_request_count", [])).toBeNull(); // subset is fine
    expect(validateMetricLabels("db_rls_context_failure_total", [])).toBeNull();
  });

  it("returns unknown_metric when the metric is not registered", () => {
    const err = validateMetricLabels("unregistered_metric_total", []);
    expect(err).toEqual({ kind: "unknown_metric", metric: "unregistered_metric_total" });
  });

  it("returns forbidden_label when a forbidden label is supplied", () => {
    // `tenant_id` is the canonical offender — every signal must reject it.
    const err = validateMetricLabels("http_request_count", ["tenant_id"]);
    expect(err).toEqual({
      kind: "forbidden_label",
      metric: "http_request_count",
      label: "tenant_id",
    });
  });

  it("returns unallowed_label when a label is neither forbidden nor in the allowed list", () => {
    // `region` is bounded and PII-safe but isn't in the http_request_count
    // allowed-labels — should still be rejected until reviewed under FR-B-012.
    const err = validateMetricLabels("http_request_count", ["region"]);
    expect(err).toEqual({
      kind: "unallowed_label",
      metric: "http_request_count",
      label: "region",
      allowed: ["route", "method", "status_class"],
    });
  });

  it("forbidden check fires BEFORE unallowed check (most-severe-wins)", () => {
    // `tenant_id` is forbidden; `region` is merely unallowed. Both are in
    // the input — the result MUST report `forbidden_label`.
    const err = validateMetricLabels("http_request_count", ["region", "tenant_id"]);
    expect(err).toEqual({
      kind: "forbidden_label",
      metric: "http_request_count",
      label: "tenant_id",
    });
  });
});

describe("assertMetricLabels — strict variant throws with a useful message", () => {
  it("does not throw on valid input", () => {
    expect(() => assertMetricLabels("queue_lag_seconds", ["queue"])).not.toThrow();
  });

  it("throws naming the metric on unknown_metric", () => {
    expect(() => assertMetricLabels("not_a_real_signal", [])).toThrow(
      /not registered in ALLOWED_METRIC_LABELS/,
    );
    expect(() => assertMetricLabels("not_a_real_signal", [])).toThrow(/not_a_real_signal/);
  });

  it("throws naming the offending label on forbidden_label", () => {
    expect(() => assertMetricLabels("http_request_count", ["tenant_id"])).toThrow(
      /FORBIDDEN_METRIC_LABELS|FR-B-006/,
    );
    expect(() => assertMetricLabels("http_request_count", ["tenant_id"])).toThrow(/tenant_id/);
  });

  it("throws naming the allowed set on unallowed_label", () => {
    expect(() => assertMetricLabels("http_request_count", ["region"])).toThrow(
      /not in the allowlist/,
    );
    expect(() => assertMetricLabels("http_request_count", ["region"])).toThrow(/route/);
  });
});

describe("Drift contract: every signal in the catalogue is represented", () => {
  // Lock the canonical signal name set against the docs/observability/signals.md
  // §1, §2, §3 enumeration. Adding a signal to the docs without adding it
  // here (or vice versa) fails this assertion — exactly the kind of drift
  // FR-B-012's cardinality review is meant to catch.
  const expectedSignals = [
    // API
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
    // DB
    "db_pool_in_use",
    "db_pool_waiters",
    "db_slow_query_total",
    "db_rls_context_failure_total",
    "db_migration_status",
    // Redis / BullMQ / Worker
    "redis_command_duration_seconds",
    "queue_lag_seconds",
    "queue_failed_total",
    "queue_dead_letter_total",
    "queue_retry_total",
    "worker_job_duration_seconds",
    "worker_processing_failure_total",
    // Track C outbox (registered, not emitted yet)
    "outbox_pending_total",
    "outbox_dead_letter_total",
    "outbox_drain_duration_seconds",
    // Catalog domain — 005 Wave 1 (signals.md §1.1, registered via 005-WAVE1-METRICS-ALLOWLIST)
    "unknown_item_captured_total",
    "unknown_item_resolved_total",
    "idempotency_token_mismatch_total",
    // Catalog domain — 005 Wave 2 (signals.md §1.1, registered via 005-WAVE2-METRICS-ALLOWLIST)
    "catalog_duplicate_alias_conflict_total",
    // Inventory domain — 009-SIGNAL-NEGBAL (FR-024 / plan §3.3). Unlabeled.
    "inventory_negative_balance_total",
    // Catalog domain — 010-US1-SNAPSHOT read-down (R6 / FR-070). Unlabeled.
    "catalog_unpriced_issue_rate",
    // ERPNext posting domain — 015-POLISH (spec §VII). Unlabeled.
    "erpnext_posting_reconciliation_total",
    // ERPNext reconciliation/repair domain — 017-POLISH (spec §VII). Unlabeled.
    "erpnext_reconciliation_repair_total",
    // ERPNext stock reconciliation sweep — RT-179. `outcome` (closed set).
    "erpnext_stock_reconciliation_sweep_total",
    // ERPNext posting reversal dead-lettered awaiting its sale_post — RT-207. Unlabeled.
    "erpnext_posting_reversal_deferred_dead_letter_total",
    // Connector boundary lifecycle — 018-POLISH (spec §FR-022a). Unlabeled.
    "connector_lifecycle_total",
    // Connector health — 020-POLISH (spec FR-018). Unlabeled.
    "connector_heartbeat_total",
    // ERPNext product-master reconciliation/repair — 021-POLISH (spec §VII). Unlabeled.
    "erpnext_product_reconciliation_total",
    // Settlement & receivables domain — 035 T034 (spec section 7). Unlabeled.
    "settlement_receivable_total",
    // POS shift close approver unverified at ingest — RT-17 10955 option A. `reason` (closed set).
    "shift_close_approver_unverified_total",
  ];

  for (const name of expectedSignals) {
    it(`registers "${name}" in ALLOWED_METRIC_LABELS`, () => {
      expect(ALLOWED_METRIC_LABELS[name]).toBeDefined();
    });
  }

  it("does not register signals outside the catalogue", () => {
    const registered = Object.keys(ALLOWED_METRIC_LABELS).sort();
    const expected = [...expectedSignals].sort();
    expect(registered).toEqual(expected);
  });
});
