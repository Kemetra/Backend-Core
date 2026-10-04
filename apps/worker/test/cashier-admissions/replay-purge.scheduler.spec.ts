/**
 * RT-209 — ReplayPurgeScheduler unit tests. BullMQ's Queue is mocked; no
 * Redis connection is attempted.
 */
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { Queue } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import { REPLAY_PURGE_INTERVAL_ENV } from "../../src/cashier-admissions/replay-purge.config";
import { REPLAY_PURGE_JOB_NAME } from "../../src/cashier-admissions/replay-purge.processor";
import { ReplayPurgeScheduler } from "../../src/cashier-admissions/replay-purge.scheduler";
import { REPLAY_PURGE_QUEUE_NAME } from "../../src/cashier-admissions/replay-purge.worker";

const MockQueue = Queue as unknown as jest.Mock;
const FAKE_REDIS_URL = "redis://localhost:6379";
const SAVED = {
  REDIS_URL: process.env["REDIS_URL"],
  NODE_ENV: process.env["NODE_ENV"],
  [REPLAY_PURGE_INTERVAL_ENV]: process.env[REPLAY_PURGE_INTERVAL_ENV],
};

afterEach(() => {
  jest.clearAllMocks();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function lastQueue(): { upsertJobScheduler: jest.Mock; close: jest.Mock } {
  const r = MockQueue.mock.results[MockQueue.mock.results.length - 1];
  if (!r) throw new Error("Queue constructor was not called");
  return r.value as { upsertJobScheduler: jest.Mock; close: jest.Mock };
}

describe("RT-209 ReplayPurgeScheduler", () => {
  it("registers one hourly job scheduler on the replay-purge queue by default", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    delete process.env[REPLAY_PURGE_INTERVAL_ENV];
    await new ReplayPurgeScheduler().onModuleInit();

    expect(MockQueue).toHaveBeenCalledTimes(1);
    expect(MockQueue).toHaveBeenCalledWith(REPLAY_PURGE_QUEUE_NAME, {
      connection: { url: FAKE_REDIS_URL },
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    expect(lastQueue().upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(lastQueue().upsertJobScheduler).toHaveBeenCalledWith(
      REPLAY_PURGE_JOB_NAME,
      { every: 60 * 60 * 1000 },
      { name: REPLAY_PURGE_JOB_NAME, data: {}, opts: DEFAULT_JOB_OPTIONS },
    );
  });

  it("gives every scheduled job retries, so an incomplete purge is retried", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    await new ReplayPurgeScheduler().onModuleInit();
    const template = lastQueue().upsertJobScheduler.mock.calls[0]![2] as {
      opts: { attempts: number };
    };
    expect(template.opts.attempts).toBeGreaterThan(1);
  });

  it("uses the configured interval", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    process.env[REPLAY_PURGE_INTERVAL_ENV] = "900000";
    await new ReplayPurgeScheduler().onModuleInit();
    expect(lastQueue().upsertJobScheduler).toHaveBeenCalledWith(
      REPLAY_PURGE_JOB_NAME,
      { every: 900_000 },
      expect.anything(),
    );
  });

  it("refuses boot on an invalid interval, even without Redis", async () => {
    delete process.env["REDIS_URL"];
    process.env[REPLAY_PURGE_INTERVAL_ENV] = "1000";
    await expect(new ReplayPurgeScheduler().onModuleInit()).rejects.toThrow(
      REPLAY_PURGE_INTERVAL_ENV,
    );
    expect(MockQueue).not.toHaveBeenCalled();
  });

  it("is a no-op without REDIS_URL outside production", async () => {
    delete process.env["REDIS_URL"];
    delete process.env["NODE_ENV"];
    const scheduler = new ReplayPurgeScheduler();
    await scheduler.onModuleInit();
    expect(MockQueue).not.toHaveBeenCalled();
    await scheduler.onModuleDestroy(); // nothing to close
  });

  it("throws without REDIS_URL in production", async () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "production";
    await expect(new ReplayPurgeScheduler().onModuleInit()).rejects.toThrow(
      /REDIS_URL is required in production/,
    );
  });

  it("onModuleDestroy closes the queue once", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new ReplayPurgeScheduler();
    await scheduler.onModuleInit();
    const q = lastQueue();
    await scheduler.onModuleDestroy();
    await scheduler.onModuleDestroy();
    expect(q.close).toHaveBeenCalledTimes(1);
  });
});
