/**
 * RT-664 — BullMQ glue for the AI usage reservation sweep (T17).
 *
 * Mirrors `StockRunSweepWorker`: consumes the `ai-usage-reservation-sweep`
 * queue, whose only job is the repeatable sweep registered by
 * `ReservationSweepScheduler`, and hands each job to `ReservationSweepProcessor`.
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
import { ReservationSweepProcessor } from "./reservation-sweep.processor";

export const RESERVATION_SWEEP_QUEUE_NAME = QUEUE_NAMES.aiUsageReservationSweep;

const COMPONENT = "ai-usage.reservation-sweep.worker";

/** DI token for an injected logger (tests); production uses the shared pino logger. */
export const RESERVATION_SWEEP_WORKER_LOGGER = "RESERVATION_SWEEP_WORKER_LOGGER";

export type ReservationSweepWorkerLogger = Pick<Logger, "error">;

function defaultLogger(): ReservationSweepWorkerLogger {
  return createLogger({ service: "backend-worker", bindings: { component: COMPONENT } });
}

@Injectable()
export class ReservationSweepWorker implements OnModuleDestroy {
  private worker: WorkerLike | null = null;
  private readonly logger: ReservationSweepWorkerLogger;

  constructor(
    private readonly processor: ReservationSweepProcessor,
    @Inject(WORKER_FACTORY)
    private readonly workerFactory: WorkerFactory,
    @Optional()
    @Inject(RESERVATION_SWEEP_WORKER_LOGGER)
    logger?: ReservationSweepWorkerLogger,
  ) {
    this.logger = logger ?? defaultLogger();
  }

  start(): void {
    if (this.worker !== null) return;
    this.worker = this.workerFactory.create(
      RESERVATION_SWEEP_QUEUE_NAME,
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
