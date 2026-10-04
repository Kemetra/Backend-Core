/**
 * RT-179 — scheduled stock reconciliation run sweep: Docker-free unit tier.
 *
 * Covers the interval config, the processor's orchestration over a fake
 * repository (outcome counting, metrics/log lines, per-tenant failure
 * isolation, job validation), the BullMQ worker glue through a fake
 * WorkerFactory, and the WorkerModule provider factory / DI graph.
 *
 * The SQL side (tenant scoping, idempotency, RLS) is proven against real
 * Postgres in stock-run-sweep.integration.spec.ts.
 */
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import { QUEUE_NAMES } from "@data-pulse-2/shared";
import {
  DEFAULT_WORKER_OPTIONS,
  type DefaultWorkerOptionsShape,
} from "@data-pulse-2/shared/queues/queue-config";

import {
  DEFAULT_STOCK_RUN_SWEEP_INTERVAL_MS,
  MIN_STOCK_RUN_SWEEP_INTERVAL_MS,
  STOCK_RUN_SWEEP_INTERVAL_ENV,
  resolveStockRunSweepIntervalMs,
  sweepPeriodStart,
} from "../../src/erpnext-reconciliation/stock-run-sweep.config";
import {
  MalformedStockRunSweepJobError,
  STOCK_RUN_SWEEP_JOB_NAME,
  StockRunSweepIncompleteError,
  StockRunSweepProcessor,
  UnknownStockRunSweepJobError,
  type StockRunSweepLogLine,
} from "../../src/erpnext-reconciliation/stock-run-sweep.processor";
import {
  NoOpStockRunSweepRepository,
  PgStockRunSweepRepository,
  type StockRunSweepRepository,
  type SweepStoreInput,
  type SweepStoreResult,
} from "../../src/erpnext-reconciliation/stock-run-sweep.repository";
import {
  STOCK_RUN_SWEEP_QUEUE_NAME,
  StockRunSweepWorker,
} from "../../src/erpnext-reconciliation/stock-run-sweep.worker";
import type { JobLike, WorkerFactory, WorkerLike } from "../../src/email/email.worker";
import {
  AuditDbPool,
  WorkerModule,
  stockRunSweepProcessorProviderFactory,
} from "../../src/worker.module";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-04T10:30:00.000Z");
const ORIGINAL_INTERVAL = process.env[STOCK_RUN_SWEEP_INTERVAL_ENV];
const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];
const ORIGINAL_REDIS_URL = process.env["REDIS_URL"];
const ORIGINAL_DATABASE_URL = process.env["DATABASE_URL"];

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore(STOCK_RUN_SWEEP_INTERVAL_ENV, ORIGINAL_INTERVAL);
  restore("NODE_ENV", ORIGINAL_NODE_ENV);
  restore("REDIS_URL", ORIGINAL_REDIS_URL);
  restore("DATABASE_URL", ORIGINAL_DATABASE_URL);
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("RT-179 sweep interval config", () => {
  it("defaults to daily when unset or blank", () => {
    expect(DEFAULT_STOCK_RUN_SWEEP_INTERVAL_MS).toBe(DAY);
    expect(resolveStockRunSweepIntervalMs({})).toBe(DAY);
    expect(resolveStockRunSweepIntervalMs({ [STOCK_RUN_SWEEP_INTERVAL_ENV]: "  " })).toBe(DAY);
  });

  it("accepts a whole number of ms at or above the minimum", () => {
    expect(
      resolveStockRunSweepIntervalMs({ [STOCK_RUN_SWEEP_INTERVAL_ENV]: " 3600000 " }),
    ).toBe(3_600_000);
    expect(
      resolveStockRunSweepIntervalMs({
        [STOCK_RUN_SWEEP_INTERVAL_ENV]: String(MIN_STOCK_RUN_SWEEP_INTERVAL_MS),
      }),
    ).toBe(MIN_STOCK_RUN_SWEEP_INTERVAL_MS);
  });

  it.each(["abc", "1.5", "-86400000", "1e9", "0", "299999", "99999999999999999999"])(
    "refuses %p",
    (raw) => {
      expect(() =>
        resolveStockRunSweepIntervalMs({ [STOCK_RUN_SWEEP_INTERVAL_ENV]: raw }),
      ).toThrow(STOCK_RUN_SWEEP_INTERVAL_ENV);
    },
  );

  it("reads process.env by default", () => {
    process.env[STOCK_RUN_SWEEP_INTERVAL_ENV] = "600000";
    expect(resolveStockRunSweepIntervalMs()).toBe(600_000);
  });

  it("periods are epoch-aligned to the interval", () => {
    expect(sweepPeriodStart(NOW, DAY).toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(sweepPeriodStart(NOW, 3_600_000).toISOString()).toBe("2026-10-04T10:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

class FakeRepo implements StockRunSweepRepository {
  calls: SweepStoreInput[] = [];
  constructor(
    private readonly stores: Record<string, string[]>,
    private readonly outcomes: Record<string, SweepStoreResult["outcome"]> = {},
    private readonly failTenants: ReadonlySet<string> = new Set(),
  ) {}
  async listActiveTenantIds(): Promise<string[]> {
    return Object.keys(this.stores);
  }
  async listMappedStoreIds(tenantId: string): Promise<string[]> {
    if (this.failTenants.has(tenantId)) {
      const err = new Error("boom: contains row values");
      err.name = "DatabaseError";
      throw err;
    }
    return this.stores[tenantId] ?? [];
  }
  async sweepStore(input: SweepStoreInput): Promise<SweepStoreResult> {
    this.calls.push(input);
    return { outcome: this.outcomes[input.storeId] ?? "created", runId: `run-${input.storeId}` };
  }
}

function makeProcessor(repo: StockRunSweepRepository, lines: StockRunSweepLogLine[]) {
  return new StockRunSweepProcessor(repo, DAY, () => NOW, (l) => lines.push(l));
}

describe("RT-179 StockRunSweepProcessor", () => {
  it("sweeps every mapped store of every tenant with the period start and tick time", async () => {
    const repo = new FakeRepo(
      { "t-a": ["s-1", "s-2"], "t-b": ["s-3"], "t-c": [] },
      { "s-2": "skipped_running", "s-3": "skipped_period" },
    );
    const lines: StockRunSweepLogLine[] = [];
    const result = await makeProcessor(repo, lines).process(STOCK_RUN_SWEEP_JOB_NAME, {});

    expect(result).toEqual({
      periodStart: "2026-10-04T00:00:00.000Z",
      tenants: 3,
      created: 1,
      skippedRunning: 1,
      skippedPeriod: 1,
      failedTenants: 0,
    });
    expect(repo.calls.map((c) => [c.tenantId, c.storeId])).toEqual([
      ["t-a", "s-1"],
      ["t-a", "s-2"],
      ["t-b", "s-3"],
    ]);
    for (const c of repo.calls) {
      expect(c.periodStart.toISOString()).toBe("2026-10-04T00:00:00.000Z");
      expect(c.now).toBe(NOW);
    }

    const perStore = lines.filter((l) => l["message"] === "store_swept");
    expect(perStore).toHaveLength(3);
    expect(perStore[0]).toMatchObject({
      level: "info",
      outcome: "created",
      tenant_id: "t-a",
      store_id: "s-1",
      run_id: "run-s-1",
    });
    const summary = lines.find((l) => l["message"] === "sweep_complete");
    expect(summary).toMatchObject({
      level: "info",
      created: 1,
      skipped_running: 1,
      skipped_period: 1,
      failed_tenants: 0,
    });
  });

  it("isolates a failing tenant, finishes the others, then fails the job for a retry", async () => {
    const repo = new FakeRepo({ "t-a": ["s-1"], "t-bad": ["s-x"], "t-c": ["s-3"] }, {}, new Set(["t-bad"]));
    const lines: StockRunSweepLogLine[] = [];
    await expect(
      makeProcessor(repo, lines).process(STOCK_RUN_SWEEP_JOB_NAME, {}),
    ).rejects.toBeInstanceOf(StockRunSweepIncompleteError);

    expect(repo.calls.map((c) => c.storeId)).toEqual(["s-1", "s-3"]);
    const failure = lines.find((l) => l["message"] === "tenant_sweep_failed");
    expect(failure).toEqual({
      level: "error",
      component: "erpnext-reconciliation.stock-run-sweep",
      message: "tenant_sweep_failed",
      tenant_id: "t-bad",
      errorName: "DatabaseError",
    });
    // The error message (which may carry row values) is never logged.
    expect(JSON.stringify(lines)).not.toContain("row values");
    expect(lines.find((l) => l["message"] === "sweep_complete")).toMatchObject({
      level: "warn",
      created: 2,
      failed_tenants: 1,
    });
  });

  it("logs a non-Error throw as UnknownError", async () => {
    const repo: StockRunSweepRepository = {
      listActiveTenantIds: async () => ["t-a"],
      listMappedStoreIds: async () => {
        throw "plain string";
      },
      sweepStore: async () => ({ outcome: "created", runId: "r" }),
    };
    const lines: StockRunSweepLogLine[] = [];
    await expect(makeProcessor(repo, lines).process(STOCK_RUN_SWEEP_JOB_NAME, {})).rejects.toThrow(
      "1 tenant(s) failed",
    );
    expect(lines[0]).toMatchObject({ errorName: "UnknownError" });
  });

  it("an Error with an empty name is logged as Error", async () => {
    const repo: StockRunSweepRepository = {
      listActiveTenantIds: async () => ["t-a"],
      listMappedStoreIds: async () => {
        const err = new Error("x");
        err.name = "";
        throw err;
      },
      sweepStore: async () => ({ outcome: "created", runId: "r" }),
    };
    const lines: StockRunSweepLogLine[] = [];
    await expect(makeProcessor(repo, lines).process(STOCK_RUN_SWEEP_JOB_NAME, {})).rejects.toThrow();
    expect(lines[0]).toMatchObject({ errorName: "Error" });
  });

  it("no tenants → an empty, successful pass", async () => {
    const lines: StockRunSweepLogLine[] = [];
    const result = await makeProcessor(new NoOpStockRunSweepRepository(), lines).process(
      STOCK_RUN_SWEEP_JOB_NAME,
      { repeatJobKey: "bullmq-metadata" },
    );
    expect(result.tenants).toBe(0);
    expect(result.created).toBe(0);
  });

  it("rejects an unknown job name and a non-object payload", async () => {
    const proc = makeProcessor(new NoOpStockRunSweepRepository(), []);
    await expect(proc.process("audit-retention-sweep", {})).rejects.toBeInstanceOf(
      UnknownStockRunSweepJobError,
    );
    await expect(proc.process(STOCK_RUN_SWEEP_JOB_NAME, "nope")).rejects.toBeInstanceOf(
      MalformedStockRunSweepJobError,
    );
  });

  it("defaults to the real clock and a stderr JSON log", async () => {
    const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await new StockRunSweepProcessor(new NoOpStockRunSweepRepository(), DAY).process(
      STOCK_RUN_SWEEP_JOB_NAME,
      {},
    );
    expect(Date.parse(result.periodStart)).toBeLessThanOrEqual(Date.now());
    const logged = write.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain("\"message\":\"sweep_complete\"");
  });
});

describe("RT-179 NoOpStockRunSweepRepository", () => {
  it("lists nothing and refuses to sweep", async () => {
    const repo = new NoOpStockRunSweepRepository();
    expect(await repo.listMappedStoreIds("t")).toEqual([]);
    await expect(
      repo.sweepStore({ tenantId: "t", storeId: "s", periodStart: NOW, now: NOW }),
    ).rejects.toThrow("no database configured");
  });
});

// ---------------------------------------------------------------------------
// Worker glue
// ---------------------------------------------------------------------------

class FakeWorker implements WorkerLike {
  errorListeners: Array<(err: Error) => void> = [];
  closed = 0;
  on(_event: "error", listener: (err: Error) => void): unknown {
    this.errorListeners.push(listener);
    return this;
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

class FakeWorkerFactory implements WorkerFactory {
  calls: Array<{
    queueName: string;
    handler: (job: JobLike) => Promise<void>;
    options: DefaultWorkerOptionsShape;
  }> = [];
  workers: FakeWorker[] = [];
  create(
    queueName: string,
    handler: (job: JobLike) => Promise<void>,
    options: DefaultWorkerOptionsShape,
  ): WorkerLike {
    this.calls.push({ queueName, handler, options });
    const w = new FakeWorker();
    this.workers.push(w);
    return w;
  }
}

describe("RT-179 StockRunSweepWorker", () => {
  it("consumes the shared sweep queue with the default worker options", () => {
    expect(STOCK_RUN_SWEEP_QUEUE_NAME).toBe(QUEUE_NAMES.erpnextStockReconciliationSweep);
    expect(STOCK_RUN_SWEEP_QUEUE_NAME).toBe("erpnext-stock-reconciliation-sweep");
    const factory = new FakeWorkerFactory();
    const worker = new StockRunSweepWorker(
      makeProcessor(new NoOpStockRunSweepRepository(), []),
      factory,
    );
    worker.start();
    worker.start(); // idempotent
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]!.queueName).toBe(STOCK_RUN_SWEEP_QUEUE_NAME);
    expect(factory.calls[0]!.options).toBe(DEFAULT_WORKER_OPTIONS);
  });

  it("delegates (job.name, job.data) to the processor", async () => {
    const factory = new FakeWorkerFactory();
    const processor = makeProcessor(new NoOpStockRunSweepRepository(), []);
    const spy = jest.spyOn(processor, "process");
    new StockRunSweepWorker(processor, factory).start();
    await factory.calls[0]!.handler({ name: STOCK_RUN_SWEEP_JOB_NAME, data: {} });
    expect(spy).toHaveBeenCalledWith(STOCK_RUN_SWEEP_JOB_NAME, {});
  });

  it("writes worker errors as structured JSON", () => {
    const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    const factory = new FakeWorkerFactory();
    new StockRunSweepWorker(makeProcessor(new NoOpStockRunSweepRepository(), []), factory).start();
    const err = new Error("redis down");
    err.name = "RedisConnectionError";
    factory.workers[0]!.errorListeners[0]!(err);
    const line = JSON.parse(String(write.mock.calls[0]![0])) as Record<string, string>;
    expect(line).toEqual({
      level: "error",
      component: "erpnext-reconciliation.stock-run-sweep.worker",
      message: "redis down",
      name: "RedisConnectionError",
    });
  });

  it("close() closes once; close before start and onModuleDestroy are safe", async () => {
    const factory = new FakeWorkerFactory();
    const worker = new StockRunSweepWorker(
      makeProcessor(new NoOpStockRunSweepRepository(), []),
      factory,
    );
    await worker.close();
    worker.start();
    await worker.onModuleDestroy();
    await worker.close();
    expect(factory.workers[0]!.closed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// WorkerModule wiring
// ---------------------------------------------------------------------------

describe("RT-179 WorkerModule wiring", () => {
  it("the provider factory picks the NoOp repo without a pool and the Pg repo with one", async () => {
    const noDb = stockRunSweepProcessorProviderFactory(new AuditDbPool(null));
    expect(noDb).toBeInstanceOf(StockRunSweepProcessor);
    expect((noDb as unknown as { repo: unknown }).repo).toBeInstanceOf(NoOpStockRunSweepRepository);

    const fakePool = { end: async (): Promise<void> => undefined } as unknown as Pool;
    const withDb = stockRunSweepProcessorProviderFactory(new AuditDbPool(fakePool));
    expect((withDb as unknown as { repo: unknown }).repo).toBeInstanceOf(PgStockRunSweepRepository);
  });

  it("the provider factory refuses an invalid interval", () => {
    process.env[STOCK_RUN_SWEEP_INTERVAL_ENV] = "soon";
    expect(() => stockRunSweepProcessorProviderFactory(new AuditDbPool(null))).toThrow(
      STOCK_RUN_SWEEP_INTERVAL_ENV,
    );
  });

  it("resolves the sweep processor and worker in the dev / no-Redis / no-DB path", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    expect(moduleRef.get(StockRunSweepProcessor)).toBeInstanceOf(StockRunSweepProcessor);
    const worker = moduleRef.get(StockRunSweepWorker);
    expect(() => worker.start()).not.toThrow();
    await worker.close();
    await moduleRef.close();
  });
});
