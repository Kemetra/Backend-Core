/**
 * BullMQ default options — shared single source of truth (T092 + T301-partial).
 *
 * Originally landed in `apps/worker/src/queues/queue.config.ts` (PR #17 / T092).
 * This file is the relocated home: cross-cutting policy that both the
 * producer (`apps/api`) and the worker (`apps/worker`) consume must
 * not be re-declared per app, otherwise the two sides drift silently.
 *
 * Why types are structural (no `import type` from `bullmq`)
 * --------------------------------------------------------
 * `packages/shared` deliberately does NOT depend on `bullmq`. Pulling
 * BullMQ's type universe into `shared` would force every consumer of
 * `shared` (including the api, which already has bullmq) to drag the
 * whole BullMQ surface into its build graph just to read a static
 * options bag. We instead publish small structural interfaces that
 * are byte-compatible with the BullMQ shapes we care about; consumers
 * cast or spread the object into BullMQ's `JobsOptions` / `WorkerOptions`
 * at the call site. TypeScript's structural typing makes this safe at
 * compile time.
 *
 * On "DLQ"
 * --------
 * BullMQ has no separate dead-letter queue. Jobs that exhaust
 * `attempts` land in the failed-jobs Redis set with full retry
 * history. The "DLQ defaults" referenced in T092/T301 are the
 * *retention policy* for that set — `removeOnFail` below.
 *
 * On idempotency
 * --------------
 * Every consumer handler in this codebase is required to be idempotent
 * because BullMQ retries can re-deliver a job. The producer
 * (`apps/api/src/auth/email-queue.producer.ts`) sets `jobId` from a
 * deterministic hash; the processor (`apps/worker/src/email/email.processor.ts`)
 * revalidates payloads. These defaults assume that contract.
 *
 * Tunings
 * -------
 * Numbers reflect "transactional infrastructure" traffic patterns: low
 * job rate, low cost-per-retry, must-not-lose-jobs. Per-queue overrides
 * (e.g., higher concurrency for audit-fanout) belong to the queue's
 * own wiring slice, not here.
 */

/**
 * Structural shape of BullMQ's `JobsOptions` — only the fields we set.
 * Compatible by name/shape with `JobsOptions` from `bullmq`; the api's
 * `auth.module.ts` spreads this object into `new Queue(name, {
 * defaultJobOptions, ... })` and tsc verifies the assignment.
 */
export interface DefaultJobOptionsShape {
  readonly attempts: number;
  readonly backoff: {
    readonly type: "exponential" | "fixed";
    readonly delay: number;
  };
  readonly removeOnComplete: {
    readonly age: number;
    readonly count: number;
  };
  readonly removeOnFail: {
    readonly age: number;
    readonly count: number;
  };
}

/**
 * Structural shape of the BullMQ `WorkerOptions` subset we care about.
 * Spread into `new Worker(name, handler, { connection, ...DEFAULT_WORKER_OPTIONS })`.
 */
export interface DefaultWorkerOptionsShape {
  readonly concurrency: number;
  readonly lockDuration: number;
  readonly stalledInterval: number;
  readonly maxStalledCount: number;
}

/**
 * Default per-job options. Applied at the producer side via
 * `new Queue(name, { defaultJobOptions: DEFAULT_JOB_OPTIONS, ... })`.
 *
 * Sequence: 1 initial attempt + 4 retries at 1s, 2s, 4s, 8s
 * (exponential, base 1000ms). Total wait ≈ 15s before a job lands in
 * the failed set; long enough for transient Redis blips, short enough
 * that a poison message is visible within a minute.
 */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptionsShape = deepFreeze({
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 1_000,
  },
  removeOnComplete: {
    age: 24 * 3600, // 24h — keep successful jobs visible for support tickets
    count: 1_000, // cap on retained successful jobs (oldest dropped first)
  },
  removeOnFail: {
    age: 7 * 24 * 3600, // 7d — failed-set retention; this IS the DLQ
    count: 10_000, // higher cap than completed: failures are forensic record
  },
});

/**
 * Default worker-side options. Applied at every `new Worker(name, h, opts)`
 * via `BullMqWorkerFactory` in `apps/worker/src/worker.module.ts`.
 */
export const DEFAULT_WORKER_OPTIONS: DefaultWorkerOptionsShape = deepFreeze({
  concurrency: 4, // 4 in-flight jobs per worker process; conservative default
  lockDuration: 30_000, // 30s — handlers must finish or extend within this
  stalledInterval: 30_000, // 30s — how often the worker checks for stalled jobs
  maxStalledCount: 1, // a stalled job gets one re-pickup before failing
});

/**
 * Recursively `Object.freeze` an object and any plain-object children.
 * Cheap runtime safety belt: TypeScript's `Readonly<>` is structural
 * only and lets `(opts as DefaultJobOptionsShape).attempts = 1` slip
 * through. This makes such a mutation throw in strict mode and silently
 * no-op in sloppy mode — either way the bug is loud.
 *
 * Exported for the spec; not consumed by production code.
 */
export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) {
    return obj;
  }
  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

/**
 * BullMQ queue names — the single source of truth (RT-125).
 *
 * Every producer (`apps/api`), consumer (`apps/worker`) and the worker's
 * `queue_lag_seconds` gauge reads these, so a queue cannot be renamed on one
 * side only. Values are wire identity (Redis keys): never change one without
 * draining the old queue first.
 */
export const QUEUE_NAMES = deepFreeze({
  email: "email",
  audit: "audit",
  auditRetention: "audit-retention",
  saleProcessing: "sale-processing",
  outboxRetention: "outbox-retention",
  // RT-179: the scheduled ERPNext stock reconciliation run sweep.
  erpnextStockReconciliationSweep: "erpnext-stock-reconciliation-sweep",
  // RT-209: the periodic purge of expired cashier-admission replay rows.
  cashierAdmissionReplayPurge: "cashier-admission-replay-purge",
} as const);

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
