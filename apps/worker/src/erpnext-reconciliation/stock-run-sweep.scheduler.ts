/**
 * RT-179 — registers the repeatable stock reconciliation run sweep.
 *
 * Mirrors `AuditRetentionScheduler`: `Queue.upsertJobScheduler` is idempotent
 * per scheduler id, so every worker boot (and every replica) converges on ONE
 * schedule in Redis. The cadence is `ERPNEXT_STOCK_RECONCILIATION_SWEEP_INTERVAL_MS`
 * (default daily, see stock-run-sweep.config.ts); changing it and restarting
 * the worker updates the existing schedule in place.
 *
 * REDIS_URL policy (same as the retention schedulers):
 *   - production + no REDIS_URL → throw at boot;
 *   - non-production + no REDIS_URL → no-op;
 *   - REDIS_URL present → register the scheduler.
 */
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";

import { resolveStockRunSweepIntervalMs } from "./stock-run-sweep.config";
import { STOCK_RUN_SWEEP_JOB_NAME } from "./stock-run-sweep.processor";
import { STOCK_RUN_SWEEP_QUEUE_NAME } from "./stock-run-sweep.worker";

@Injectable()
export class StockRunSweepScheduler implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;

  async onModuleInit(): Promise<void> {
    // Resolve first: an invalid interval refuses boot even without Redis.
    const every = resolveStockRunSweepIntervalMs();
    const url = process.env["REDIS_URL"];
    if (!url) {
      if (process.env["NODE_ENV"] === "production") {
        throw new Error(
          "StockRunSweepScheduler: REDIS_URL is required in production " +
            "(cannot schedule the stock reconciliation sweep without Redis).",
        );
      }
      return;
    }
    this.queue = new Queue(STOCK_RUN_SWEEP_QUEUE_NAME, { connection: { url } });
    await this.queue.upsertJobScheduler(
      STOCK_RUN_SWEEP_JOB_NAME,
      { every },
      { name: STOCK_RUN_SWEEP_JOB_NAME, data: {} },
    );
  }

  async onModuleDestroy(): Promise<void> {
    const q = this.queue;
    this.queue = null;
    if (q !== null) {
      await q.close();
    }
  }
}
