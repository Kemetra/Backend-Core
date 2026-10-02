/**
 * EmailWorker — slice 6 (T090) + T301-partial wiring.
 *
 * Thin BullMQ glue. Knows two things and only two things:
 *   1. The queue name (`"email"`, mirroring `apps/api/src/auth/auth.module.ts`).
 *   2. How to delegate `(job.name, job.data)` to the injected
 *      `EmailProcessor` from PR #15.
 *
 * Everything else — provider SDK selection (PQ-1), per-queue metrics —
 * lives in other slices. Retry/backoff/DLQ defaults are read from
 * `@data-pulse-2/shared/queues/queue-config` (single source of truth)
 * and forwarded to the underlying BullMQ worker via `WorkerFactory`.
 *
 * Why a `WorkerFactory` instead of constructing `new Worker(...)` here?
 * --------------------------------------------------------------------
 *   - Tests can inject a `FakeWorkerFactory` and capture the registered
 *     handler + options without booting Redis or BullMQ.
 *   - Production wiring (`worker.module.ts`) injects a
 *     `BullMqWorkerFactory` that builds the real BullMQ `Worker`.
 *   - Same `*Like`-interface pattern PR #14 (`QueueLike`) and PR #15
 *     (`RecordingEmailAdapter`) used. One repo idiom.
 *
 * Lifecycle
 * ---------
 *   - `start()` constructs the underlying worker via the factory,
 *     passing `DEFAULT_WORKER_OPTIONS` from shared, and subscribes to
 *     its `"error"` event for diagnostic logging only.
 *   - `close()` shuts the worker down cleanly (drains in-flight jobs).
 *     Called by Nest's `onModuleDestroy` hook, which `main.ts` triggers
 *     on SIGTERM / SIGINT.
 *
 * Idempotent: calling `start()` twice or `close()` before `start()` is
 * tolerated; the test pins both behaviours.
 */
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
} from "@nestjs/common";
import {
  DEFAULT_WORKER_OPTIONS,
  type DefaultWorkerOptionsShape,
} from "@data-pulse-2/shared/queues/queue-config";
import { EmailProcessor } from "./email.processor";
import { QUEUE_NAMES } from "@data-pulse-2/shared";

/**
 * The queue name shared with `EmailQueueProducer`. Mirrors
 * `EMAIL_QUEUE_NAME` in `apps/api/src/auth/auth.module.ts`.
 *
 * The literal MUST equal the producer's literal; a unit test pins
 * the string so any future drift fails CI loudly. We deliberately do
 * NOT import from `apps/api` — apps must not depend on each other.
 */
export const EMAIL_QUEUE_NAME = QUEUE_NAMES.email;

/**
 * The handler the BullMQ worker invokes for each job. We narrow to
 * just the two fields we use — the test fakes don't need to mock the
 * entire BullMQ `Job` type.
 */
export interface JobLike {
  readonly name: string;
  readonly data: unknown;
}

export type EmailJobHandler = (job: JobLike) => Promise<void>;

/**
 * Minimal surface our underlying worker exposes. Lets tests substitute
 * a `FakeWorker` without pulling in BullMQ's actual `Worker` class
 * (which would require Redis to construct).
 */
export interface WorkerLike {
  on(event: "error", listener: (err: Error) => void): unknown;
  close(): Promise<void>;
}

/**
 * Worker-side options forwarded to the underlying BullMQ Worker.
 * Structurally compatible with `DefaultWorkerOptionsShape` from shared.
 */
export type WorkerStartOptions = DefaultWorkerOptionsShape;

/**
 * Builds the underlying `WorkerLike` for a given (queueName, handler,
 * options). `options` are spread into `new Worker(name, handler,
 * { connection, ...options })`. Production: `BullMqWorkerFactory`
 * (`worker.module.ts`) constructs a real `bullmq.Worker`. Dev / test
 * without Redis: `NoOpWorkerFactory` returns a no-op worker.
 */
export interface WorkerFactory {
  create(
    queueName: string,
    handler: EmailJobHandler,
    options: WorkerStartOptions,
  ): WorkerLike;
}

export const WORKER_FACTORY = "WORKER_FACTORY";

@Injectable()
export class EmailWorker implements OnModuleDestroy {
  private worker: WorkerLike | null = null;

  constructor(
    private readonly processor: EmailProcessor,
    @Inject(WORKER_FACTORY)
    private readonly workerFactory: WorkerFactory,
  ) {}

  /**
   * Constructs the BullMQ worker and starts consuming. Idempotent:
   * a second `start()` is a no-op. The `DEFAULT_WORKER_OPTIONS` from
   * `@data-pulse-2/shared` (concurrency, lockDuration, stalledInterval,
   * maxStalledCount) are forwarded to the underlying worker.
   */
  start(): void {
    if (this.worker !== null) return;
    this.worker = this.workerFactory.create(
      EMAIL_QUEUE_NAME,
      (job) => this.processor.process(job.name, job.data),
      DEFAULT_WORKER_OPTIONS,
    );
    this.worker.on("error", (err) => {
      // Diagnostic only. The defaults read from shared own retry/DLQ.
      // Stderr is structured-ish JSON without PII.
      const line = JSON.stringify({
        level: "error",
        component: "email.worker",
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
