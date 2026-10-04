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
import { Queue, type JobsOptions } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

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
    // Retries: the processor fails the job with StockRunSweepIncompleteError
    // when a tenant fails, so BullMQ must retry it. Without attempts/backoff
    // the job runs once and the failed tenants wait a whole period. The shared
    // DEFAULT_JOB_OPTIONS (5 attempts, exponential from 1 s, ~15 s in total)
    // go on the queue AND on the scheduler's job template, so every generated
    // job carries them. The whole retry window is far shorter than the 5-minute
    // minimum interval, and each store's advisory lock plus the running /
    // same-period checks make a retry that overlaps the next tick a no-op.
    const jobOptions = DEFAULT_JOB_OPTIONS as JobsOptions;
    this.queue = new Queue(STOCK_RUN_SWEEP_QUEUE_NAME, {
      connection: { url },
      defaultJobOptions: jobOptions,
    });
    await this.queue.upsertJobScheduler(
      STOCK_RUN_SWEEP_JOB_NAME,
      { every },
      { name: STOCK_RUN_SWEEP_JOB_NAME, data: {}, opts: jobOptions },
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
