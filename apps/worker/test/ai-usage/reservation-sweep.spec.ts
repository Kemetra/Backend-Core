/**
 * RT-664 — the AI usage reservation sweep (T17): config, processor, scheduler
 * and BullMQ worker glue. No database, no Redis (BullMQ's Queue is mocked).
 */
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@data-pulse-2/shared";
import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import {
  RESERVATION_SWEEP_INTERVAL_ENV,
  RESERVATION_SWEEP_LOOKBACK_ENV,
  resolveReservationSweepIntervalMs,
  resolveReservationSweepLookbackSeconds,
} from "../../src/ai-usage/reservation-sweep.config";
import {
  MalformedReservationSweepJobError,
  RESERVATION_SWEEP_JOB_NAME,
  ReservationSweepIncompleteError,
  ReservationSweepProcessor,
  UnknownReservationSweepJobError,
  type ReservationSweepLogLine,
} from "../../src/ai-usage/reservation-sweep.processor";
import {
  NoOpReservationSweepRepository,
  type ReservationSweepRepository,
  type SweepBatchInput,
} from "../../src/ai-usage/reservation-sweep.repository";
import { ReservationSweepScheduler } from "../../src/ai-usage/reservation-sweep.scheduler";
import { RESERVATION_SWEEP_QUEUE_NAME, ReservationSweepWorker } from "../../src/ai-usage/reservation-sweep.worker";
import type { JobLike, WorkerFactory, WorkerLike } from "../../src/email/email.worker";

const TENANT_A = "0a000000-0000-7000-8000-000000664a01";
const TENANT_B = "0b000000-0000-7000-8000-000000664b01";

/** A repository whose tenants hold `pending` expired reservations each; `fail` tenants throw. */
function fakeRepo(pending: Record<string, number>, fail: ReadonlySet<string> = new Set()) {
  const calls: Array<{ tenantId: string; input: SweepBatchInput }> = [];
  const repo: ReservationSweepRepository = {
    isProvisioned: () => Promise.resolve(true),
    listTenantIds: () => Promise.resolve(Object.keys(pending)),
    releaseExpiredBatch: (tenantId, input) => {
      calls.push({ tenantId, input });
      if (fail.has(tenantId)) return Promise.reject(Object.assign(new Error(`boom ${tenantId}`), { code: "42501" }));
      const listed = Math.min(input.limit, pending[tenantId] ?? 0);
      pending[tenantId] = (pending[tenantId] ?? 0) - listed;
      return Promise.resolve({ listed, released: listed });
    },
  };
  return { repo, calls };
}

describe("RT-664 reservation sweep config", () => {
  it("defaults to every 5 minutes and a 32-day lookback (longer than a month window)", () => {
    expect(resolveReservationSweepIntervalMs({})).toBe(300_000);
    expect(resolveReservationSweepLookbackSeconds({})).toBe(2_764_800);
    expect(resolveReservationSweepIntervalMs({ [RESERVATION_SWEEP_INTERVAL_ENV]: " 120000 " })).toBe(120_000);
    expect(resolveReservationSweepLookbackSeconds({ [RESERVATION_SWEEP_LOOKBACK_ENV]: "3600" })).toBe(3600);
  });

  it.each(["abc", "59999", "1.5", "-1"])("refuses an interval of %j rather than defaulting", (raw) => {
    expect(() => resolveReservationSweepIntervalMs({ [RESERVATION_SWEEP_INTERVAL_ENV]: raw })).toThrow(RESERVATION_SWEEP_INTERVAL_ENV);
  });

  it("refuses a lookback under one hour", () => {
    expect(() => resolveReservationSweepLookbackSeconds({ [RESERVATION_SWEEP_LOOKBACK_ENV]: "60" })).toThrow(RESERVATION_SWEEP_LOOKBACK_ENV);
  });
});

describe("RT-664 ReservationSweepProcessor", () => {
  it("sweeps every tenant in bounded batches until one comes back short", async () => {
    const { repo, calls } = fakeRepo({ [TENANT_A]: 5, [TENANT_B]: 0 });
    const result = await new ReservationSweepProcessor(repo, { batchSize: 2, lookbackSeconds: 3600, log: () => undefined }).process(
      RESERVATION_SWEEP_JOB_NAME,
      {},
    );
    expect(result).toMatchObject({ tenants: 2, released: 5, batches: 4, failedTenants: 0 });
    expect(calls.filter((c) => c.tenantId === TENANT_A)).toHaveLength(3);
    expect(calls.every((c) => c.input.lookbackSeconds === 3600 && c.input.limit === 2)).toBe(true);
  });

  it("isolates a failing tenant, still sweeps the rest, and fails the job for a retry", async () => {
    const lines: ReservationSweepLogLine[] = [];
    const { repo, calls } = fakeRepo({ [TENANT_A]: 1, [TENANT_B]: 1 }, new Set([TENANT_A]));
    const run = new ReservationSweepProcessor(repo, { log: (l) => lines.push(l) }).process(RESERVATION_SWEEP_JOB_NAME, {});
    await expect(run).rejects.toBeInstanceOf(ReservationSweepIncompleteError);
    expect(calls.map((c) => c.tenantId)).toEqual([TENANT_A, TENANT_B]);
    expect(lines.find((l) => l["message"] === "tenant_sweep_failed")).toMatchObject({ errorName: "Error", errorCode: "42501" });
    const text = JSON.stringify(lines);
    expect(text).not.toContain(TENANT_A);
    expect(text).not.toContain("boom");
    expect(lines.at(-1)).toMatchObject({ level: "warn", message: "sweep_complete", released: 1, failed_tenants: 1 });
  });

  it("refuses an unknown job name and a non-object payload", async () => {
    const p = new ReservationSweepProcessor(new NoOpReservationSweepRepository(), { log: () => undefined });
    await expect(p.process("other", {})).rejects.toBeInstanceOf(UnknownReservationSweepJobError);
    await expect(p.process(RESERVATION_SWEEP_JOB_NAME, "x")).rejects.toBeInstanceOf(MalformedReservationSweepJobError);
    await expect(p.process(RESERVATION_SWEEP_JOB_NAME, {})).resolves.toMatchObject({ tenants: 0, released: 0 });
    await expect(new NoOpReservationSweepRepository().listTenantIds()).resolves.toEqual([]);
    await expect(new NoOpReservationSweepRepository().releaseExpiredBatch()).resolves.toEqual({ listed: 0, released: 0 });
  });

  it("is a quiet no-op until the owner-gated grants are applied (no tenant listed, no error)", async () => {
    const lines: ReservationSweepLogLine[] = [];
    const { repo, calls } = fakeRepo({ [TENANT_A]: 3 });
    const unprovisioned = { ...repo, isProvisioned: () => Promise.resolve(false) };
    const result = await new ReservationSweepProcessor(unprovisioned, { log: (l) => lines.push(l) }).process(RESERVATION_SWEEP_JOB_NAME, {});
    expect(result).toMatchObject({ tenants: 0, released: 0, failedTenants: 0 });
    expect(calls).toEqual([]);
    expect(lines).toEqual([{ level: "info", component: "ai-usage.reservation-sweep", message: "sweep_skipped_not_provisioned" }]);
  });

  it("refuses a non-positive batch size", () => {
    expect(() => new ReservationSweepProcessor(new NoOpReservationSweepRepository(), { batchSize: 0 })).toThrow(/batch size/);
  });

  it("pins the job and queue names", () => {
    expect(RESERVATION_SWEEP_JOB_NAME).toBe("ai-usage-reservation-sweep");
    expect(RESERVATION_SWEEP_QUEUE_NAME).toBe(QUEUE_NAMES.aiUsageReservationSweep);
  });
});

describe("RT-664 ReservationSweepScheduler", () => {
  const MockQueue = Queue as unknown as jest.Mock;
  const saved = { REDIS_URL: process.env["REDIS_URL"], NODE_ENV: process.env["NODE_ENV"], interval: process.env[RESERVATION_SWEEP_INTERVAL_ENV] };

  afterEach(() => {
    jest.clearAllMocks();
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore("REDIS_URL", saved.REDIS_URL);
    restore("NODE_ENV", saved.NODE_ENV);
    restore(RESERVATION_SWEEP_INTERVAL_ENV, saved.interval);
  });

  it("registers one job scheduler every 5 minutes on the sweep queue, and closes it", async () => {
    process.env["REDIS_URL"] = "redis://localhost:6379";
    delete process.env[RESERVATION_SWEEP_INTERVAL_ENV];
    const scheduler = new ReservationSweepScheduler();
    await scheduler.onModuleInit();
    expect(MockQueue).toHaveBeenCalledWith(RESERVATION_SWEEP_QUEUE_NAME, { connection: { url: "redis://localhost:6379" }, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    const queue = MockQueue.mock.results[0]!.value as { upsertJobScheduler: jest.Mock; close: jest.Mock };
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      RESERVATION_SWEEP_JOB_NAME,
      { every: 300_000 },
      { name: RESERVATION_SWEEP_JOB_NAME, data: {}, opts: DEFAULT_JOB_OPTIONS },
    );
    await scheduler.onModuleDestroy();
    expect(queue.close).toHaveBeenCalledTimes(1);
  });

  it("refuses to boot in production without Redis, and is a no-op elsewhere", async () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "production";
    await expect(new ReservationSweepScheduler().onModuleInit()).rejects.toThrow(/REDIS_URL is required/);
    process.env["NODE_ENV"] = "test";
    await expect(new ReservationSweepScheduler().onModuleInit()).resolves.toBeUndefined();
    expect(MockQueue).not.toHaveBeenCalled();
  });

  it("refuses an invalid interval even without Redis", async () => {
    delete process.env["REDIS_URL"];
    process.env[RESERVATION_SWEEP_INTERVAL_ENV] = "soon";
    await expect(new ReservationSweepScheduler().onModuleInit()).rejects.toThrow(RESERVATION_SWEEP_INTERVAL_ENV);
  });
});

describe("RT-664 ReservationSweepWorker", () => {
  it("consumes the sweep queue, hands jobs to the processor and logs worker errors by class only", async () => {
    let handler: ((job: JobLike) => Promise<void>) | null = null;
    let onError: ((err: Error) => void) | null = null;
    let closed = 0;
    const fakeWorker: WorkerLike = {
      on: (_event: string, cb: (err: Error) => void) => {
        onError = cb;
        return fakeWorker;
      },
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    } as unknown as WorkerLike;
    const factory: WorkerFactory = {
      create: (queue: string, fn: (job: JobLike) => Promise<void>) => {
        expect(queue).toBe(RESERVATION_SWEEP_QUEUE_NAME);
        handler = fn;
        return fakeWorker;
      },
    } as unknown as WorkerFactory;
    const processed: string[] = [];
    const processor = { process: (name: string) => Promise.resolve(void processed.push(name)) } as unknown as ReservationSweepProcessor;
    const errors: Array<Record<string, unknown>> = [];
    const worker = new ReservationSweepWorker(processor, factory, { error: (obj: Record<string, unknown>) => void errors.push(obj) } as never);

    worker.start();
    worker.start();
    await handler!({ name: RESERVATION_SWEEP_JOB_NAME, data: {} } as JobLike);
    expect(processed).toEqual([RESERVATION_SWEEP_JOB_NAME]);
    onError!(new TypeError("redis://user:secret@host"));
    expect(errors).toEqual([{ component: "ai-usage.reservation-sweep.worker", errorName: "TypeError" }]);
    await worker.onModuleDestroy();
    await worker.close();
    expect(closed).toBe(1);
  });
});
