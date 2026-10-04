/**
 * RT-179 — BullMQ glue for the scheduled stock reconciliation run sweep.
 *
 * Mirrors `AuditRetentionWorker`: consumes the
 * `erpnext-stock-reconciliation-sweep` queue, whose only job is the repeatable
 * sweep registered by `StockRunSweepScheduler`, and hands each job to
 * `StockRunSweepProcessor`. Started by `bootstrap()` in main.ts; closed by
 * Nest's `onModuleDestroy` on shutdown.
 */
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { QUEUE_NAMES } from "@data-pulse-2/shared";
import { DEFAULT_WORKER_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import {
  type JobLike,
  type WorkerFactory,
  type WorkerLike,
  WORKER_FACTORY,
} from "../email/email.worker";
import { StockRunSweepProcessor } from "./stock-run-sweep.processor";

export const STOCK_RUN_SWEEP_QUEUE_NAME = QUEUE_NAMES.erpnextStockReconciliationSweep;

@Injectable()
export class StockRunSweepWorker implements OnModuleDestroy {
  private worker: WorkerLike | null = null;

  constructor(
    private readonly processor: StockRunSweepProcessor,
    @Inject(WORKER_FACTORY)
    private readonly workerFactory: WorkerFactory,
  ) {}

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
      process.stderr.write(
        JSON.stringify({
          level: "error",
          component: "erpnext-reconciliation.stock-run-sweep.worker",
          message: err.message,
          name: err.name,
        }) + "\n",
      );
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
