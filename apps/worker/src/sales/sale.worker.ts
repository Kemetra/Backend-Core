/**
 * SaleWorker — 008 WIRING slice.
 *
 * Thin BullMQ glue, structurally identical to `AuditWorker` / `EmailWorker`.
 * Knows two things and only two things:
 *   1. The queue name (`"sale-processing"`).
 *   2. How to delegate each job's envelope to the injected
 *      `SaleProcessingProcessor` from `sale-processing.processor.ts`.
 *
 * Why this slice exists (the functional gap it closes)
 * ----------------------------------------------------
 * `SaleProcessingProcessor` (the Layer-A off-request processor) was merged
 * without a BullMQ `Worker` bootstrap or `worker.module.ts` registration — the
 * processor's own docstring flags this as a KNOWN GAP deferred to "a future
 * worker wiring slice". This is that slice. Without it the worker process
 * cannot consume sale-processing jobs at all.
 *
 * Queue name — DEFINED here, not pinned to a producer (yet)
 * ---------------------------------------------------------
 * `AuditWorker.AUDIT_QUEUE_NAME` mirrors an existing API-side producer
 * constant. There is NO sale-processing producer yet: the enqueue (outbox →
 * queue) half is a SEPARATE, currently-deferred slice. `SalesService` emits a
 * `sale.captured` outbox event, but (a) `SALES_OUTBOX_PRODUCER` is not bound in
 * `SalesModule` and (b) `sale.captured` is not in `OUTBOX_EVENT_TYPES` (which
 * holds only `audit.event.created`). Wiring that half touches `apps/api/src/**`
 * and the gated `packages/db` registry — out of scope here.
 *
 * Therefore `SALE_PROCESSING_QUEUE_NAME` is the canonical literal this worker
 * consumes; the future enqueue side MUST match this string. A cross-app pin
 * test (mirroring `audit.worker.spec.ts`'s `AUDIT_QUEUE_NAME` pin) can be added
 * once a producer constant exists to pin against.
 *
 * Handler shape — differs from AuditWorker
 * -----------------------------------------
 * `AuditFanoutProcessor.process(jobName, data)` takes `(name, data)`.
 * `SaleProcessingProcessor.process(job)` takes the ENVELOPE
 * (`SaleProcessingJob` = `{ saleId, tenantId, storeId, correlationId? }`) and
 * returns a `SaleProcessingResult`. The handler therefore forwards
 * `job.data` (cast to the envelope) and discards the result to satisfy the
 * shared `JobLike → Promise<void>` handler contract. The processor's own
 * `assertJob` is the validation boundary (the audit analogue is its Zod
 * schema) — the worker does NOT re-validate.
 *
 * Tenant context (§II / §V)
 * -------------------------
 * The worker establishes NO tenant context itself — the processor owns that
 * via `runWithTenantContext` before any tenant-scoped DB access. This wrapper
 * must not bypass or pre-empt it; it only delegates.
 *
 * Why a `WorkerFactory` instead of `new Worker(...)` here?
 * --------------------------------------------------------
 * Same idiom as Email/Audit: tests inject a `FakeWorkerFactory` to capture the
 * registered handler + options with no Redis/BullMQ; production injects the
 * shared `BullMqWorkerFactory`.
 *
 * Lifecycle — self-starting (controlled divergence from AuditWorker)
 * ------------------------------------------------------------------
 *   - `onModuleInit()` calls `start()`. This is the ONE deliberate divergence
 *     from `AuditWorker`: `EmailWorker` / `AuditWorker` are started imperatively
 *     by `apps/worker/src/main.ts` (`emailWorker.start()` / `auditWorker.start()`),
 *     but `main.ts` is outside this slice's allowed files. Self-starting via
 *     `OnModuleInit` is the in-scope way to make the wiring genuinely functional
 *     (registration alone would never consume a job — Nest never calls a custom
 *     `start()`). The precedent is `OutboxDrainerRunner.onModuleInit()`, which
 *     starts its loop the same way. In dev / test the shared `WORKER_FACTORY`
 *     resolves to `NoOpWorkerFactory`, so auto-start is a harmless no-op (no
 *     Redis, no job consumption).
 *   - `start()` constructs the underlying worker via the factory, forwards
 *     `DEFAULT_WORKER_OPTIONS`, and subscribes to `"error"` for diagnostic
 *     logging only. Idempotent (second `start()` is a no-op).
 *   - `close()` shuts the worker down cleanly; tolerated before `start()` and
 *     idempotent. Wired to `onModuleDestroy`.
 */
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { DEFAULT_WORKER_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import {
  SaleProcessingProcessor,
  type SaleProcessingJob,
} from "./sale-processing.processor";
import {
  type JobLike,
  type WorkerFactory,
  type WorkerLike,
} from "../email/email.worker";
import { QUEUE_NAMES } from "@data-pulse-2/shared";

/**
 * The BullMQ queue name this worker consumes. DEFINED here (no producer to
 * mirror yet — see file docstring). The future enqueue side MUST use the same
 * literal. The queue name is the transport channel; a job-name string is NOT
 * pinned here — the envelope shape (`SaleProcessingJob`) is the contract.
 */
export const SALE_PROCESSING_QUEUE_NAME = QUEUE_NAMES.saleProcessing;

/**
 * Re-export the shared job-handler / job-like shapes from `email.worker` so the
 * sale worker does not define a parallel set — same `{ name, data }` `JobLike`
 * both other workers consume.
 */
export type { JobLike, WorkerFactory, WorkerLike } from "../email/email.worker";
export { WORKER_FACTORY } from "../email/email.worker";

@Injectable()
export class SaleWorker implements OnModuleDestroy {
  private worker: WorkerLike | null = null;

  constructor(
    private readonly processor: SaleProcessingProcessor,
    private readonly workerFactory: WorkerFactory,
  ) {}

  /**
   * Registered-but-NOT-self-started, by design — the precedent is
   * `AuditRetentionWorker` (registered in WorkerModule, started elsewhere), NOT
   * `OutboxDrainerRunner` (which self-starts because it has a live feed).
   *
   * The sale-processing queue has NO producer yet: `SalesService` emits a
   * `sale.captured` event but `SALES_OUTBOX_PRODUCER` is unbound and
   * `sale.captured` is not in the (gated) `OUTBOX_EVENT_TYPES`. So a
   * self-started worker would just open a Redis connection and poll an empty
   * queue in every environment that loads `WorkerModule`. The enqueue side +
   * the imperative `saleWorker.start()` in `main.ts` (mirroring `EmailWorker` /
   * `AuditWorker`) land together in the gated enqueue-wiring slice, so the whole
   * live capture→process loop becomes functional in one consistent place.
   *
   * `start()` / `close()` remain fully implemented and tested so that slice only
   * has to add the `main.ts` call + the producer binding.
   */

  /**
   * Constructs the BullMQ worker and starts consuming. Idempotent: a second
   * `start()` is a no-op. `DEFAULT_WORKER_OPTIONS` from `@data-pulse-2/shared`
   * (concurrency, lockDuration, stalled-job tuning) are forwarded unchanged.
   *
   * The handler forwards `job.data` (the `SaleProcessingJob` envelope) to the
   * processor and discards the returned `SaleProcessingResult` — the shared
   * handler contract is `Promise<void>`. The processor's `assertJob` owns
   * envelope validation and throws on a malformed id, which propagates so
   * BullMQ can apply its retry / DLQ policy.
   */
  start(): void {
    if (this.worker !== null) return;
    this.worker = this.workerFactory.create(
      SALE_PROCESSING_QUEUE_NAME,
      async (job: JobLike): Promise<void> => {
        await this.processor.process(job.data as SaleProcessingJob);
      },
      DEFAULT_WORKER_OPTIONS,
    );
    this.worker.on("error", (err) => {
      // Diagnostic only. The shared defaults own retry/DLQ. Stderr line is
      // structured JSON carrying only the error name/message — NO sale row,
      // line amounts, or payload (FR-042 / FR-092).
      const line = JSON.stringify({
        level: "error",
        component: "sale.worker",
        message: err.message,
        name: err.name,
      });
      process.stderr.write(line + "\n");
    });
  }

  /**
   * Shuts the worker down cleanly. Idempotent: closing before `start()` or
   * twice in a row is tolerated.
   */
  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w !== null) {
      await w.close();
    }
  }

  /** Nest lifecycle hook — fires on `app.close()` from `main.ts`. */
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
