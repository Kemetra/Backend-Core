/**
 * RT-209 — BullMQ glue for the cashier-admission replay purge.
 *
 * Mirrors `StockRunSweepWorker`: consumes the `cashier-admission-replay-purge`
 * queue, whose only job is the repeatable purge registered by
 * `ReplayPurgeScheduler`, and hands each job to `ReplayPurgeProcessor`.
 * Started by `bootstrap()` in main.ts; closed by Nest's `onModuleDestroy` on
 * shutdown.
 *
 * Worker-level errors go through the shared pino logger (`createLogger`, with
 * the repo redaction paths) carrying the error CLASS only. A BullMQ / Redis
 * error message can embed a connection string or credential, so it is never
 * logged (§VII / §XIV).
 */
import { Inject, Injectable, Optional, type OnModuleDestroy } from "@nestjs/common";
import { createLogger, QUEUE_NAMES, type Logger } from "@data-pulse-2/shared";
import { DEFAULT_WORKER_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import {
  type JobLike,
  type WorkerFactory,
  type WorkerLike,
  WORKER_FACTORY,
} from "../email/email.worker";
import { errorClassName } from "../erpnext-reconciliation/stock-run-sweep.processor";
import { ReplayPurgeProcessor } from "./replay-purge.processor";

export const REPLAY_PURGE_QUEUE_NAME = QUEUE_NAMES.cashierAdmissionReplayPurge;

const COMPONENT = "cashier-admissions.replay-purge.worker";

/** DI token for an injected logger (tests); production uses the shared pino logger. */
export const REPLAY_PURGE_WORKER_LOGGER = "REPLAY_PURGE_WORKER_LOGGER";

export type ReplayPurgeWorkerLogger = Pick<Logger, "error">;

function defaultLogger(): ReplayPurgeWorkerLogger {
  return createLogger({ service: "worker", bindings: { component: COMPONENT } });
}

@Injectable()
export class ReplayPurgeWorker implements OnModuleDestroy {
  private worker: WorkerLike | null = null;
  private readonly logger: ReplayPurgeWorkerLogger;

  constructor(
    private readonly processor: ReplayPurgeProcessor,
    @Inject(WORKER_FACTORY)
    private readonly workerFactory: WorkerFactory,
    @Optional()
    @Inject(REPLAY_PURGE_WORKER_LOGGER)
    logger?: ReplayPurgeWorkerLogger,
  ) {
    this.logger = logger ?? defaultLogger();
  }

  start(): void {
    if (this.worker !== null) return;
    this.worker = this.workerFactory.create(
      REPLAY_PURGE_QUEUE_NAME,
      async (job: JobLike) => {
        await this.processor.process(job.name, job.data);
      },
      DEFAULT_WORKER_OPTIONS,
    );
    this.worker.on("error", (err) => {
      this.logger.error({ component: COMPONENT, errorName: errorClassName(err) }, "worker_error");
    });
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w !== null) {
      await w.close();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
