/**
 * Worker / queue / Redis metric definitions — T472 / Track B / P4.
 *
 * Registers every worker-side signal from `docs/observability/signals.md` §3
 * with the OTel global Meter and exposes typed emission helpers.
 *
 * Label-policy enforcement (two layers, identical to api.metrics.ts /
 * db.metrics.ts):
 *   1. `assertMetricLabels` is called at module load for each signal.
 *      A forbidden or unregistered label throws immediately — it cannot
 *      reach a live SDK (FR-B-006, FR-B-012).
 *   2. Helper parameter types admit only the declared label keys. A call
 *      site cannot pass `tenant_id`, `store_id`, `user_id`, `actor_id`,
 *      `job_id`, `correlation_id`, or any forbidden key because the
 *      helpers' TypeScript signatures exclude them (compile-time
 *      enforcement of FR-B-006).
 *
 * Outbox signals (signals.md §3.4):
 *   - `outbox_dead_letter_total` and `outbox_drain_duration_seconds` are
 *     emitted from `DrainerProcessor.processRow` (T595 PR-B-1). Helpers
 *     `recordOutboxDeadLetter` / `recordOutboxDrainDuration` are exposed.
 *   - `outbox_pending_total` is emitted via `registerOutboxPendingGauge`
 *     (T595 PR-B-2): an ObservableGauge whose `addCallback` queries
 *     `outbox_events` GROUP BY `event_type` at SDK scrape time and
 *     observes one sample per event_type. `WorkerModule` wires the
 *     registrar against `AuditDbPool` on `onModuleInit`; the no-DB
 *     (dev / CI) path is a no-op.
 *
 * Emission wiring (per-processor call sites) is intentionally deferred —
 * this slice ships definitions + helpers + a presence test only. The
 * worker `/metrics` HTTP scrape endpoint (T483 worker subset) requires
 * `@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-prometheus`,
 * which is a separate package-gated slice (plan §11).
 *
 * Instruments are no-op until a MetricReader is registered. Tests
 * exercise the helpers safely without a live SDK.
 *
 * No API or DB signals — those are T470 / T471 (apps/api).
 *
 * Constitution §VII / FR-B-003 / FR-B-006 / FR-B-012.
 */
import type { Queue } from "bullmq";
import type { Pool } from "pg";

import {
  assertMetricLabels,
  getMeter,
  type Attributes,
  type Counter,
  type Histogram,
  type ObservableGauge,
} from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Bounded queue / job names (signals.md §3, plan §7)
// ---------------------------------------------------------------------------
// Bounded sets — adding a queue or job_name requires a cardinality review
// (FR-B-012) and a follow-on update here. The plan §7 enumerates the
// expected members; emission sites MUST stick to these values.
//
// These constants are exported so emission sites (deferred to a follow-on
// slice) and test fixtures consume a single source of truth.

/** Bounded queue label values. Mirrors plan §7 table row "queue_lag_seconds". */
export const WORKER_QUEUE_NAMES = [
  "email",
  "audit-fanout",
  "audit-retention",
  "session-revoke",
  "soft-delete-sweep",
] as const satisfies readonly string[];
export type WorkerQueueName = (typeof WORKER_QUEUE_NAMES)[number];

/**
 * Bounded job_name label values. Mirrors the queue set 1:1 today — the
 * label name differs (`job_name`) for catalogue consistency with BullMQ
 * conventions, but the allowed values are the same as `WORKER_QUEUE_NAMES`.
 */
export const WORKER_JOB_NAMES = WORKER_QUEUE_NAMES;
export type WorkerJobName = (typeof WORKER_JOB_NAMES)[number];

// ---------------------------------------------------------------------------
// error_class allowlist (plan §7.1)
// ---------------------------------------------------------------------------
// Unbounded class names blow cardinality (FR-B-006). Error MESSAGES are
// PII-suspect (redaction matrix §4.1 rule 4). The class NAME is the safe
// substitute, but only via a closed allowlist — anything else maps to
// "UnknownError" before the metric is recorded. The log still carries the
// precise class + sanitized summary; the metric is intentionally coarse.

/** Closed allowlist of worker-side error class labels. */
export const WORKER_ERROR_CLASSES = [
  "TenantContextMissingError",
  "ZodValidationError",
  "PostgresUniqueViolation",
  "RedisConnectionError",
  "Timeout",
  "UnknownError",
] as const satisfies readonly string[];
export type WorkerErrorClass = (typeof WORKER_ERROR_CLASSES)[number];

const WORKER_ERROR_CLASS_SET: ReadonlySet<string> = new Set(WORKER_ERROR_CLASSES);

// ---------------------------------------------------------------------------
// Bounded outbox event_type values (T595, signals.md §3.4)
// ---------------------------------------------------------------------------
// Closed allowlist of event_type values the outbox metrics may be labelled
// with. The single member today mirrors the only registered consumer
// (`AuditEventCreatedConsumer.eventType` and `retention.policy.AUDIT_EVENT_TYPE`).
// Adding an event_type requires registering a corresponding `OutboxConsumer`
// AND extending this constant — both are gated by cardinality review
// (FR-B-012). The runtime emission sites pass `row.event_type as string`
// because the drainer receives untyped strings from Postgres; values outside
// this set still emit (no coercion in this slice) — keeping the label
// uncoerced preserves operator visibility into unrouted event types until a
// stricter sanitizer is approved.
export const WORKER_OUTBOX_EVENT_TYPES = [
  "audit.event.created",
] as const satisfies readonly string[];
export type WorkerOutboxEventType = (typeof WORKER_OUTBOX_EVENT_TYPES)[number];

/**
 * Coerce an arbitrary error-class name to the closed allowlist. Unknown
 * class names map to `"UnknownError"`. This is the only sanctioned path
 * to derive an `error_class` label value at an emission site.
 *
 * Callers MUST NOT pass `err.message` here — only `err.constructor.name`
 * (plan §7.1). Messages are PII-suspect.
 */
export function sanitizeErrorClass(
  className: string | undefined | null,
): WorkerErrorClass {
  if (typeof className !== "string" || !WORKER_ERROR_CLASS_SET.has(className)) {
    return "UnknownError";
  }
  return className as WorkerErrorClass;
}

// ---------------------------------------------------------------------------
// Module-load label-policy validation
// ---------------------------------------------------------------------------
// assertMetricLabels throws if a label is forbidden or not in the closed
// allowlist (ALLOWED_METRIC_LABELS in packages/shared). Called once at
// registration time; cannot be deferred to emit time.

assertMetricLabels("db_pool_in_use", []);
assertMetricLabels("db_pool_waiters", []);
assertMetricLabels("db_slow_query_total", ["query_class"]);
assertMetricLabels("redis_command_duration_seconds", ["command"]);
assertMetricLabels("queue_lag_seconds", ["queue"]);
assertMetricLabels("queue_failed_total", ["queue", "error_class"]);
assertMetricLabels("queue_dead_letter_total", ["queue"]);
assertMetricLabels("queue_retry_total", ["queue"]);
assertMetricLabels("worker_job_duration_seconds", ["job_name"]);
assertMetricLabels("worker_processing_failure_total", ["job_name", "error_class"]);

// Track C outbox placeholders — registered as definitions only per
// plan §6. Emission helpers are NOT exposed; the outbox slice will add
// them when Track C P7 ships. Validating labels at module load now
// catches drift early.
assertMetricLabels("outbox_pending_total", ["event_type"]);
assertMetricLabels("outbox_dead_letter_total", ["event_type"]);
assertMetricLabels("outbox_drain_duration_seconds", ["event_type"]);

// ERPNext posting domain — 015-POLISH (spec §VII). The SAME family the api side
// registers (api.metrics.ts): a posting row that dead-letters at 015-RESOLVE
// creation time (unmapped_item / unmapped_store) increments it here, mirroring
// the connectorAckOutcome emission on the api side. UNLABELED — the affected
// (tenant, store, sale, category) lives on the erpnext_posting_status row + audit.
assertMetricLabels("erpnext_posting_reconciliation_total", []);

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

const meter = getMeter("worker");

// DB pool — worker process observes its own AuditDbPool stats on port 9091.
// The API process observes its pool independently on port 9464 via db.metrics.ts.
const _dbSlowQuery: Counter = meter.createCounter("db_slow_query_total", {
  description:
    "Total DB queries exceeding the slow-query threshold (500 ms), labelled by " +
    "parameterized-statement class. query_class is a hash of the SQL template — " +
    "NEVER the rendered query text.",
});
const _dbPoolInUse: ObservableGauge = meter.createObservableGauge("db_pool_in_use", {
  description: "Number of connections currently checked out from the DB pool.",
});
const _dbPoolWaiters: ObservableGauge = meter.createObservableGauge("db_pool_waiters", {
  description: "Number of requests currently waiting for a DB pool connection.",
});

// Redis
const _redisCommandDuration: Histogram = meter.createHistogram(
  "redis_command_duration_seconds",
  {
    description:
      "Redis command duration in seconds, labelled by the command verb " +
      "(get/set/del/hget/hset/...). NEVER labelled by the Redis key.",
    unit: "s",
  },
);

// BullMQ / queues
// queue_lag_seconds is an observable gauge — pool-style introspection
// (BullMQ getWaitingCount + oldest-waiting-job age) is sampled at the
// SDK collection cadence. The addCallback wiring is deferred to the
// emission slice; the instrument is registered now so signal-presence
// holds.
const _queueLag: ObservableGauge = meter.createObservableGauge("queue_lag_seconds", {
  description:
    "BullMQ queue lag in seconds, labelled by queue. Sampled by the metrics " +
    "SDK; never polled synchronously to avoid Redis pressure.",
  unit: "s",
});
const _queueFailed: Counter = meter.createCounter("queue_failed_total", {
  description: "Total failed jobs by queue and sanitized error_class.",
});
const _queueDeadLetter: Counter = meter.createCounter("queue_dead_letter_total", {
  description:
    "Total jobs that exhausted retries and landed in the BullMQ failed-jobs " +
    "set (acts as DLQ per shared queue.config), labelled by queue.",
});
const _queueRetry: Counter = meter.createCounter("queue_retry_total", {
  description:
    "Total retry attempts (failed + attemptsMade < attemptsLimit) by queue.",
});

// Workers
const _workerJobDuration: Histogram = meter.createHistogram(
  "worker_job_duration_seconds",
  {
    description:
      "Worker job processing duration in seconds, labelled by job_name. " +
      "Histogram — quantiles (p50/p95/p99) recovered at the query layer.",
    unit: "s",
  },
);
const _workerProcessingFailure: Counter = meter.createCounter(
  "worker_processing_failure_total",
  {
    description:
      "Total worker job processing failures by job_name and sanitized " +
      "error_class (closed allowlist; unknown classes coerced to UnknownError).",
  },
);

// Track C outbox — outbox_pending_total is an ObservableGauge whose
// addCallback queries outbox_events GROUP BY event_type at scrape time.
// The callback is registered by `registerOutboxPendingGauge` (T595 PR-B-2),
// called from WorkerModule's OutboxPendingGaugeRegistrar on Nest init.
// The instrument is created here so the OTel Meter handle stays at module
// scope and the callback can be registered later against the SAME instrument
// without re-creating it.
const _outboxPending: ObservableGauge = meter.createObservableGauge(
  "outbox_pending_total",
  {
    description:
      "Pending outbox events by event_type. Sampled at OTel scrape time " +
      "via SELECT COUNT(*) GROUP BY event_type on rows whose delivery_state " +
      "is in ('pending','claimed','failed'). 'delivered' and 'dead_lettered' " +
      "are terminal and excluded.",
  },
);

// T595 (PR-B-1): outbox_dead_letter_total and outbox_drain_duration_seconds
// are emitted from DrainerProcessor's existing per-row branches. Helpers
// exposed below mirror the recordQueue* / recordWorker* shape used by
// PR-A's T596 emission.
const _outboxDeadLetter: Counter = meter.createCounter("outbox_dead_letter_total", {
  description:
    "Outbox events that exhausted drain retries (row.attempts >= MAX_ATTEMPTS), " +
    "labelled by event_type.",
});
const _outboxDrainDuration: Histogram = meter.createHistogram(
  "outbox_drain_duration_seconds",
  {
    description:
      "Outbox per-row drain duration in seconds, labelled by event_type. " +
      "Wall-clock from claim-dispatch to consumer return (success or failure).",
    unit: "s",
  },
);

// ERPNext posting domain — 015-POLISH (spec §VII). Same family name as the api
// side; emitted by PostingRequestedConsumer when 015-RESOLVE rejects a posting
// at creation (unmapped_item / unmapped_store → permanently_rejected).
const _erpnextPostingReconciliation: Counter = meter.createCounter(
  "erpnext_posting_reconciliation_total",
  {
    description:
      "ERPNext posting rows that became permanently_rejected at 015-RESOLVE " +
      "creation time (unmapped_item / unmapped_store). The reconciliation / " +
      "dead-letter flag the 017 surface drains. Unlabeled — the affected " +
      "(tenant, store, sale, category) lives on the erpnext_posting_status row.",
  },
);

// ---------------------------------------------------------------------------
// Attribute types — TypeScript compile-time label enforcement (FR-B-006)
// ---------------------------------------------------------------------------
// Each type admits ONLY the allowed label keys for its signal. A call site
// that adds `tenant_id`, `store_id`, `user_id`, `actor_id`, `job_id`,
// `correlation_id`, or any other forbidden key won't compile.

export interface DbSlowQueryAttrs {
  query_class: string;
}

export interface RedisCommandDurationAttrs {
  command: string;
}

export interface QueueLagAttrs {
  queue: WorkerQueueName;
}

export interface QueueFailedAttrs {
  queue: WorkerQueueName;
  error_class: WorkerErrorClass;
}

export interface QueueDeadLetterAttrs {
  queue: WorkerQueueName;
}

export interface QueueRetryAttrs {
  queue: WorkerQueueName;
}

export interface WorkerJobDurationAttrs {
  job_name: WorkerJobName;
}

export interface WorkerProcessingFailureAttrs {
  job_name: WorkerJobName;
  error_class: WorkerErrorClass;
}

/**
 * Label shape for `outbox_dead_letter_total` and `outbox_drain_duration_seconds`.
 *
 * The drainer receives `row.event_type` from Postgres as an untyped string —
 * the row may carry an event_type the worker has no consumer for (the
 * "UnroutableEventType" path in DrainerProcessor.processRow). Typing this as
 * `string` rather than `WorkerOutboxEventType` keeps that diagnostic
 * visibility intact. Operators can spot unexpected event_type labels on the
 * dashboard rather than seeing the metric silently coerce away the signal.
 *
 * Cardinality control comes from the consumer-registry invariant: only event
 * types with a registered consumer (or an explicit unroutable-test fixture)
 * ever reach this label. A separate cardinality review (FR-B-012) gates any
 * new registered event_type.
 */
export interface OutboxDeadLetterAttrs {
  event_type: string;
}

export interface OutboxDrainDurationAttrs {
  event_type: string;
}

// ---------------------------------------------------------------------------
// Emission helpers
// ---------------------------------------------------------------------------

/**
 * Increment db_slow_query_total for a parameterized-statement class.
 *
 * The `query_class` value MUST be a stable hash of the parameterized SQL
 * template (e.g. the first 8 hex digits of SHA-256 of the statement with
 * `$1`/`$2` placeholders). It MUST NOT be the rendered query text, a
 * parameter value, or any user-derived string (redaction matrix §3.3).
 *
 * Emission site: `InstrumentedPool.query` — fires when a `pg.Pool` query
 * exceeds `SLOW_QUERY_THRESHOLD_SECONDS` (500 ms).
 */
export function recordDbSlowQuery(attrs: DbSlowQueryAttrs): void {
  _dbSlowQuery.add(1, attrs as unknown as Attributes);
}

/**
 * Record a Redis command duration observation (seconds).
 *
 * Emission site (future): a node-redis / ioredis command hook, or derived
 * from the shared OTel `RedisInstrumentation` spans via the metrics view
 * API. Decision deferred to the wiring slice (plan §5.2).
 */
export function recordRedisCommandDuration(
  attrs: RedisCommandDurationAttrs,
  durationSeconds: number,
): void {
  _redisCommandDuration.record(durationSeconds, attrs as unknown as Attributes);
}

/**
 * Increment queue_failed_total for the given queue + sanitized error_class.
 *
 * Emission site (future): BullMQ `QueueEvents.on("failed", ...)` subscription
 * at worker bootstrap (plan §5.2). `error_class` MUST be sourced via
 * `sanitizeErrorClass(err.constructor.name)` — never `err.message`.
 */
export function recordQueueFailed(attrs: QueueFailedAttrs): void {
  _queueFailed.add(1, attrs as unknown as Attributes);
}

/**
 * Increment queue_dead_letter_total for the given queue.
 *
 * Emission site (future): BullMQ `QueueEvents.on("failed", ...)` where
 * `attemptsMade >= attemptsLimit` (the retry budget is exhausted; the
 * job is now in the BullMQ failed-jobs set, which acts as DLQ per
 * shared `queue.config`).
 */
export function recordQueueDeadLetter(attrs: QueueDeadLetterAttrs): void {
  _queueDeadLetter.add(1, attrs as unknown as Attributes);
}

/**
 * Increment queue_retry_total for the given queue.
 *
 * Emission site (future): BullMQ `QueueEvents.on("failed", ...)` where
 * `attemptsMade < attemptsLimit` (the job will be retried).
 */
export function recordQueueRetry(attrs: QueueRetryAttrs): void {
  _queueRetry.add(1, attrs as unknown as Attributes);
}

/**
 * Record a worker job duration observation (seconds).
 *
 * Emission site (future): a job-instrumentation interceptor that wraps
 * every processor's `process(job)` in a try/finally measuring wall-clock
 * duration (plan §5.2).
 */
export function recordWorkerJobDuration(
  attrs: WorkerJobDurationAttrs,
  durationSeconds: number,
): void {
  _workerJobDuration.record(durationSeconds, attrs as unknown as Attributes);
}

/**
 * Increment worker_processing_failure_total for the given job_name +
 * sanitized error_class.
 *
 * Emission site (future): the catch branch of the same job-instrumentation
 * interceptor. `error_class` MUST be sourced via
 * `sanitizeErrorClass(err.constructor.name)`.
 */
export function recordWorkerProcessingFailure(
  attrs: WorkerProcessingFailureAttrs,
): void {
  _workerProcessingFailure.add(1, attrs as unknown as Attributes);
}

/**
 * Increment outbox_dead_letter_total for the given event_type.
 *
 * Emission site: `DrainerProcessor.processRow` — the existing dead-letter
 * branch where `row.attempts >= MAX_ATTEMPTS` after a consumer throw.
 * Called BEFORE `safeMarkDeadLettered` (mirrors PR-A's D4 ordering) so the
 * metric reflects the drainer's decision regardless of persistence outcome.
 */
export function recordOutboxDeadLetter(attrs: OutboxDeadLetterAttrs): void {
  _outboxDeadLetter.add(1, attrs as unknown as Attributes);
}

/**
 * Record an outbox per-row drain duration observation (seconds).
 *
 * Emission site: `DrainerProcessor.processRow` finally — wall-clock from
 * the start of processing to the consumer's return (success path) or the
 * decision branch (failure / no-consumer paths). The histogram lets
 * operators recover p50/p95/p99 per event_type at the query layer.
 */
export function recordOutboxDrainDuration(
  attrs: OutboxDrainDurationAttrs,
  durationSeconds: number,
): void {
  _outboxDrainDuration.record(durationSeconds, attrs as unknown as Attributes);
}

/**
 * Increment erpnext_posting_reconciliation_total (015-POLISH, spec §VII).
 * Emission site: PostingRequestedConsumer.handle — once per posting row that
 * 015-RESOLVE rejects at creation (unmapped_item / unmapped_store →
 * permanently_rejected). Unlabeled — the affected (tenant, store, sale,
 * category) lives on the erpnext_posting_status row + audit, not metric labels.
 * A SIGNAL: emission MUST NOT alter the consumer's insert outcome.
 */
export function recordErpnextPostingReconciliation(): void {
  _erpnextPostingReconciliation.add(1);
}

// ---------------------------------------------------------------------------
// db_pool_in_use + db_pool_waiters — ObservableGauge addCallback registrar
// ---------------------------------------------------------------------------

/**
 * Register addCallbacks for `db_pool_in_use` and `db_pool_waiters` against
 * the worker's AuditDbPool.
 *
 * Mirrors the API-side `registerDbPoolGauges` in `db.metrics.ts` — each
 * process (API port 9464, worker port 9091) scrapes its own pool separately.
 *
 * Behavior:
 *   - `deps.pool === null` → no-op handle. Matches the no-DB / no-Redis safe
 *     path (both pool and factory are null; no jobs flow).
 *   - Otherwise → registers synchronous callbacks; reads are in-memory
 *     counters on the pool object, no DB round-trip.
 *
 * The returned `{ stop }` handle is called by `WorkerDbPoolGaugeRegistrar`
 * on `onModuleDestroy` so callbacks do not outlive the pool.
 */
export function registerDbPoolGauges(deps: {
  readonly pool: Pool | null;
}): { stop: () => void } {
  const pool = deps.pool;
  if (pool === null) {
    return { stop: () => undefined };
  }

  const inUseCallback = (result: {
    observe(value: number, attributes: Attributes): void;
  }): void => {
    result.observe(pool.totalCount - pool.idleCount, {} as Attributes);
  };

  const waitersCallback = (result: {
    observe(value: number, attributes: Attributes): void;
  }): void => {
    result.observe(pool.waitingCount, {} as Attributes);
  };

  _dbPoolInUse.addCallback(inUseCallback);
  _dbPoolWaiters.addCallback(waitersCallback);

  return {
    stop: () => {
      _dbPoolInUse.removeCallback(inUseCallback);
      _dbPoolWaiters.removeCallback(waitersCallback);
    },
  };
}

// ---------------------------------------------------------------------------
// queue_lag_seconds — ObservableGauge addCallback registrar
// ---------------------------------------------------------------------------

/**
 * Dependencies for `registerQueueLagGauge`.
 *
 * `queues` is a map from queue name to a live BullMQ `Queue` reader instance.
 * `null` makes the registrar a no-op (no-Redis path).
 *
 * `getWaitingFn` is an optional injection seam for unit tests — production
 * callers omit it and the default `queue.getWaiting(0, 0)` is used.
 */
export interface QueueLagGaugeDeps {
  readonly queues: ReadonlyMap<string, Queue> | null;
  readonly getWaitingFn?: (
    queue: Queue,
  ) => Promise<ReadonlyArray<{ readonly timestamp: number }>>;
}

/** Observable result shape passed to OTel addCallback functions. */
export interface QueueLagObservableResult {
  observe(value: number, attributes: Attributes): void;
}

/**
 * Build the `queue_lag_seconds` callback function without registering it.
 *
 * Extracted so tests can obtain the real callback via this function and invoke
 * it directly with a mock `QueueLagObservableResult` — exercising the actual
 * production path without requiring a live OTel MetricReader.
 *
 * The returned callback:
 *   - Skips re-execution when a previous tick is still in-flight (re-entrancy
 *     guard; inFlight state is scoped to this closure).
 *   - For each queue in `WORKER_QUEUE_NAMES` present in `queues`: calls
 *     `getWaitingFn`, derives lag = `Math.max(0, (now - oldest.timestamp) / 1000)`,
 *     then calls `observableResult.observe(lag, { queue })`. Clamping to ≥ 0
 *     prevents negative values from producer/consumer clock drift.
 *   - On per-queue error: logs ONE structured stderr line (errorName only) and
 *     skips that queue's observation. Never throws.
 */
export function createQueueLagCallback(
  queues: ReadonlyMap<string, Queue>,
  getWaitingFn: (
    queue: Queue,
  ) => Promise<ReadonlyArray<{ readonly timestamp: number }>>,
): (observableResult: QueueLagObservableResult) => Promise<void> {
  let inFlight = false;

  return async (observableResult: QueueLagObservableResult): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await Promise.all(
        WORKER_QUEUE_NAMES.map(async (queueName) => {
          const queue = queues.get(queueName);
          if (queue === undefined) return;
          try {
            const waiting = await getWaitingFn(queue);
            const first = waiting[0];
            const lag =
              first !== undefined
                ? Math.max(0, (Date.now() - first.timestamp) / 1000)
                : 0;
            observableResult.observe(lag, {
              queue: queueName,
            } as Attributes);
          } catch (err: unknown) {
            const errorName =
              err instanceof Error ? err.name || "Error" : "UnknownError";
            process.stderr.write(
              JSON.stringify({
                level: "error",
                component: "queue.lag.gauge",
                message: "queue_lag_seconds callback failed",
                queue: queueName,
                errorName,
              }) + "\n",
            );
          }
        }),
      );
    } finally {
      inFlight = false;
    }
  };
}

/**
 * Register the `queue_lag_seconds` ObservableGauge callback.
 *
 * Behavior:
 *   - `deps.queues === null` → no-op handle (no Redis).
 *   - Otherwise → builds the callback via `createQueueLagCallback` and
 *     registers it with the OTel `_queueLag` instrument. At each scrape,
 *     for each queue in `WORKER_QUEUE_NAMES`, the callback calls
 *     `queue.getWaiting(0, 0)` and observes lag in seconds (clamped ≥ 0).
 *
 * The returned `{ stop }` handle removes the callback. `QueueLagGaugeRegistrar`
 * calls it on `onModuleDestroy` so the callback does not outlive the Queue
 * reader connections.
 */
export function registerQueueLagGauge(
  deps: QueueLagGaugeDeps,
): { stop: () => void } {
  const queues = deps.queues;
  if (queues === null) {
    return { stop: () => undefined };
  }

  const getWaiting =
    deps.getWaitingFn ?? ((q: Queue) => q.getWaiting(0, 0));
  const callback = createQueueLagCallback(queues, getWaiting);

  _queueLag.addCallback(callback);
  return {
    stop: () => {
      _queueLag.removeCallback(callback);
    },
  };
}

// ---------------------------------------------------------------------------
// outbox_pending_total — ObservableGauge addCallback registrar (T595 PR-B-2)
// ---------------------------------------------------------------------------

/**
 * Shape of one row returned by the pending-events query. The pg driver
 * serialises bigint as string; the registrar casts to Number at the boundary
 * (safe because the outbox row count cannot realistically exceed 2^53).
 */
export interface OutboxPendingRow {
  readonly event_type: string;
  readonly count: number;
}

/**
 * Dependencies for `registerOutboxPendingGauge`.
 *
 * `pool` is the `AuditDbPool.pool` value — a real `pg.Pool` in production or
 * `null` on the safe non-prod / no-DB path. `null` makes the registrar a no-op
 * (no callback registered).
 *
 * `queryFn` is an OPTIONAL injection seam for unit tests — production callers
 * omit it. When omitted, the registrar uses the default Drizzle-less SQL
 * shown in the source below, wrapped in `runWithTenantContext` with
 * `{ tenantId: null, isPlatformAdmin: true }`. The outbox RLS policy
 * permits the platform-admin context to SELECT rows from every tenant,
 * mirroring `claimBatch` (packages/db/src/outbox/repository.ts).
 */
export interface OutboxPendingGaugeDeps {
  readonly pool: Pool | null;
  readonly queryFn?: (pool: Pool) => Promise<OutboxPendingRow[]>;
}

/**
 * Bounded list of `delivery_state` values that contribute to the pending
 * gauge. `delivered` is terminal (success); `dead_lettered` is terminal
 * and separately tracked by `outbox_dead_letter_total`. Including either
 * would double-count.
 *
 * Mirrors the runtime check pinned by
 * `apps/worker/src/outbox/drainer.processor.ts` and the CHECK constraint
 * in `packages/db/drizzle/0006_outbox_events.sql` (delivery_state must be
 * one of: 'pending','claimed','delivered','failed','dead_lettered').
 */
const PENDING_DELIVERY_STATES = ["pending", "claimed", "failed"] as const;

/**
 * Default scrape-time query. Runs under
 * `runWithTenantContext(pool, { tenantId: null, isPlatformAdmin: true }, ...)`
 * so the outbox_events RLS policy lets the SELECT aggregate across tenants.
 *
 * Imports are LAZY (require-style) inside the function body to keep
 * worker.metrics.ts free of a load-time dependency on @data-pulse-2/db.
 * The module's existing load-time imports are already package-graph
 * verified (PR #245); adding @data-pulse-2/db at module load would force
 * a behavioral re-test of the `production-import-order.spec.ts` regression
 * surface for no real benefit — the registrar's query path runs at scrape
 * time, well after Nest init.
 */
async function defaultPendingQuery(pool: Pool): Promise<OutboxPendingRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runWithTenantContext } = require("@data-pulse-2/db") as {
    runWithTenantContext: <T>(
      pool: Pool,
      ctx: { tenantId: string | null; isPlatformAdmin: boolean },
      work: (client: {
        query: (
          sql: string,
          values?: unknown[],
        ) => Promise<{
          rows: Array<{ event_type: string; count: string }>;
        }>;
      }) => Promise<T>,
    ) => Promise<T>;
  };
  return runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      // Parameterized query — even though PENDING_DELIVERY_STATES is a
      // compile-time const today, the repo's house style for any SQL
      // taking a list of values is `= ANY($1::text[])` (see drainer,
      // repository, retention). Future-proofs against the constant ever
      // becoming non-literal.
      const result = await client.query(
        `SELECT event_type, COUNT(*)::text AS count
           FROM outbox_events
          WHERE delivery_state = ANY($1::text[])
          GROUP BY event_type`,
        [[...PENDING_DELIVERY_STATES]],
      );
      return result.rows.map((r) => ({
        event_type: r.event_type,
        count: Number(r.count),
      }));
    },
  );
}

/**
 * Register the `outbox_pending_total` ObservableGauge callback.
 *
 * Behavior:
 *   - `deps.pool === null` (NoOp / dev path): returns immediately with a
 *     no-op `stop` handle. No callback is registered. Gauge stays unobserved;
 *     dashboards render "no data" for the missing scrape window, which is
 *     the truthful signal — there is no DB to count against.
 *   - Otherwise: registers an OTel `addCallback`. At each scrape the
 *     callback runs the (optionally injected) `queryFn`, then calls
 *     `observableResult.observe(count, { event_type })` for each row.
 *
 * Re-entrancy:
 *   The callback skips re-execution if a previous tick is still in-flight.
 *   OTel default scrape cadence is ~60s and the query (a single GROUP BY
 *   on the partial index `idx_outbox_events_claim`) completes in
 *   milliseconds, so this is defense-in-depth rather than a hot path.
 *
 * Failure handling:
 *   The callback NEVER throws. A query error writes ONE structured
 *   stderr line (errorName only — no `err.message`, mirrors
 *   `DrainerProcessor.logError`) and returns without observing anything;
 *   the next scrape gets a fresh attempt.
 *
 * The returned `{ stop }` handle removes the callback. `WorkerModule`'s
 * `OutboxPendingGaugeRegistrar.onModuleDestroy` calls it during graceful
 * shutdown so a teardown does not leave a dangling callback that would
 * try to query a closed pool.
 */
export function registerOutboxPendingGauge(
  deps: OutboxPendingGaugeDeps,
): { stop: () => void } {
  const pool = deps.pool;
  if (pool === null) {
    // Safe no-DB path. No callback registered; nothing to stop.
    return { stop: () => undefined };
  }

  const queryFn = deps.queryFn ?? defaultPendingQuery;
  let inFlight = false;

  const callback = async (observableResult: {
    observe(value: number, attributes: Attributes): void;
  }): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const rows = await queryFn(pool);
      for (const row of rows) {
        observableResult.observe(row.count, {
          event_type: row.event_type,
        } as Attributes);
      }
    } catch (err: unknown) {
      // OTel callbacks MUST NOT throw. Log a redacted single line and
      // return — the next scrape retries. `errorName` only, never
      // `err.message`: Postgres error messages can embed parameter values
      // and runtime data (matrix §3.3, drainer.processor.logError).
      const errorName =
        err instanceof Error ? err.name || "Error" : "UnknownError";
      process.stderr.write(
        JSON.stringify({
          level: "error",
          component: "outbox.pending.gauge",
          message: "outbox_pending_total callback failed",
          errorName,
        }) + "\n",
      );
    } finally {
      inFlight = false;
    }
  };

  _outboxPending.addCallback(callback);
  return {
    stop: () => {
      _outboxPending.removeCallback(callback);
    },
  };
}

// ---------------------------------------------------------------------------
// Signal-name registry — used by T465 signal-presence test
// ---------------------------------------------------------------------------

/**
 * Canonical names of all worker-side signals registered by this module
 * that ALSO have an emission helper exposed (i.e., the seven signals
 * the slice can emit today). Outbox placeholders are tracked separately
 * in `WORKER_OUTBOX_METRIC_NAMES` because no helper is exposed for them.
 *
 * Drift between this array and the actual instrument creation above
 * fails CI via the T465 presence test.
 */
export const WORKER_METRIC_NAMES = [
  // P4 W1: DB pool gauges — worker observes its own AuditDbPool via
  // `registerDbPoolGauges`, wired by WorkerDbPoolGaugeRegistrar on Nest init.
  "db_pool_in_use",
  "db_pool_waiters",
  // P4 W5: slow-query counter — emitted by InstrumentedPool.query when a
  // pg.Pool query exceeds SLOW_QUERY_THRESHOLD_SECONDS (500 ms).
  "db_slow_query_total",
  "redis_command_duration_seconds",
  // P4 W2: queue lag gauge — wired by QueueLagGaugeRegistrar on Nest init.
  "queue_lag_seconds",
  "queue_failed_total",
  "queue_dead_letter_total",
  "queue_retry_total",
  "worker_job_duration_seconds",
  "worker_processing_failure_total",
  // T595 (PR-B-1): outbox dead-letter + drain-duration emitted from
  // DrainerProcessor.processRow.
  "outbox_dead_letter_total",
  "outbox_drain_duration_seconds",
  // T595 (PR-B-2): outbox_pending_total emitted via the
  // `registerOutboxPendingGauge` ObservableGauge addCallback, wired by
  // WorkerModule's OutboxPendingGaugeRegistrar against AuditDbPool on
  // Nest init.
  "outbox_pending_total",
  // 015-POLISH (spec §VII): posting reconciliation / DLQ flag, emitted by
  // PostingRequestedConsumer on a 015-RESOLVE creation-time rejection.
  "erpnext_posting_reconciliation_total",
] as const satisfies readonly string[];

export type WorkerMetricName = (typeof WORKER_METRIC_NAMES)[number];

/**
 * Canonical names of Track C outbox signals **registered** by this module
 * as definitions only — no emission helper exposed.
 *
 * After T595 PR-B-2 all outbox signals emit; this list is now empty but
 * kept as a tombstone so a future placeholder-style signal can land here
 * without rebuilding the test surface that depends on the symbol.
 */
export const WORKER_OUTBOX_METRIC_NAMES = [] as const satisfies readonly string[];

export type WorkerOutboxMetricName = (typeof WORKER_OUTBOX_METRIC_NAMES)[number];
