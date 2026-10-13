/**
 * RT-457 — registers the repeatable sale re-drive sweep.
 *
 * Mirrors `StockRunSweepScheduler`: `Queue.upsertJobScheduler` is idempotent
 * per scheduler id, so every worker boot (and every replica) converges on ONE
 * schedule in Redis, and each tick is a single job handled by one worker.
 * The cadence is `SALE_REDRIVE_INTERVAL_MS` (default 5 minutes).
 *
 * REDIS_URL policy (same as the other schedulers):
 *   - production + no REDIS_URL → throw at boot;
 *   - non-production + no REDIS_URL → no-op;
 *   - REDIS_URL present → register the scheduler.
 */
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, type JobsOptions } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import { resolveSaleRedriveIntervalMs } from "./sale-redrive.config";
import { SALE_REDRIVE_JOB_NAME } from "./sale-redrive.processor";
import { SALE_REDRIVE_QUEUE_NAME } from "./sale-redrive.worker";

@Injectable()
export class SaleRedriveScheduler implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;

  async onModuleInit(): Promise<void> {
    // Resolve first: an invalid interval refuses boot even without Redis.
    const every = resolveSaleRedriveIntervalMs();
    const url = redisUrlOrNull();
    if (url === null) return;
    // The processor fails the job with SaleRedriveIncompleteError when a sale
    // or tenant fails, so the shared retry options go on the queue and on the
    // scheduler's job template; a retry is a no-op for what already succeeded.
    const jobOptions = DEFAULT_JOB_OPTIONS as JobsOptions;
    this.queue = new Queue(SALE_REDRIVE_QUEUE_NAME, {
      connection: { url },
      defaultJobOptions: jobOptions,
    });
    await this.queue.upsertJobScheduler(
      SALE_REDRIVE_JOB_NAME,
      { every },
      { name: SALE_REDRIVE_JOB_NAME, data: {}, opts: jobOptions },
    );
  }

  async onModuleDestroy(): Promise<void> {
    const open = this.queue;
    this.queue = null;
    await open?.close();
  }
}

/** REDIS_URL, or null on a non-production host without Redis; production requires it. */
function redisUrlOrNull(): string | null {
  const url = process.env["REDIS_URL"];
  if (url) return url;
  if (process.env["NODE_ENV"] !== "production") return null;
  throw new Error(
    "SaleRedriveScheduler: REDIS_URL is required in production " +
      "(cannot schedule the sale re-drive sweep without Redis).",
  );
}
