/**
 * T581 — Outbox drainer processor.
 *
 * Polls `outbox_events` on a configurable interval, claims batches via
 * `FOR UPDATE SKIP LOCKED`, passes each tenant-scoped row to its consumer,
 * and transitions the row to `delivered`, `failed`,
 * or `dead_lettered` depending on the outcome.
 *
 * Tenant-context pattern (Constitution §II, lifecycle.md §6)
 * ----------------------------------------------------------
 * Pattern (i): platform-role claim, per-row tenant context for consumers.
 *
 *   1. `claimBatch(pool, batchSize)` runs under `{ isPlatformAdmin: true }`.
 *      The RLS policy allows the platform-admin context to see all tenants' rows.
 *   2. The drainer passes the row's tenant ID to its consumer.
 *   3. A consumer making tenant-scoped DB queries MUST establish its own
 *      `runWithTenantContext` on the client it actually uses. T561 proves
 *      that skipping this fails RLS.
 *
 * The drainer uses platform-admin context only for claim and state updates;
 * consumer-owned DB operations use the row's tenant.
 *
 * Concurrency
 * -----------
 * `start()` launches a single poll loop (setInterval). Each tick awaits
 * the full batch before the next tick fires — the effective poll rate is
 * `POLL_INTERVAL_MS + processing_time`. Multiple drainer instances (replicas)
 * run independently; `FOR UPDATE SKIP LOCKED` prevents double-claiming.
 * The claim limit reserves pool capacity for lease heartbeats and transitions.
 *
 * Error handling
 * --------------
 * Consumer throws → `markFailed` (with backoff). At `attempts === MAX_ATTEMPTS`
 * → `markDeadLettered`. State-machine transitions are best-effort: if the
 * mark call itself fails, the drainer logs and continues. A bounded lease
 * sweep returns stale claims to `pending` on a later tick; a live handler
 * renews its lease until processing finishes.
 *
 * No-consumer routing
 * -------------------
 * If no consumer is registered for a given event type, the drainer logs an
 * error and marks the row `failed` (not `dead_lettered` immediately) so it can
 * be triage-inspected. This is not a steady-state condition — all event types
 * in the registry MUST have a consumer.
 */
import type { Pool } from "pg";
import {
  claimBatch,
  heartbeatClaim,
  markDelivered,
  markFailed,
  markDeadLettered,
  reclaimStaleClaims,
  MAX_ATTEMPTS,
  type ClaimedOutboxEvent,
} from "@data-pulse-2/db";
import type { OutboxConsumer } from "@data-pulse-2/shared";
import type { OutboxConsumerRegistry } from "./registry";
import {
  recordOutboxDeadLetter,
  recordOutboxDrainDuration,
  recordQueueDeadLetter,
  recordQueueFailed,
  recordQueueRetry,
  sanitizeErrorClass,
} from "../observability/metrics/worker.metrics";

// T596: the drainer is the failure-decision point for outbox delivery. The
// `queue` label maps to "audit-fanout" — the only outbox-managed queue today
// — per the approved D2 decision. Adding "outbox-drainer" to
// WORKER_QUEUE_NAMES is deferred to a future slice.
const DRAINER_QUEUE_LABEL = "audit-fanout" as const;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_CLAIM_LEASE_MS = 60_000;
const CLAIM_HEARTBEAT_MS = 20_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DrainerOptions {
  /** How often to poll for claimable rows. Default: 1s. */
  readonly pollIntervalMs?: number;
  /** Max rows per claim batch. Default: 50. */
  readonly batchSize?: number;
  /** How long a claim may go without a heartbeat before recovery. Default: 60s. */
  readonly claimLeaseMs?: number;
}

/** Injected for testability — production omits. */
export interface DrainerDependencies {
  readonly pool: Pool;
  readonly registry: OutboxConsumerRegistry;
  readonly options?: DrainerOptions;
  /**
   * Override the claim function for unit tests (avoids real Postgres).
   * Production callers omit this; the default is `claimBatch` from `@data-pulse-2/db`.
   */
  readonly claimFn?: (pool: Pool, batchSize: number) => Promise<ClaimedOutboxEvent[]>;
}

// ---------------------------------------------------------------------------
// DrainerProcessor
// ---------------------------------------------------------------------------

/**
 * The outbox drainer. Not a NestJS injectable — wired explicitly in
 * OutboxModule's `useFactory` so the injected `Pool` and registry can be
 * swapped in tests without booting a full Nest DI graph.
 */
export class DrainerProcessor {
  private readonly pool: Pool;
  private readonly registry: OutboxConsumerRegistry;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly claimLimit: number;
  private readonly claimLeaseMs: number;
  private readonly claimFn: (pool: Pool, batchSize: number) => Promise<ClaimedOutboxEvent[]>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /**
   * Set to `true` for the duration of an in-progress `tick()` invocation
   * started by the poll-loop timer. When the interval fires while a previous
   * tick is still running we SKIP the new tick rather than start a concurrent
   * one. Calls to `tick()` made directly (e.g. from tests) are NOT gated by
   * this flag — only the timer-driven loop respects it.
   */
  private inFlight = false;

  constructor(deps: DrainerDependencies) {
    this.pool = deps.pool;
    this.registry = deps.registry;
    this.pollIntervalMs = deps.options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = deps.options?.batchSize ?? DEFAULT_BATCH_SIZE;
    const poolMax = (this.pool as Pool & { options?: { max?: number } }).options?.max ?? 10;
    if (!Number.isInteger(poolMax) || poolMax < 2) {
      throw new RangeError("outbox drainer requires a DB pool with at least 2 connections");
    }
    this.claimLimit = Math.min(this.batchSize, Math.floor(poolMax / 2));
    this.claimLeaseMs = deps.options?.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.claimFn = deps.claimFn ?? claimBatch;

    // Fail loud at construction rather than spinning a poll loop with a
    // nonsensical interval (which silently breaks throughput) or claim size
    // (which causes the claim CTE to reject `LIMIT <invalid>` at runtime,
    // logging on every tick). Both must be positive integers; `setInterval`
    // also requires a finite positive number, so a NaN/Infinity here would
    // produce subtly wrong scheduling.
    assertPositiveInteger("pollIntervalMs", this.pollIntervalMs);
    assertPositiveInteger("batchSize", this.batchSize);
    assertPositiveInteger("claimLeaseMs", this.claimLeaseMs);
  }

  /**
   * Start the poll loop. Idempotent: a second `start()` is a no-op.
   *
   * Concurrency
   * -----------
   * `setInterval` does not wait for the previous callback to finish before
   * firing the next one. Under load — where a single tick takes longer than
   * `pollIntervalMs` — that would let two ticks run concurrently, doubling
   * up on claim queries and racing on row state. The `inFlight` guard makes
   * the loop strictly sequential: a missed tick is skipped, never queued.
   * The next eligible tick fires at the next interval boundary after the
   * in-progress one finishes.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      if (this.inFlight) {
        // Previous tick still running — skip this interval rather than
        // overlap. Logging this would be noisy on slow ticks; instead the
        // operator should watch the drainer's tick-duration histogram (T-future).
        return;
      }
      this.inFlight = true;
      this.tick()
        .catch((err: unknown) => {
          this.logError("drainer.tick unhandled error", err);
        })
        .finally(() => {
          this.inFlight = false;
        });
    }, this.pollIntervalMs);
  }

  /**
   * Stop the poll loop. Idempotent: stopping before start or twice is tolerated.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  /**
   * One poll tick: claim a batch and process each event.
   * Exported as a seam for tests that want to drive individual ticks
   * without the setInterval timer.
   */
  async tick(): Promise<void> {
    const recovered = await reclaimStaleClaims(this.pool, this.claimLeaseMs, this.batchSize).catch((err: unknown) => {
      this.logError("drainer.reclaimStaleClaims failed", err);
      return { reclaimed: 0, deadLetteredEventTypes: [] as readonly string[] };
    });
    if (recovered.reclaimed > 0) {
      this.logError(`drainer.reclaimed stale claims count=${recovered.reclaimed}`, new Error("ClaimLeaseExpired"));
    }
    for (const eventType of recovered.deadLetteredEventTypes) {
      recordQueueDeadLetter({ queue: DRAINER_QUEUE_LABEL });
      recordOutboxDeadLetter({ event_type: eventType });
    }
    const batch = await this.claimFn(this.pool, this.claimLimit).catch((err: unknown) => {
      this.logError("drainer.claimBatch failed", err);
      return [] as ClaimedOutboxEvent[];
    });

    // Process rows concurrently within the batch. Each row gets its own
    // per-tenant context — they are independent and must not share a client.
    await Promise.all(batch.map((row) => this.processRow(row)));
  }

  // ---------------------------------------------------------------------------
  // Internal: per-row processing
  // ---------------------------------------------------------------------------

  private async processRow(row: ClaimedOutboxEvent): Promise<void> {
    // T595 (PR-B-1): per-row duration measurement for
    // outbox_drain_duration_seconds. Wall-clock from the start of the row's
    // processing to its terminal branch (success, retry, DLQ, or
    // no-consumer). Emitted in finally so every exit path is timed —
    // identical pattern to PR-A's worker_job_duration_seconds.
    const startNs = process.hrtime.bigint();
    let heartbeatInFlight = false;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      heartbeatClaim(this.pool, row.event_id, row.attempts)
        .then((renewed) => {
          if (!renewed) this.logError("drainer.claim lease lost", new Error("ClaimLeaseLost"));
        })
        .catch((err: unknown) => this.logError("drainer.heartbeatClaim failed", err))
        .finally(() => { heartbeatInFlight = false; });
    }, Math.min(CLAIM_HEARTBEAT_MS, Math.max(1, Math.floor(this.claimLeaseMs / 3))));
    heartbeat.unref();
    try {
      const consumer = this.registry.resolve(row.event_type);

      if (!consumer) {
        // No consumer registered for this event type. Mark failed with backoff
        // rather than dead-lettering immediately — allows operator investigation.
        const errorClass = "UnroutableEventType";
        this.logError(
          `drainer: no consumer for event_type="${row.event_type}" event_id="${row.event_id}"`,
          new Error(errorClass),
        );
        // T596: emit BEFORE persistence (D4) so the metric reflects the
        // drainer's decision regardless of whether `safeMarkFailed` succeeds.
        // `error_class` runs through sanitizeErrorClass — "UnroutableEventType"
        // is not in WORKER_ERROR_CLASSES and will coerce to "UnknownError"
        // per the approved D3 decision.
        const sanitizedClass = sanitizeErrorClass(errorClass);
        recordQueueFailed({ queue: DRAINER_QUEUE_LABEL, error_class: sanitizedClass });
        recordQueueRetry({ queue: DRAINER_QUEUE_LABEL });
        await this.safeMarkFailed(row.event_id, row.attempts, errorClass);
        return;
      }

      try {
        await this.invokeConsumer(consumer, row);
        await this.safeMarkDelivered(row.event_id, row.attempts);
      } catch (err: unknown) {
        const errorClass = this.extractErrorClass(err);
        // T596: emit BEFORE persistence (D4). queue_failed_total always fires
        // on a consumer throw; queue_retry_total vs queue_dead_letter_total
        // mirrors the existing retry-budget branch.
        const sanitizedClass = sanitizeErrorClass(errorClass);
        recordQueueFailed({ queue: DRAINER_QUEUE_LABEL, error_class: sanitizedClass });

        if (row.attempts >= MAX_ATTEMPTS) {
          // Budget exhausted — dead-letter.
          recordQueueDeadLetter({ queue: DRAINER_QUEUE_LABEL });
          // T595 (PR-B-1): outbox_dead_letter_total carries event_type, not
          // queue. Emitted BEFORE persistence (D4 ordering) so the metric
          // reflects the drainer's decision regardless of safeMark outcome.
          recordOutboxDeadLetter({ event_type: row.event_type });
          await this.safeMarkDeadLettered(row.event_id, row.attempts, errorClass);
        } else {
          recordQueueRetry({ queue: DRAINER_QUEUE_LABEL });
          await this.safeMarkFailed(row.event_id, row.attempts, errorClass);
        }
      }
    } finally {
      clearInterval(heartbeat);
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1_000_000_000;
      recordOutboxDrainDuration({ event_type: row.event_type }, durationSeconds);
    }
  }

  /** Pass the tenant-scoped envelope; consumers open their own DB context. */
  private async invokeConsumer(
    consumer: OutboxConsumer<unknown>,
    row: ClaimedOutboxEvent,
  ): Promise<void> {
    await consumer.handle({
      event_id: row.event_id,
      event_type: row.event_type,
      tenant_id: row.tenant_id,
      store_id: row.store_id,
      payload: row.payload,
      correlation_id: row.correlation_id,
      occurred_at: row.occurred_at,
      attempts: row.attempts,
    });
  }

  // ---------------------------------------------------------------------------
  // Safe wrappers — state-machine transition failures must not crash the drainer
  // ---------------------------------------------------------------------------

  private async safeMarkDelivered(eventId: string, attempts: number): Promise<void> {
    try {
      await markDelivered(this.pool, eventId, attempts);
    } catch (err: unknown) {
      this.logError(`drainer.markDelivered failed event_id="${eventId}"`, err);
    }
  }

  private async safeMarkFailed(
    eventId: string,
    attempts: number,
    errorClass: string,
  ): Promise<void> {
    try {
      await markFailed(this.pool, eventId, attempts, errorClass);
    } catch (err: unknown) {
      this.logError(`drainer.markFailed failed event_id="${eventId}"`, err);
    }
  }

  private async safeMarkDeadLettered(
    eventId: string,
    attempts: number,
    errorClass: string,
  ): Promise<void> {
    try {
      await markDeadLettered(this.pool, eventId, errorClass, attempts);
    } catch (err: unknown) {
      this.logError(`drainer.markDeadLettered failed event_id="${eventId}"`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Logging (structured, pino-compatible, no PII / no payload)
  // ---------------------------------------------------------------------------

  /**
   * Emit a structured error line. ONLY safe, redacted fields are written:
   *   - `level`, `component`, `message`  — operator-controlled
   *   - `errorName`                       — the error class name
   *                                         (e.g. `OutboxStateTransitionError`)
   *
   * `err.message` and `err.stack` are intentionally OMITTED. Postgres and
   * many other libraries embed row values, parameter contents, and other
   * sensitive runtime data in their error messages (e.g. the `payload`
   * JSONB or a tenant UUID surface in `invalid input syntax for type uuid:
   * "<value>"`). Stack traces additionally leak file paths and call-graph
   * shape. Constitution §VII forbids both in structured logs.
   *
   * The `message` argument is constructed by the caller and MUST itself
   * be safe (event_id and event_type are non-PII by design). If a caller
   * ever needs the underlying exception for debugging, route it through
   * the OTel/error-reporting boundary (which has its own redaction policy)
   * rather than stderr.
   */
  private logError(message: string, err: unknown): void {
    const line = JSON.stringify({
      level: "error",
      component: "outbox.drainer",
      message,
      errorName: err instanceof Error ? (err.name || "Error") : "UnknownError",
    });
    process.stderr.write(line + "\n");
  }

  private extractErrorClass(err: unknown): string {
    if (err instanceof Error) {
      // Use the error's class name as the redacted error class.
      // Never include the message (which may contain payload data or PII).
      return err.name || "Error";
    }
    return "UnknownError";
  }
}

// ---------------------------------------------------------------------------
// Internal: input validation
// ---------------------------------------------------------------------------

/**
 * Assert that a numeric drainer-config field is a finite positive integer.
 * `setInterval` accepts NaN / Infinity / 0 without obvious failure (it
 * coerces to 1ms or hangs), and `LIMIT <non-positive>` in the claim CTE
 * either rejects at parse time or returns no rows — both produce silently
 * broken drainers. Fail loud at construction instead.
 */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `DrainerProcessor: ${field} must be a positive integer, got ${String(value)}.`,
    );
  }
}
