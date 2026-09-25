/**
 * T091 — WorkerModule + worker/audit factory spec.
 *
 * Verifies:
 *   1. The production-vs-dev REDIS_URL branch behaviour at the
 *      `workerFactoryProviderFactory` level (existing).
 *   2. The DATABASE_URL × REDIS_URL truth table at the
 *      `pgPoolProviderFactory` / `auditDbProviderFactory` level (PR-D).
 *   3. The Nest module assembles its provider graph in the
 *      dev/no-Redis/no-DB path for both `EmailWorker` and `AuditWorker`.
 *
 * We never start a real BullMQ Worker, never connect to a real
 * Postgres — production-path tests only check the factory CLASS, not
 * that it boots anything. Where a `pg.Pool` is constructed (because
 * the factory requires a URL string), we close it via `pool.end()` to
 * avoid Jest open-handle warnings; `pg.Pool` does not actually
 * connect until `.connect()` / `.query()` is called.
 *
 * NODE_ENV strategy
 * -----------------
 * Each test mutates `NODE_ENV`, `REDIS_URL`, and `DATABASE_URL` via
 * the local helpers below and restores them in `afterEach`. No global
 * default.
 */
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import {
  AuditDbPool,
  BullMqWorkerFactory,
  NoOpWorkerFactory,
  workerFactoryProviderFactory,
  pgPoolProviderFactory,
  auditDbProviderFactory,
  auditRetentionRepoProviderFactory,
  WorkerModule,
} from "../src/worker.module";
import { EmailWorker } from "../src/email/email.worker";
import { AuditWorker } from "../src/audit/audit.worker";
import {
  DrizzleAuditDbAdapter,
  NoOpAuditDbAdapter,
} from "../src/audit/drizzle-audit-db.adapter";
import {
  DrizzleAuditRetentionRepository,
  NoOpAuditRetentionRepository,
} from "../src/audit/drizzle-audit-retention.repository";
import { AuditRetentionProcessor } from "../src/audit/audit-retention.processor";
import { AuditRetentionWorker } from "../src/audit/audit-retention.worker";
import { AuditRetentionScheduler } from "../src/audit/audit-retention.scheduler";
import { DEFAULT_WORKER_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];
const ORIGINAL_REDIS_URL = process.env["REDIS_URL"];
const ORIGINAL_DATABASE_URL = process.env["DATABASE_URL"];

const FAKE_DB_URL = "postgres://fake:fake@127.0.0.1:1/fake";

afterEach(() => {
  // Restore env between tests. `delete env.X` if the original was unset
  // — assigning `undefined` would set it to the literal string "undefined".
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env["NODE_ENV"];
  } else {
    process.env["NODE_ENV"] = ORIGINAL_NODE_ENV;
  }
  if (ORIGINAL_REDIS_URL === undefined) {
    delete process.env["REDIS_URL"];
  } else {
    process.env["REDIS_URL"] = ORIGINAL_REDIS_URL;
  }
  if (ORIGINAL_DATABASE_URL === undefined) {
    delete process.env["DATABASE_URL"];
  } else {
    process.env["DATABASE_URL"] = ORIGINAL_DATABASE_URL;
  }
});

describe("workerFactoryProviderFactory — REDIS_URL branch behaviour", () => {
  it("throws when NODE_ENV=production and REDIS_URL is missing (fail loud)", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["REDIS_URL"];
    expect(() => workerFactoryProviderFactory()).toThrow(
      /REDIS_URL is required in production/,
    );
  });

  it("returns a NoOpWorkerFactory when not in production and REDIS_URL is missing", () => {
    process.env["NODE_ENV"] = "development";
    delete process.env["REDIS_URL"];
    const f = workerFactoryProviderFactory();
    expect(f).toBeInstanceOf(NoOpWorkerFactory);
  });

  it("returns a NoOpWorkerFactory when NODE_ENV is unset (treated as non-production)", () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    const f = workerFactoryProviderFactory();
    expect(f).toBeInstanceOf(NoOpWorkerFactory);
  });

  it("returns a BullMqWorkerFactory when REDIS_URL is set, regardless of NODE_ENV", () => {
    process.env["NODE_ENV"] = "production";
    process.env["REDIS_URL"] = "redis://localhost:6379";
    const f = workerFactoryProviderFactory();
    expect(f).toBeInstanceOf(BullMqWorkerFactory);
  });
});

describe("NoOpWorkerFactory.create", () => {
  it("returns a worker whose close() resolves and on() is a no-op", async () => {
    const f = new NoOpWorkerFactory();
    const w = f.create(
      "email",
      async () => {
        // never invoked — NoOpWorker doesn't dispatch jobs
      },
      DEFAULT_WORKER_OPTIONS,
    );
    expect(() => w.on("error", () => undefined)).not.toThrow();
    await expect(w.close()).resolves.toBeUndefined();
  });

  it("accepts the WorkerStartOptions argument and ignores it (interface parity)", () => {
    const f = new NoOpWorkerFactory();
    expect(() =>
      f.create("email", async () => undefined, DEFAULT_WORKER_OPTIONS),
    ).not.toThrow();
  });
});

describe("BullMqWorkerFactory — interface shape", () => {
  // We deliberately do NOT instantiate the underlying bullmq.Worker here
  // (it would require Redis). We only verify the factory's `create`
  // method signature accepts the options argument; the actual spread
  // into `new Worker(...)` is type-checked by `tsc -p tsconfig.build.json`
  // and exercised end-to-end on a Redis-equipped environment.
  it("create() takes (queueName, handler, options)", () => {
    const f = new BullMqWorkerFactory("redis://localhost:6379");
    expect(typeof f.create).toBe("function");
    expect(f.create.length).toBe(3);
  });
});

describe("WorkerModule — Nest DI graph (dev / no-Redis / no-DB path)", () => {
  it("resolves EmailWorker without booting Redis, BullMQ, or Postgres", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const emailWorker = moduleRef.get(EmailWorker);
    expect(emailWorker).toBeInstanceOf(EmailWorker);

    // Calling start() on the dev-path worker exercises the NoOp
    // factory; it must not throw and must not require Redis.
    expect(() => emailWorker.start()).not.toThrow();
    await emailWorker.close();
    await moduleRef.close();
  });

  it("resolves AuditWorker without booting Redis, BullMQ, or Postgres", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const auditWorker = moduleRef.get(AuditWorker);
    expect(auditWorker).toBeInstanceOf(AuditWorker);

    // Same dev-path semantics as EmailWorker: start() goes through the
    // NoOp factory; the AUDIT_DB provider is a NoOpAuditDbAdapter.
    expect(() => auditWorker.start()).not.toThrow();
    await auditWorker.close();
    await moduleRef.close();
  });
});

// ---------------------------------------------------------------------------
// PR-D — DATABASE_URL × REDIS_URL truth table for pgPoolProviderFactory
// ---------------------------------------------------------------------------

describe("pgPoolProviderFactory — DATABASE_URL × REDIS_URL guard", () => {
  it("production + DATABASE_URL missing + REDIS_URL set → throws (DATABASE_URL named)", () => {
    process.env["NODE_ENV"] = "production";
    process.env["REDIS_URL"] = "redis://localhost:6379";
    delete process.env["DATABASE_URL"];
    expect(() => pgPoolProviderFactory()).toThrow(
      /DATABASE_URL is required in production/,
    );
  });

  it("production + DATABASE_URL missing + REDIS_URL unset → throws (production rule wins)", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];
    expect(() => pgPoolProviderFactory()).toThrow(
      /DATABASE_URL is required in production/,
    );
  });

  it("non-prod + REDIS_URL set + DATABASE_URL missing → throws (consume-without-persist guard)", () => {
    process.env["NODE_ENV"] = "development";
    process.env["REDIS_URL"] = "redis://localhost:6379";
    delete process.env["DATABASE_URL"];
    expect(() => pgPoolProviderFactory()).toThrow(
      /DATABASE_URL is required when REDIS_URL is set/,
    );
  });

  it("non-prod + REDIS_URL set + DATABASE_URL missing — error message names the consume-without-persist guard", () => {
    process.env["NODE_ENV"] = "development";
    process.env["REDIS_URL"] = "redis://localhost:6379";
    delete process.env["DATABASE_URL"];
    expect(() => pgPoolProviderFactory()).toThrow(
      /consume-without-persist guard/,
    );
  });

  it("non-prod + REDIS_URL unset + DATABASE_URL unset → AuditDbPool wrapping null (safe path)", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];
    const wrapper = pgPoolProviderFactory();
    expect(wrapper).toBeInstanceOf(AuditDbPool);
    expect(wrapper.pool).toBeNull();
    // No-op destroy — must not throw.
    await expect(wrapper.onModuleDestroy()).resolves.toBeUndefined();
  });

  it("non-prod + REDIS_URL unset + DATABASE_URL set → AuditDbPool wrapping a real Pool (real DB, idle worker)", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    process.env["DATABASE_URL"] = FAKE_DB_URL;
    const wrapper = pgPoolProviderFactory();
    expect(wrapper).toBeInstanceOf(AuditDbPool);
    expect(wrapper.pool).not.toBeNull();
    expect(typeof (wrapper.pool as Pool).connect).toBe("function");
    expect(wrapper.heartbeatPool).not.toBeNull();
    expect(wrapper.heartbeatPool).not.toBe(wrapper.pool);
    // pg.Pool is lazy — it does not connect until query() / connect().
    // Closing the empty pool via the wrapper's lifecycle hook releases
    // any internal timers.
    await wrapper.onModuleDestroy();
  });

  it("production + REDIS_URL set + DATABASE_URL set → AuditDbPool wrapping a real Pool", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["REDIS_URL"] = "redis://localhost:6379";
    process.env["DATABASE_URL"] = FAKE_DB_URL;
    const wrapper = pgPoolProviderFactory();
    expect(wrapper).toBeInstanceOf(AuditDbPool);
    expect(wrapper.pool).not.toBeNull();
    expect(typeof (wrapper.pool as Pool).connect).toBe("function");
    await wrapper.onModuleDestroy();
  });

  it("non-prod + REDIS_URL set + DATABASE_URL set → AuditDbPool wrapping a real Pool", async () => {
    process.env["NODE_ENV"] = "development";
    process.env["REDIS_URL"] = "redis://localhost:6379";
    process.env["DATABASE_URL"] = FAKE_DB_URL;
    const wrapper = pgPoolProviderFactory();
    expect(wrapper).toBeInstanceOf(AuditDbPool);
    expect(wrapper.pool).not.toBeNull();
    await wrapper.onModuleDestroy();
  });
});

// ---------------------------------------------------------------------------
// PR-D — AuditDbPool wrapper lifecycle
// ---------------------------------------------------------------------------

describe("AuditDbPool — Nest-managed lifecycle", () => {
  it("closes the dedicated heartbeat pool with the main pool", async () => {
    const main = { end: jest.fn(async () => undefined) } as unknown as Pool;
    const heartbeat = { end: jest.fn(async () => undefined) } as unknown as Pool;
    const wrapper = new AuditDbPool(main, heartbeat);
    await wrapper.onModuleDestroy();
    await wrapper.onModuleDestroy();
    expect(main.end).toHaveBeenCalledTimes(1);
    expect(heartbeat.end).toHaveBeenCalledTimes(1);
  });

  it("calls pool.end() exactly once on onModuleDestroy when wrapping a real Pool", async () => {
    let endCalls = 0;
    const fakePool = {
      end: async (): Promise<void> => {
        endCalls += 1;
      },
    } as unknown as Pool;
    const wrapper = new AuditDbPool(fakePool);

    expect(wrapper.pool).toBe(fakePool);
    await wrapper.onModuleDestroy();
    expect(endCalls).toBe(1);
  });

  it("nulls the pool reference after destroy so subsequent reads are null", async () => {
    const fakePool = { end: async (): Promise<void> => undefined } as unknown as Pool;
    const wrapper = new AuditDbPool(fakePool);

    await wrapper.onModuleDestroy();
    expect(wrapper.pool).toBeNull();
  });

  it("is idempotent — second onModuleDestroy does NOT call pool.end() again", async () => {
    let endCalls = 0;
    const fakePool = {
      end: async (): Promise<void> => {
        endCalls += 1;
      },
    } as unknown as Pool;
    const wrapper = new AuditDbPool(fakePool);

    await wrapper.onModuleDestroy();
    await wrapper.onModuleDestroy();
    expect(endCalls).toBe(1);
  });

  it("is a no-op when wrapping null (safe path) — does not throw", async () => {
    const wrapper = new AuditDbPool(null);
    await expect(wrapper.onModuleDestroy()).resolves.toBeUndefined();
    expect(wrapper.pool).toBeNull();
  });

  it("propagates rejections from pool.end() so shutdown failures are visible", async () => {
    const endError = new Error("pool: end failed");
    const fakePool = {
      end: async (): Promise<void> => {
        throw endError;
      },
    } as unknown as Pool;
    const wrapper = new AuditDbPool(fakePool);

    await expect(wrapper.onModuleDestroy()).rejects.toBe(endError);
    // Reference is still nulled before the await — second destroy is safe.
    expect(wrapper.pool).toBeNull();
    await expect(wrapper.onModuleDestroy()).resolves.toBeUndefined();
  });
});

describe("AuditDbPool — Nest module fires onModuleDestroy on app close", () => {
  // This is the integration-level pin for the lifecycle wrapper. We
  // construct the real WorkerModule in the safe non-prod / no-Redis /
  // no-DB path, replace the AuditDbPool provider with one that uses an
  // observable fake pool, then call moduleRef.close() and assert the
  // fake's `end()` was invoked. If Nest were not firing the hook, the
  // counter would stay at 0 — the bug this PR exists to prevent.
  it("invokes AuditDbPool.onModuleDestroy via moduleRef.close()", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];

    let endCalls = 0;
    const fakePool = {
      end: async (): Promise<void> => {
        endCalls += 1;
      },
    } as unknown as Pool;

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(AuditDbPool)
      .useValue(new AuditDbPool(fakePool))
      .compile();

    // Resolve the wrapper so Nest's instance graph is hot.
    const wrapper = moduleRef.get(AuditDbPool);
    expect(wrapper).toBeInstanceOf(AuditDbPool);
    expect(wrapper.pool).toBe(fakePool);

    // Closing the module fires onModuleDestroy on every provider that
    // implements it — including AuditDbPool.
    await moduleRef.close();
    expect(endCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PR-D — auditDbProviderFactory selects adapter based on wrapper.pool
// ---------------------------------------------------------------------------

describe("auditDbProviderFactory — adapter selection", () => {
  it("returns NoOpAuditDbAdapter when wrapper.pool is null (safe non-prod / no-Redis / no-DB path)", () => {
    const wrapper = new AuditDbPool(null);
    const adapter = auditDbProviderFactory(wrapper);
    expect(adapter).toBeInstanceOf(NoOpAuditDbAdapter);
  });

  it("returns DrizzleAuditDbAdapter when wrapper.pool is provided", async () => {
    process.env["DATABASE_URL"] = FAKE_DB_URL;
    const wrapper = pgPoolProviderFactory();
    const adapter = auditDbProviderFactory(wrapper);
    expect(adapter).toBeInstanceOf(DrizzleAuditDbAdapter);
    await wrapper.onModuleDestroy();
  });

  it("does NOT take ownership of the pool — wrapper still owns lifecycle", async () => {
    // Pin: the adapter never calls pool.end(). Lifecycle stays on the
    // wrapper. We verify by destroying the wrapper after the adapter
    // exists and confirming end() fired exactly once on the wrapper's
    // path (the adapter has no symmetrical hook).
    let endCalls = 0;
    const fakePool = {
      end: async (): Promise<void> => {
        endCalls += 1;
      },
    } as unknown as Pool;
    const wrapper = new AuditDbPool(fakePool);
    const adapter = auditDbProviderFactory(wrapper);
    expect(adapter).toBeInstanceOf(DrizzleAuditDbAdapter);

    // No `adapter.close()` exists — only the wrapper owns end().
    await wrapper.onModuleDestroy();
    expect(endCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T311 — auditRetentionRepoProviderFactory
// ---------------------------------------------------------------------------

describe("auditRetentionRepoProviderFactory — repo selection", () => {
  it("returns NoOpAuditRetentionRepository when wrapper.pool is null (safe path)", () => {
    const wrapper = new AuditDbPool(null);
    const repo = auditRetentionRepoProviderFactory(wrapper);
    expect(repo).toBeInstanceOf(NoOpAuditRetentionRepository);
  });

  it("returns DrizzleAuditRetentionRepository when wrapper.pool is non-null", async () => {
    process.env["DATABASE_URL"] = FAKE_DB_URL;
    const wrapper = pgPoolProviderFactory();
    const repo = auditRetentionRepoProviderFactory(wrapper);
    expect(repo).toBeInstanceOf(DrizzleAuditRetentionRepository);
    await wrapper.onModuleDestroy();
  });

  it("does not take pool ownership — wrapper still owns lifecycle", async () => {
    let endCalls = 0;
    const fakePool = {
      end: async (): Promise<void> => { endCalls += 1; },
    } as unknown as Pool;
    const wrapper = new AuditDbPool(fakePool);
    auditRetentionRepoProviderFactory(wrapper);
    await wrapper.onModuleDestroy();
    expect(endCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T311 — WorkerModule Nest DI graph (audit retention providers)
// ---------------------------------------------------------------------------

describe("WorkerModule — AuditRetentionProcessor resolves (dev / no-Redis / no-DB path)", () => {
  it("resolves AuditRetentionProcessor without booting Redis or Postgres", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const processor = moduleRef.get(AuditRetentionProcessor);
    expect(processor).toBeInstanceOf(AuditRetentionProcessor);
    await moduleRef.close();
  });
});

describe("WorkerModule — AuditRetentionWorker resolves (dev / no-Redis / no-DB path)", () => {
  it("resolves AuditRetentionWorker without booting Redis, BullMQ, or Postgres", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const retentionWorker = moduleRef.get(AuditRetentionWorker);
    expect(retentionWorker).toBeInstanceOf(AuditRetentionWorker);
    expect(() => retentionWorker.start()).not.toThrow();
    await retentionWorker.close();
    await moduleRef.close();
  });
});

describe("WorkerModule — AuditRetentionScheduler resolves (dev / no-Redis / no-DB path)", () => {
  it("resolves AuditRetentionScheduler without booting Redis", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const scheduler = moduleRef.get(AuditRetentionScheduler);
    expect(scheduler).toBeInstanceOf(AuditRetentionScheduler);
    await moduleRef.close();
  });
});

describe("WorkerModule — AUDIT_RETENTION_REPO resolves via DI graph", () => {
  it("resolves to NoOpAuditRetentionRepository in the safe no-DB path", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    // The processor holds the repo injected via AUDIT_RETENTION_REPO.
    // Validate via the processor's concrete repo type by resolving the
    // factory directly on the module's AuditDbPool instance.
    const wrapper = moduleRef.get(AuditDbPool);
    expect(wrapper.pool).toBeNull();
    const repo = auditRetentionRepoProviderFactory(wrapper);
    expect(repo).toBeInstanceOf(NoOpAuditRetentionRepository);
    await moduleRef.close();
  });

  it("resolves to DrizzleAuditRetentionRepository when DATABASE_URL is set", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    process.env["DATABASE_URL"] = FAKE_DB_URL;
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const wrapper = moduleRef.get(AuditDbPool);
    expect(wrapper.pool).not.toBeNull();
    const repo = auditRetentionRepoProviderFactory(wrapper);
    expect(repo).toBeInstanceOf(DrizzleAuditRetentionRepository);
    await moduleRef.close();
  });
});
