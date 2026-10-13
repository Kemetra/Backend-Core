/**
 * RT-457 — BullMQ glue for the scheduled sale re-drive sweep.
 *
 * Mirrors `StockRunSweepWorker`: consumes the `sale-redrive` queue, whose only
 * job is the repeatable sweep registered by `SaleRedriveScheduler`, and hands
 * each job to `SaleRedriveProcessor`. Started by `bootstrap()` in main.ts;
 * closed by Nest's `onModuleDestroy` on shutdown.
 *
 * Worker-level errors are logged with the error CLASS only: a BullMQ / Redis
 * message can embed a connection string or credential (§VII / §XIV).
 */
import { Inject, Injectable, Optional, type OnModuleDestroy } from "@nestjs/common";
import { createLogger, QUEUE_NAMES, type Logger } from "@data-pulse-2/shared";
import { DEFAULT_WORKER_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import { type JobLike, type WorkerFactory, type WorkerLike, WORKER_FACTORY } from "../email/email.worker";
import { errorClassName } from "../erpnext-reconciliation/stock-run-sweep.processor";
import { SaleRedriveProcessor } from "./sale-redrive.processor";

export const SALE_REDRIVE_QUEUE_NAME = QUEUE_NAMES.saleRedrive;

const COMPONENT = "sales.sale-redrive.worker";

/** DI token for an injected logger (tests); production uses the shared pino logger. */
export const SALE_REDRIVE_WORKER_LOGGER = "SALE_REDRIVE_WORKER_LOGGER";

export type SaleRedriveWorkerLogger = Pick<Logger, "error">;

@Injectable()
export class SaleRedriveWorker implements OnModuleDestroy {
  private worker: WorkerLike | null = null;
  private readonly logger: SaleRedriveWorkerLogger;

  constructor(
    private readonly processor: SaleRedriveProcessor,
    @Inject(WORKER_FACTORY)
    private readonly workerFactory: WorkerFactory,
    @Optional()
    @Inject(SALE_REDRIVE_WORKER_LOGGER)
    logger?: SaleRedriveWorkerLogger,
  ) {
    this.logger = logger ?? createLogger({ service: "worker", bindings: { component: COMPONENT } });
  }

  start(): void {
    if (this.worker !== null) return;
    this.worker = this.workerFactory.create(
      SALE_REDRIVE_QUEUE_NAME,
      async (job: JobLike) => {
        await this.processor.process(job.name, job.data);
      },
      DEFAULT_WORKER_OPTIONS,
    );
    this.worker.on("error", (err) => {
      this.logger.error({ component: COMPONENT, errorName: errorClassName(err) }, "worker_error");
    });
  }

  /** Nest lifecycle hook (app.close()); also callable directly. Idempotent. */
  async onModuleDestroy(): Promise<void> {
    const running = this.worker;
    this.worker = null;
    await running?.close();
  }
}
