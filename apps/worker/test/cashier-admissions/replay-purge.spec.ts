/**
 * RT-209 — purge of expired cashier-admission replay rows: Docker-free unit
 * tier.
 *
 * Covers the interval config, the processor's orchestration over a fake
 * repository (every tenant swept, bounded batches, per-tenant failure
 * isolation, count-only logging, job validation), the BullMQ worker glue
 * through a fake WorkerFactory, and the WorkerModule provider factory / DI
 * graph.
 *
 * The SQL side (expiry predicate, tenant scoping, RLS, role posture) is
 * proven against real Postgres in replay-purge.integration.spec.ts.
 */
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import { createLogger, QUEUE_NAMES } from "@data-pulse-2/shared";
import {
  DEFAULT_WORKER_OPTIONS,
  type DefaultWorkerOptionsShape,
} from "@data-pulse-2/shared/queues/queue-config";

import {
  DEFAULT_REPLAY_PURGE_BATCH_SIZE,
  DEFAULT_REPLAY_PURGE_INTERVAL_MS,
  MIN_REPLAY_PURGE_INTERVAL_MS,
  REPLAY_PURGE_INTERVAL_ENV,
  resolveReplayPurgeIntervalMs,
} from "../../src/cashier-admissions/replay-purge.config";
import {
  MalformedReplayPurgeJobError,
  REPLAY_PURGE_JOB_NAME,
  ReplayPurgeIncompleteError,
  ReplayPurgeProcessor,
  UnknownReplayPurgeJobError,
  type ReplayPurgeLogLine,
} from "../../src/cashier-admissions/replay-purge.processor";
import {
  NoOpReplayPurgeRepository,
  PgReplayPurgeRepository,
  type ReplayPurgeRepository,
} from "../../src/cashier-admissions/replay-purge.repository";
import {
  REPLAY_PURGE_QUEUE_NAME,
  ReplayPurgeWorker,
} from "../../src/cashier-admissions/replay-purge.worker";
import type { JobLike, WorkerFactory, WorkerLike } from "../../src/email/email.worker";
import {
  AuditDbPool,
  WorkerModule,
  replayPurgeProcessorProviderFactory,
} from "../../src/worker.module";

const HOUR = 60 * 60 * 1000;
const TENANT_A = "0a000000-0000-7000-8000-000000209a01";
const TENANT_B = "0b000000-0000-7000-8000-000000209b01";
const TENANT_C = "0c000000-0000-7000-8000-000000209c01";

const ORIGINAL_INTERVAL = process.env[REPLAY_PURGE_INTERVAL_ENV];
const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];
const ORIGINAL_REDIS_URL = process.env["REDIS_URL"];
const ORIGINAL_DATABASE_URL = process.env["DATABASE_URL"];

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore(REPLAY_PURGE_INTERVAL_ENV, ORIGINAL_INTERVAL);
  restore("NODE_ENV", ORIGINAL_NODE_ENV);
  restore("REDIS_URL", ORIGINAL_REDIS_URL);
  restore("DATABASE_URL", ORIGINAL_DATABASE_URL);
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("RT-209 replay purge interval config", () => {
  it("defaults to hourly when unset or blank", () => {
    expect(DEFAULT_REPLAY_PURGE_INTERVAL_MS).toBe(HOUR);
    expect(resolveReplayPurgeIntervalMs({})).toBe(HOUR);
    expect(resolveReplayPurgeIntervalMs({ [REPLAY_PURGE_INTERVAL_ENV]: "  " })).toBe(HOUR);
  });

  it("accepts a whole number of milliseconds at or above the minimum", () => {
    expect(MIN_REPLAY_PURGE_INTERVAL_MS).toBe(60_000);
    expect(resolveReplayPurgeIntervalMs({ [REPLAY_PURGE_INTERVAL_ENV]: "60000" })).toBe(60_000);
    expect(resolveReplayPurgeIntervalMs({ [REPLAY_PURGE_INTERVAL_ENV]: " 900000 " })).toBe(900_000);
  });

  it.each(["59999", "0", "-3600000", "1h", "3600000.5", "1e7", "soon"])(
    "refuses %p (names the variable)",
    (raw) => {
      expect(() => resolveReplayPurgeIntervalMs({ [REPLAY_PURGE_INTERVAL_ENV]: raw })).toThrow(
        REPLAY_PURGE_INTERVAL_ENV,
      );
    },
  );

  it("reads process.env by default", () => {
    process.env[REPLAY_PURGE_INTERVAL_ENV] = "120000";
    expect(resolveReplayPurgeIntervalMs()).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

interface BatchCall {
  readonly tenantId: string;
  readonly batchSize: number;
  readonly purged: number;
}

/**
 * In-memory stand-in: each tenant holds N expired rows; a batch removes at
 * most `batchSize` of them. Tenants listed in `failing` throw.
 */
class FakeRepo implements ReplayPurgeRepository {
  readonly calls: BatchCall[] = [];
  constructor(
    readonly expired: Map<string, number>,
    private readonly failing: ReadonlySet<string> = new Set(),
  ) {}

  async listTenantIds(): Promise<string[]> {
    return [...this.expired.keys()];
  }

  async purgeExpiredBatch(tenantId: string, batchSize: number): Promise<number> {
    if (this.failing.has(tenantId)) {
      const err = new Error(`relation "cashier_admission_requests" ${tenantId} broke`);
      (err as Error & { code?: string }).code = "40P01";
      throw err;
    }
    const left = this.expired.get(tenantId) ?? 0;
    const purged = Math.min(left, batchSize);
    this.expired.set(tenantId, left - purged);
    this.calls.push({ tenantId, batchSize, purged });
    return purged;
  }
}

function makeProcessor(
  repo: ReplayPurgeRepository,
  lines: ReplayPurgeLogLine[],
  batchSize?: number,
): ReplayPurgeProcessor {
  return new ReplayPurgeProcessor(repo, batchSize, (line) => lines.push(line));
}

describe("RT-209 ReplayPurgeProcessor", () => {
  it("purges the expired rows of EVERY tenant, not just the first", async () => {
    const repo = new FakeRepo(new Map([[TENANT_A, 3], [TENANT_B, 1], [TENANT_C, 0]]));
    const result = await makeProcessor(repo, []).process(REPLAY_PURGE_JOB_NAME, {});

    expect(repo.expired).toEqual(new Map([[TENANT_A, 0], [TENANT_B, 0], [TENANT_C, 0]]));
    expect(result).toMatchObject({ tenants: 3, purged: 4, failedTenants: 0 });
    expect(new Set(repo.calls.map((c) => c.tenantId))).toEqual(
      new Set([TENANT_A, TENANT_B, TENANT_C]),
    );
  });

  it("works in bounded batches: every DELETE asks for at most batchSize rows", async () => {
    const repo = new FakeRepo(new Map([[TENANT_A, 5], [TENANT_B, 4]]));
    const result = await makeProcessor(repo, [], 2).process(REPLAY_PURGE_JOB_NAME, {});

    expect(repo.calls.every((c) => c.batchSize === 2)).toBe(true);
    expect(repo.calls.every((c) => c.purged <= 2)).toBe(true);
    // A: 2 + 2 + 1 (short batch ends the tenant). B: 2 + 2 + 0 (a full batch
    // may have left more, so one more is asked for).
    expect(repo.calls.filter((c) => c.tenantId === TENANT_A).map((c) => c.purged)).toEqual([
      2, 2, 1,
    ]);
    expect(repo.calls.filter((c) => c.tenantId === TENANT_B).map((c) => c.purged)).toEqual([
      2, 2, 0,
    ]);
    expect(result).toMatchObject({ tenants: 2, purged: 9, batches: 6 });
  });

  it("uses the default batch size when none is given", async () => {
    expect(DEFAULT_REPLAY_PURGE_BATCH_SIZE).toBe(500);
    const repo = new FakeRepo(new Map([[TENANT_A, 1]]));
    await makeProcessor(repo, []).process(REPLAY_PURGE_JOB_NAME, {});
    expect(repo.calls[0]!.batchSize).toBe(DEFAULT_REPLAY_PURGE_BATCH_SIZE);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses a batch size of %p", (size) => {
    expect(() => makeProcessor(new FakeRepo(new Map()), [], size)).toThrow(/batch size/);
  });

  it("a tenant with nothing expired costs exactly one batch", async () => {
    const repo = new FakeRepo(new Map([[TENANT_A, 0]]));
    const result = await makeProcessor(repo, []).process(REPLAY_PURGE_JOB_NAME, {});
    expect(repo.calls).toHaveLength(1);
    expect(result).toMatchObject({ tenants: 1, purged: 0, batches: 1 });
  });

  it("no tenants is an empty, successful pass", async () => {
    const result = await makeProcessor(new NoOpReplayPurgeRepository(), []).process(
      REPLAY_PURGE_JOB_NAME,
      {},
    );
    expect(result).toMatchObject({ tenants: 0, purged: 0, batches: 0, failedTenants: 0 });
  });

  it("a failing tenant does not stop the others; the job then fails so BullMQ retries", async () => {
    const lines: ReplayPurgeLogLine[] = [];
    const repo = new FakeRepo(new Map([[TENANT_A, 2], [TENANT_B, 2], [TENANT_C, 2]]), new Set([TENANT_B]));
    const err = await makeProcessor(repo, lines)
      .process(REPLAY_PURGE_JOB_NAME, {})
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReplayPurgeIncompleteError);
    expect((err as ReplayPurgeIncompleteError).result).toMatchObject({
      tenants: 3,
      purged: 4,
      failedTenants: 1,
    });
    expect(repo.expired.get(TENANT_A)).toBe(0);
    expect(repo.expired.get(TENANT_C)).toBe(0);
    const failure = lines.find((l) => l["message"] === "tenant_purge_failed");
    expect(failure).toMatchObject({ level: "error", errorName: "Error", errorCode: "40P01" });
  });

  it("a failing tenant listing fails the job", async () => {
    const repo: ReplayPurgeRepository = {
      listTenantIds: async () => {
        throw new Error("boom");
      },
      purgeExpiredBatch: async () => 0,
    };
    await expect(makeProcessor(repo, []).process(REPLAY_PURGE_JOB_NAME, {})).rejects.toThrow(
      "boom",
    );
  });

  it("logs counts only: no tenant id, no row data, no error message", async () => {
    const lines: ReplayPurgeLogLine[] = [];
    const repo = new FakeRepo(new Map([[TENANT_A, 3], [TENANT_B, 1]]), new Set([TENANT_B]));
    await makeProcessor(repo, lines)
      .process(REPLAY_PURGE_JOB_NAME, {})
      .catch(() => undefined);

    const summary = lines.find((l) => l["message"] === "purge_complete");
    expect(summary).toEqual({
      level: "warn",
      component: "cashier-admissions.replay-purge",
      message: "purge_complete",
      tenants: 2,
      purged: 3,
      batches: 1,
      failed_tenants: 1,
      duration_ms: expect.any(Number),
    });
    const rendered = JSON.stringify(lines);
    expect(rendered).not.toContain(TENANT_A);
    expect(rendered).not.toContain(TENANT_B);
    expect(rendered).not.toContain("broke");
  });

  it("a clean pass logs its summary at info", async () => {
    const lines: ReplayPurgeLogLine[] = [];
    await makeProcessor(new FakeRepo(new Map([[TENANT_A, 1]])), lines).process(
      REPLAY_PURGE_JOB_NAME,
      {},
    );
    expect(lines).toEqual([
      expect.objectContaining({ level: "info", message: "purge_complete", purged: 1 }),
    ]);
  });

  it("writes to stderr by default", async () => {
    const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    await new ReplayPurgeProcessor(new NoOpReplayPurgeRepository()).process(
      REPLAY_PURGE_JOB_NAME,
      {},
    );
    expect(write).toHaveBeenCalledWith(expect.stringContaining("\"purge_complete\""));
  });

  it("rejects another job name and a non-object payload", async () => {
    const processor = makeProcessor(new FakeRepo(new Map([[TENANT_A, 1]])), []);
    await expect(processor.process("outbox-retention-sweep", {})).rejects.toBeInstanceOf(
      UnknownReplayPurgeJobError,
    );
    await expect(processor.process(REPLAY_PURGE_JOB_NAME, null)).rejects.toBeInstanceOf(
      MalformedReplayPurgeJobError,
    );
    await expect(processor.process(REPLAY_PURGE_JOB_NAME, "x")).rejects.toBeInstanceOf(
      MalformedReplayPurgeJobError,
    );
  });

  it("tolerates BullMQ metadata in the payload", async () => {
    const repo = new FakeRepo(new Map([[TENANT_A, 1]]));
    await expect(
      makeProcessor(repo, []).process(REPLAY_PURGE_JOB_NAME, { repeatJobKey: "k" }),
    ).resolves.toMatchObject({ purged: 1 });
  });

  it("pins the job name", () => {
    expect(REPLAY_PURGE_JOB_NAME).toBe("cashier-admission-replay-purge");
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

describe("RT-209 ReplayPurgeWorker", () => {
  it("consumes the shared replay-purge queue with the default worker options", () => {
    expect(REPLAY_PURGE_QUEUE_NAME).toBe(QUEUE_NAMES.cashierAdmissionReplayPurge);
    expect(REPLAY_PURGE_QUEUE_NAME).toBe("cashier-admission-replay-purge");
    const factory = new FakeWorkerFactory();
    const worker = new ReplayPurgeWorker(makeProcessor(new NoOpReplayPurgeRepository(), []), factory);
    worker.start();
    worker.start(); // idempotent
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]!.queueName).toBe(REPLAY_PURGE_QUEUE_NAME);
    expect(factory.calls[0]!.options).toBe(DEFAULT_WORKER_OPTIONS);
  });

  it("delegates each job to the processor", async () => {
    const factory = new FakeWorkerFactory();
    const processor = makeProcessor(new NoOpReplayPurgeRepository(), []);
    const spy = jest.spyOn(processor, "process");
    new ReplayPurgeWorker(processor, factory).start();
    await factory.calls[0]!.handler({ name: REPLAY_PURGE_JOB_NAME, data: {} });
    expect(spy).toHaveBeenCalledWith(REPLAY_PURGE_JOB_NAME, {});
  });

  it("logs worker errors through the shared pino logger with the error class only", () => {
    const rendered: string[] = [];
    const logger = createLogger({
      service: "worker",
      destination: { write: (msg: string) => void rendered.push(msg) },
    });
    const factory = new FakeWorkerFactory();
    new ReplayPurgeWorker(
      makeProcessor(new NoOpReplayPurgeRepository(), []),
      factory,
      logger,
    ).start();
    const err = new Error("connect ECONNREFUSED redis://:s3cret@redis:6379");
    err.name = "RedisConnectionError";
    factory.workers[0]!.errorListeners[0]!(err);

    const line = JSON.parse(rendered[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "error",
      component: "cashier-admissions.replay-purge.worker",
      message: "worker_error",
      errorName: "RedisConnectionError",
    });
    expect(rendered.join("")).not.toContain("s3cret");
  });

  it("falls back to the shared pino logger when none is injected", () => {
    const factory = new FakeWorkerFactory();
    new ReplayPurgeWorker(makeProcessor(new NoOpReplayPurgeRepository(), []), factory).start();
    expect(() => factory.workers[0]!.errorListeners[0]!(new Error("x"))).not.toThrow();
  });

  it("close() closes once; close before start and onModuleDestroy are safe", async () => {
    const factory = new FakeWorkerFactory();
    const worker = new ReplayPurgeWorker(makeProcessor(new NoOpReplayPurgeRepository(), []), factory);
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

describe("RT-209 WorkerModule wiring", () => {
  it("the provider factory picks the NoOp repo without a pool and the Pg repo with one", () => {
    const noDb = replayPurgeProcessorProviderFactory(new AuditDbPool(null));
    expect(noDb).toBeInstanceOf(ReplayPurgeProcessor);
    expect((noDb as unknown as { repo: unknown }).repo).toBeInstanceOf(NoOpReplayPurgeRepository);

    const fakePool = { end: async (): Promise<void> => undefined } as unknown as Pool;
    const withDb = replayPurgeProcessorProviderFactory(new AuditDbPool(fakePool));
    expect((withDb as unknown as { repo: unknown }).repo).toBeInstanceOf(PgReplayPurgeRepository);
  });

  it("resolves the purge processor and worker in the dev / no-Redis / no-DB path", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    expect(moduleRef.get(ReplayPurgeProcessor)).toBeInstanceOf(ReplayPurgeProcessor);
    const worker = moduleRef.get(ReplayPurgeWorker);
    expect(() => worker.start()).not.toThrow();
    await worker.close();
    await moduleRef.close();
  });
});
