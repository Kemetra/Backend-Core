/**
 * RT-179 — StockRunSweepScheduler unit tests. BullMQ's Queue is mocked; no
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

import { STOCK_RUN_SWEEP_INTERVAL_ENV } from "../../src/erpnext-reconciliation/stock-run-sweep.config";
import { STOCK_RUN_SWEEP_JOB_NAME } from "../../src/erpnext-reconciliation/stock-run-sweep.processor";
import { StockRunSweepScheduler } from "../../src/erpnext-reconciliation/stock-run-sweep.scheduler";
import { STOCK_RUN_SWEEP_QUEUE_NAME } from "../../src/erpnext-reconciliation/stock-run-sweep.worker";

const MockQueue = Queue as unknown as jest.Mock;
const FAKE_REDIS_URL = "redis://localhost:6379";
const SAVED = {
  REDIS_URL: process.env["REDIS_URL"],
  NODE_ENV: process.env["NODE_ENV"],
  [STOCK_RUN_SWEEP_INTERVAL_ENV]: process.env[STOCK_RUN_SWEEP_INTERVAL_ENV],
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

describe("RT-179 StockRunSweepScheduler", () => {
  it("registers one daily job scheduler on the sweep queue by default", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    delete process.env[STOCK_RUN_SWEEP_INTERVAL_ENV];
    const scheduler = new StockRunSweepScheduler();
    await scheduler.onModuleInit();

    expect(MockQueue).toHaveBeenCalledWith(STOCK_RUN_SWEEP_QUEUE_NAME, {
      connection: { url: FAKE_REDIS_URL },
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    expect(STOCK_RUN_SWEEP_JOB_NAME).toBe("erpnext-stock-reconciliation-sweep");
    expect(lastQueue().upsertJobScheduler).toHaveBeenCalledWith(
      STOCK_RUN_SWEEP_JOB_NAME,
      { every: 24 * 60 * 60 * 1000 },
      { name: STOCK_RUN_SWEEP_JOB_NAME, data: {}, opts: DEFAULT_JOB_OPTIONS },
    );
  });

  it("gives every scheduled job retries, so an incomplete sweep is retried", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    await new StockRunSweepScheduler().onModuleInit();
    const template = lastQueue().upsertJobScheduler.mock.calls[0]![2] as {
      opts: { attempts: number; backoff: { type: string; delay: number } };
    };
    expect(template.opts.attempts).toBeGreaterThan(1);
    expect(template.opts.attempts).toBe(5);
    expect(template.opts.backoff).toEqual({ type: "exponential", delay: 1_000 });
    // The whole retry window (1+2+4+8 s) is far inside the 5-minute minimum
    // interval, so retries finish before the next tick.
    const { attempts, backoff } = template.opts;
    let windowMs = 0;
    for (let n = 0; n < attempts - 1; n += 1) windowMs += backoff.delay * 2 ** n;
    expect(windowMs).toBeLessThan(5 * 60 * 1000);
  });

  it("uses the configured interval", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    process.env[STOCK_RUN_SWEEP_INTERVAL_ENV] = "3600000";
    await new StockRunSweepScheduler().onModuleInit();
    expect(lastQueue().upsertJobScheduler).toHaveBeenCalledWith(
      STOCK_RUN_SWEEP_JOB_NAME,
      { every: 3_600_000 },
      expect.anything(),
    );
  });

  it("refuses boot on an invalid interval, even without Redis", async () => {
    delete process.env["REDIS_URL"];
    process.env[STOCK_RUN_SWEEP_INTERVAL_ENV] = "60000";
    await expect(new StockRunSweepScheduler().onModuleInit()).rejects.toThrow(
      STOCK_RUN_SWEEP_INTERVAL_ENV,
    );
    expect(MockQueue).not.toHaveBeenCalled();
  });

  it("is a no-op without REDIS_URL outside production", async () => {
    delete process.env["REDIS_URL"];
    delete process.env["NODE_ENV"];
    const scheduler = new StockRunSweepScheduler();
    await scheduler.onModuleInit();
    expect(MockQueue).not.toHaveBeenCalled();
    await scheduler.onModuleDestroy(); // nothing to close
  });

  it("throws without REDIS_URL in production", async () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "production";
    await expect(new StockRunSweepScheduler().onModuleInit()).rejects.toThrow(
      /REDIS_URL is required in production/,
    );
  });

  it("onModuleDestroy closes the queue once", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new StockRunSweepScheduler();
    await scheduler.onModuleInit();
    const q = lastQueue();
    await scheduler.onModuleDestroy();
    await scheduler.onModuleDestroy();
    expect(q.close).toHaveBeenCalledTimes(1);
  });
});
