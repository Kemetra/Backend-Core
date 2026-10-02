/**
 * AuditWorker — PR-D wiring slice.
 *
 * Thin BullMQ glue, structurally identical to `EmailWorker`. Knows two
 * things and only two things:
 *   1. The queue name (`"audit"`, mirroring `AUDIT_QUEUE_NAME` in
 *      `apps/api/src/audit/audit-queue.producer.ts`).
 *   2. How to delegate `(job.name, job.data)` to the injected
 *      `AuditFanoutProcessor` from `audit-fanout.processor.ts`.
 *
 * Queue-name vs job-name
 * ----------------------
 * The BullMQ *queue name* is the transport channel — `"audit"`. A queue
 * may carry multiple *job-name* message types over time. The current
 * (and only) job name is `"audit-fanout"`, validated downstream by
 * `AuditFanoutProcessor.process` (it throws `UnknownAuditJobError` for
 * any other name). This worker forwards `job.name` verbatim and
 * deliberately does NOT pin the job-name string here — that pin lives
 * in `audit-fanout.processor.ts` and its spec.
 *
 * Why a `WorkerFactory` instead of constructing `new Worker(...)` here?
 * --------------------------------------------------------------------
 *   - Tests can inject a `FakeWorkerFactory` and capture the registered
 *     handler + options without booting Redis or BullMQ.
 *   - Production wiring (`worker.module.ts`) injects the same
 *     `BullMqWorkerFactory` used by `EmailWorker`. The factory is
 *     queue-name-agnostic — `create(queueName, handler, options)`.
 *   - One repo idiom: same `*Like`-interface pattern PR #14
 *     (`QueueLike`), PR #15 (`RecordingEmailAdapter`), and `EmailWorker`
 *     already use.
 *
 * Lifecycle
 * ---------
 *   - `start()` constructs the underlying worker via the factory,
 *     passing `DEFAULT_WORKER_OPTIONS` from shared, and subscribes to
 *     its `"error"` event for diagnostic logging only.
 *   - `close()` shuts the worker down cleanly (drains in-flight jobs).
 *     Called by Nest's `onModuleDestroy` hook, which `main.ts` triggers
 *     on SIGTERM / SIGINT via `app.close()`.
 *
 * Idempotent: calling `start()` twice or `close()` before `start()` is
 * tolerated; the spec pins both behaviours.
 */
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
} from "@nestjs/common";
import {
  DEFAULT_WORKER_OPTIONS,
} from "@data-pulse-2/shared/queues/queue-config";

import { AuditFanoutProcessor } from "./audit-fanout.processor";
import {
  type EmailJobHandler as JobHandler,
  type JobLike,
  type WorkerFactory,
  type WorkerLike,
  WORKER_FACTORY,
} from "../email/email.worker";
import { QUEUE_NAMES } from "@data-pulse-2/shared";

/**
 * The queue name shared with the API-side `AuditQueueProducer`. Mirrors
 * `AUDIT_QUEUE_NAME` in `apps/api/src/audit/audit-queue.producer.ts`.
 *
 * The literal MUST equal the producer's literal; the spec pins the
 * string so any future drift fails CI loudly. We deliberately do NOT
 * import from `apps/api` — apps must not depend on each other.
 *
 * NOTE: The queue name (`"audit"`) is intentionally distinct from the
 * job name (`"audit-fanout"`, owned by `AuditFanoutProcessor`). One
 * queue can carry many job names; only `"audit-fanout"` is currently
 * defined.
 */
export const AUDIT_QUEUE_NAME = QUEUE_NAMES.audit;

/**
 * Re-export the shared job-handler / job-like shapes from `email.worker`
 * so the audit worker doesn't define a parallel set. Both workers
 * consume the same minimal `JobLike` shape — `{ name, data }`.
 */
export type { JobLike, WorkerFactory, WorkerLike } from "../email/email.worker";
export { WORKER_FACTORY } from "../email/email.worker";
export type AuditJobHandler = JobHandler;

@Injectable()
export class AuditWorker implements OnModuleDestroy {
  private worker: WorkerLike | null = null;

  constructor(
    private readonly processor: AuditFanoutProcessor,
    @Inject(WORKER_FACTORY)
    private readonly workerFactory: WorkerFactory,
  ) {}

  /**
   * Constructs the BullMQ worker and starts consuming. Idempotent:
   * a second `start()` is a no-op. The `DEFAULT_WORKER_OPTIONS` from
   * `@data-pulse-2/shared` (concurrency, lockDuration, stalledInterval,
   * maxStalledCount) are forwarded to the underlying worker.
   *
   * The handler forwards `(job.name, job.data)` verbatim — it does NOT
   * validate the job name. `AuditFanoutProcessor.process` owns that
   * validation and throws `UnknownAuditJobError` on mismatch.
   */
  start(): void {
    if (this.worker !== null) return;
    this.worker = this.workerFactory.create(
      AUDIT_QUEUE_NAME,
      (job: JobLike) => this.processor.process(job.name, job.data),
      DEFAULT_WORKER_OPTIONS,
    );
    this.worker.on("error", (err) => {
      // Diagnostic only. The defaults read from shared own retry/DLQ.
      // Stderr is structured-ish JSON without PII.
      const line = JSON.stringify({
        level: "error",
        component: "audit.worker",
        message: err.message,
        name: err.name,
      });
      process.stderr.write(line + "\n");
    });
  }

  /**
   * Shuts the worker down cleanly. Idempotent: closing before start or
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
