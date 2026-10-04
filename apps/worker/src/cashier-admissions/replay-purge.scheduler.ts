/**
 * RT-209 — registers the repeatable cashier-admission replay purge.
 *
 * Mirrors the retention schedulers: `Queue.upsertJobScheduler` is idempotent
 * per scheduler id, so every worker boot (and every replica) converges on ONE
 * schedule in Redis. The cadence is `CASHIER_ADMISSION_REPLAY_PURGE_INTERVAL_MS`
 * (default hourly, see replay-purge.config.ts); changing it and restarting the
 * worker updates the existing schedule in place.
 *
 * Retries: the processor fails the job with `ReplayPurgeIncompleteError` when a
 * tenant fails, so the queue and the job template carry the shared
 * DEFAULT_JOB_OPTIONS (5 attempts, exponential backoff). A purge is
 * idempotent, so a retry that overlaps the next tick is harmless.
 *
 * REDIS_URL policy (same as the retention schedulers):
 *   - production + no REDIS_URL → throw at boot;
 *   - non-production + no REDIS_URL → no-op;
 *   - REDIS_URL present → register the scheduler.
 */
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, type JobsOptions } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import { resolveReplayPurgeIntervalMs } from "./replay-purge.config";
import { REPLAY_PURGE_JOB_NAME } from "./replay-purge.processor";
import { REPLAY_PURGE_QUEUE_NAME } from "./replay-purge.worker";

@Injectable()
export class ReplayPurgeScheduler implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;

  async onModuleInit(): Promise<void> {
    // Resolve first: an invalid interval refuses boot even without Redis.
    const every = resolveReplayPurgeIntervalMs();
    const url = process.env["REDIS_URL"];
    if (!url) {
      if (process.env["NODE_ENV"] === "production") {
        throw new Error(
          "ReplayPurgeScheduler: REDIS_URL is required in production " +
            "(cannot schedule the cashier-admission replay purge without Redis).",
        );
      }
      return;
    }
    const jobOptions = DEFAULT_JOB_OPTIONS as JobsOptions;
    this.queue = new Queue(REPLAY_PURGE_QUEUE_NAME, {
      connection: { url },
      defaultJobOptions: jobOptions,
    });
    await this.queue.upsertJobScheduler(
      REPLAY_PURGE_JOB_NAME,
      { every },
      { name: REPLAY_PURGE_JOB_NAME, data: {}, opts: jobOptions },
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
