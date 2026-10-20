/**
 * RT-664 — registers the repeatable AI usage reservation sweep (T17).
 *
 * Mirrors the retention schedulers: `Queue.upsertJobScheduler` is idempotent
 * per scheduler id, so every worker boot (and every replica) converges on ONE
 * schedule in Redis. The cadence is `AI_RESERVATION_SWEEP_INTERVAL_MS`
 * (default every 5 minutes, see reservation-sweep.config.ts); changing it and restarting the
 * worker updates the existing schedule in place.
 *
 * Retries: the processor fails the job with `ReservationSweepIncompleteError` when a
 * tenant fails, so the queue and the job template carry the shared
 * DEFAULT_JOB_OPTIONS (5 attempts, exponential backoff). A release is
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

import { resolveReservationSweepIntervalMs } from "./reservation-sweep.config";
import { RESERVATION_SWEEP_JOB_NAME } from "./reservation-sweep.processor";
import { RESERVATION_SWEEP_QUEUE_NAME } from "./reservation-sweep.worker";

@Injectable()
export class ReservationSweepScheduler implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;

  async onModuleInit(): Promise<void> {
    // Resolve first: an invalid interval refuses boot even without Redis.
    const every = resolveReservationSweepIntervalMs();
    const url = process.env["REDIS_URL"];
    if (!url) {
      if (process.env["NODE_ENV"] === "production") {
        throw new Error(
          "ReservationSweepScheduler: REDIS_URL is required in production " +
            "(cannot schedule the AI usage reservation sweep without Redis).",
        );
      }
      return;
    }
    const jobOptions = DEFAULT_JOB_OPTIONS as JobsOptions;
    this.queue = new Queue(RESERVATION_SWEEP_QUEUE_NAME, {
      connection: { url },
      defaultJobOptions: jobOptions,
    });
    await this.queue.upsertJobScheduler(
      RESERVATION_SWEEP_JOB_NAME,
      { every },
      { name: RESERVATION_SWEEP_JOB_NAME, data: {}, opts: jobOptions },
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
