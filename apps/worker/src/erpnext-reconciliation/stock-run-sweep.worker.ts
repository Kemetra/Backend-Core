/**
 * RT-179 — BullMQ glue for the scheduled stock reconciliation run sweep.
 *
 * Mirrors `AuditRetentionWorker`: consumes the
 * `erpnext-stock-reconciliation-sweep` queue, whose only job is the repeatable
 * sweep registered by `StockRunSweepScheduler`, and hands each job to
 * `StockRunSweepProcessor`. Started by `bootstrap()` in main.ts; closed by
 * Nest's `onModuleDestroy` on shutdown.
 *
 * Worker-level errors go through the shared pino logger (`createLogger`, with
 * the repo redaction paths) carrying the error CLASS only. A BullMQ / Redis
 * error message can embed a connection string or credential, so it is never
 * logged (§VII / §XIV, the outbox drainer's rule).
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
import { errorClassName, StockRunSweepProcessor } from "./stock-run-sweep.processor";

export const STOCK_RUN_SWEEP_QUEUE_NAME = QUEUE_NAMES.erpnextStockReconciliationSweep;

const COMPONENT = "erpnext-reconciliation.stock-run-sweep.worker";

/** DI token for an injected logger (tests); production uses the shared pino logger. */
export const STOCK_RUN_SWEEP_WORKER_LOGGER = "STOCK_RUN_SWEEP_WORKER_LOGGER";

export type StockRunSweepWorkerLogger = Pick<Logger, "error">;

function defaultLogger(): StockRunSweepWorkerLogger {
  return createLogger({ service: "worker", bindings: { component: COMPONENT } });
}

@Injectable()
export class StockRunSweepWorker implements OnModuleDestroy {
  private worker: WorkerLike | null = null;
  private readonly logger: StockRunSweepWorkerLogger;

  constructor(
    private readonly processor: StockRunSweepProcessor,
    @Inject(WORKER_FACTORY)
    private readonly workerFactory: WorkerFactory,
    @Optional()
    @Inject(STOCK_RUN_SWEEP_WORKER_LOGGER)
    logger?: StockRunSweepWorkerLogger,
  ) {
    this.logger = logger ?? defaultLogger();
  }

  start(): void {
    if (this.worker !== null) return;
    this.worker = this.workerFactory.create(
      STOCK_RUN_SWEEP_QUEUE_NAME,
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
