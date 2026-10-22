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
 * It is a data + validator module. Its one I/O is reading the allowlist
 * fragments (`./metric-labels/`) once, synchronously, at import (RT-812).
 */
import { join } from "node:path";
import { loadFragmentDir, type LoadedFragment } from "../fragments/load-fragment-dir";

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
 * Adding a metric MUST register it. Adding a label to an existing metric MUST
 * update its entry. RT-812: the allowlist is assembled from one fragment per
 * domain in `./metric-labels/<slug>.labels.ts` (each exports `METRIC_LABELS`),
 * so parallel PRs add files instead of editing one list. `baseline.labels.ts`
 * holds every metric registered before RT-812 and is frozen. Two-step gate:
 *   1. The metric-registration helper calls `assertMetricLabels(name, keys)`.
 *      A missing entry or an unknown key throws.
 *   2. The cardinality test (`apps/api/test/observability/cardinality.spec.ts`)
 *      asserts every entry's value set is disjoint from
 *      `FORBIDDEN_METRIC_LABELS` and that the frozen baseline is intact.
 *
 * Loading reads the fragment directory once, at import, and fails closed: a
 * missing directory, a missing baseline, a stray file, a malformed fragment or
 * a metric registered twice throws, so the allowlist never comes back empty.
 */
export interface MetricLabelRegistry {
  readonly labels: Readonly<Record<string, readonly string[]>>;
  /** metric → the fragment (file slug) that registered it. */
  readonly sources: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (Array.isArray(value)) return false;
  return typeof value === "object" && value !== null;
}

function fragmentLabels(fragment: LoadedFragment): Record<string, unknown> {
  const exported = (fragment.exports as { METRIC_LABELS?: unknown } | null)?.METRIC_LABELS;
  if (!isRecord(exported)) {
    throw new Error(`metric-labels fragment ${fragment.name} must export METRIC_LABELS as an object`);
  }
  return exported as Record<string, unknown>;
}

function checkedLabels(fragment: string, metric: string, labels: unknown): readonly string[] {
  if (!/^[a-z][a-z0-9_]*$/.test(metric)) {
    throw new Error(`metric-labels fragment ${fragment}: "${metric}" is not a snake_case metric name`);
  }
  if (!Array.isArray(labels) || !labels.every((l): l is string => typeof l === "string")) {
    throw new Error(`metric-labels fragment ${fragment}: "${metric}" must map to an array of label keys`);
  }
  return Object.freeze([...labels]);
}

/** Merge loaded fragments into the allowlist. Exported for the fragment tests. */
export function buildMetricLabelRegistry(fragments: readonly LoadedFragment[]): MetricLabelRegistry {
  const labels: Record<string, readonly string[]> = {};
  const sources: Record<string, string> = {};
  for (const fragment of fragments) {
    for (const [metric, keys] of Object.entries(fragmentLabels(fragment))) {
      const previous = sources[metric];
      if (previous !== undefined) {
        throw new Error(`metric "${metric}" is registered by both ${previous} and ${fragment.name}`);
      }
      labels[metric] = checkedLabels(fragment.name, metric, keys);
      sources[metric] = fragment.name;
    }
  }
  return { labels: Object.freeze(labels), sources: Object.freeze(sources) };
}

const registry = buildMetricLabelRegistry(
  loadFragmentDir(join(__dirname, "metric-labels"), ".labels", __filename),
);

export const ALLOWED_METRIC_LABELS: Readonly<Record<string, readonly string[]>> = registry.labels;
/** metric → the fragment that registered it (`baseline` for pre-RT-812 metrics). */
export const METRIC_LABEL_SOURCES: Readonly<Record<string, string>> = registry.sources;

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
