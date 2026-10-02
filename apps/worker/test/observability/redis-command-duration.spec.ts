/**
 * Unit tests for InstrumentedRedis — the ioredis subclass that records
 * `redis_command_duration_seconds` on every sendCommand call.
 *
 * Tests cover:
 *   1. normalizeCommand — known/unknown command normalization
 *   2. KNOWN_REDIS_COMMANDS — closed-set membership
 *   3. InstrumentedRedis.duplicate — subclass propagation
 *   4. InstrumentedRedis.sendCommand — recording on resolve and reject
 *
 * `sendCommand` is tested by spying on `Redis.prototype.sendCommand` so no
 * live Redis connection is needed.
 *
 * Constitution §VII / FR-B-006 / P4 W4.
 */
import { Redis } from "ioredis";
import type { Command } from "ioredis";

import {
  BULLMQ_SAFE_REDIS_DEFAULTS,
  InstrumentedRedis,
  normalizeCommand,
  KNOWN_REDIS_COMMANDS,
} from "../../src/observability/instrumented-redis";
import { recordRedisCommandDuration } from "../../src/observability/metrics/worker.metrics";
import { BullMqWorkerFactory } from "../../src/worker.module";

type WorkerOpts = Parameters<BullMqWorkerFactory["create"]>[2];

jest.mock("../../src/observability/metrics/worker.metrics", () => ({
  recordRedisCommandDuration: jest.fn(),
}));

// Mock BullMQ's `Worker` so `BullMqWorkerFactory.create()` can be invoked
// without opening a real socket. The stub captures every constructor
// invocation so tests can assert on the WorkerOptions the factory
// actually hands to BullMQ — closing the gap CodeRabbit flagged where
// a standalone probe could mask a regression in the factory's wiring.
const bullMqWorkerCalls: Array<{
  queueName: string;
  processor: unknown;
  options: { connection: Redis } & Record<string, unknown>;
}> = [];

jest.mock("bullmq", () => {
  return {
    Worker: jest
      .fn()
      .mockImplementation(function MockedWorker(
        queueName: string,
        processor: unknown,
        options: { connection: Redis } & Record<string, unknown>,
      ) {
        bullMqWorkerCalls.push({ queueName, processor, options });
        return {
          on: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined),
        };
      }),
    // `Queue` is imported at worker.module top level even when the
    // factory test path does not exercise it; provide a no-op stub so
    // module loading does not crash.
    Queue: jest.fn().mockImplementation(function MockedQueue() {
      return { close: jest.fn().mockResolvedValue(undefined) };
    }),
  };
});

const mockedRecord = recordRedisCommandDuration as jest.MockedFunction<
  typeof recordRedisCommandDuration
>;

function makeCommand(name: string): Command {
  return { name } as unknown as Command;
}

// ---------------------------------------------------------------------------
// 1. normalizeCommand
// ---------------------------------------------------------------------------

describe("normalizeCommand", () => {
  it("returns lowercase name for a known command (lowercase input)", () => {
    expect(normalizeCommand("get")).toBe("get");
  });

  it("returns lowercase name for a known command (UPPERCASE input)", () => {
    expect(normalizeCommand("GET")).toBe("get");
  });

  it("returns lowercase name for a known command (mixed case)", () => {
    expect(normalizeCommand("Zadd")).toBe("zadd");
  });

  it('returns "other" for an unknown command', () => {
    expect(normalizeCommand("xread")).toBe("other");
  });

  it('returns "other" for an empty string', () => {
    expect(normalizeCommand("")).toBe("other");
  });

  it('returns "other" for a blocking-pop command not in the bounded set', () => {
    expect(normalizeCommand("brpop")).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// 2. KNOWN_REDIS_COMMANDS
// ---------------------------------------------------------------------------

describe("KNOWN_REDIS_COMMANDS", () => {
  it("includes core BullMQ-relevant commands", () => {
    const required = ["zadd", "zrangebyscore", "lpush", "llen", "hset", "eval", "ping"];
    required.forEach((cmd) => {
      expect(KNOWN_REDIS_COMMANDS.has(cmd)).toBe(true);
    });
  });

  it("does not include brpop (blocking pop belongs to BullMQ internals, not the bounded set)", () => {
    expect(KNOWN_REDIS_COMMANDS.has("brpop")).toBe(false);
  });

  it("does not include dangerous or unbounded admin commands", () => {
    expect(KNOWN_REDIS_COMMANDS.has("flushall")).toBe(false);
    expect(KNOWN_REDIS_COMMANDS.has("select")).toBe(false);
    expect(KNOWN_REDIS_COMMANDS.has("keys")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. InstrumentedRedis.duplicate
// ---------------------------------------------------------------------------

describe("InstrumentedRedis.duplicate", () => {
  let redis: InstrumentedRedis;

  beforeEach(() => {
    redis = new InstrumentedRedis({ lazyConnect: true });
  });

  afterEach(() => {
    redis.disconnect();
  });

  it("returns an InstrumentedRedis instance (not plain Redis)", () => {
    const dup = redis.duplicate();
    expect(dup).toBeInstanceOf(InstrumentedRedis);
    dup.disconnect();
  });

  it("duplicate of a duplicate is still InstrumentedRedis", () => {
    const dup1 = redis.duplicate();
    const dup2 = dup1.duplicate();
    expect(dup2).toBeInstanceOf(InstrumentedRedis);
    dup1.disconnect();
    dup2.disconnect();
  });
});

// ---------------------------------------------------------------------------
// 3a. InstrumentedRedis — BullMQ-compatible safe defaults
//
// BullMQ's `Worker` constructor rejects any pre-built ioredis client whose
// `maxRetriesPerRequest` is not `null`. ioredis's stock default is `20`, so
// `new InstrumentedRedis(url)` without these defaults would throw at worker
// boot:
//   "BullMQ: Your redis options maxRetriesPerRequest must be null."
// `InstrumentedRedis` centralises the defaults so every call site
// (`BullMqWorkerFactory`, `QueueLagGaugeRegistrar`, duplicate()-spawned
// blocking connections) inherits them.
// ---------------------------------------------------------------------------

describe("InstrumentedRedis — BullMQ-compatible safe defaults", () => {
  it("BULLMQ_SAFE_REDIS_DEFAULTS sets the two BullMQ-required keys", () => {
    expect(BULLMQ_SAFE_REDIS_DEFAULTS.maxRetriesPerRequest).toBeNull();
    expect(BULLMQ_SAFE_REDIS_DEFAULTS.enableReadyCheck).toBe(false);
  });

  describe("constructor merges BullMQ-safe defaults", () => {
    it("constructed from a URL string carries the safe defaults", () => {
      // Use lazyConnect via a second arg so no socket open is attempted.
      const r = new InstrumentedRedis("redis://127.0.0.1:6379", {
        lazyConnect: true,
      });
      try {
        expect(r.options.maxRetriesPerRequest).toBeNull();
        expect(r.options.enableReadyCheck).toBe(false);
      } finally {
        r.disconnect();
      }
    });

    it("constructed from an options object carries the safe defaults", () => {
      const r = new InstrumentedRedis({ lazyConnect: true });
      try {
        expect(r.options.maxRetriesPerRequest).toBeNull();
        expect(r.options.enableReadyCheck).toBe(false);
      } finally {
        r.disconnect();
      }
    });

    it("an explicit maxRetriesPerRequest override wins over the safe default", () => {
      const r = new InstrumentedRedis({
        lazyConnect: true,
        maxRetriesPerRequest: 5,
      });
      try {
        expect(r.options.maxRetriesPerRequest).toBe(5);
        // The other safe default is unaffected.
        expect(r.options.enableReadyCheck).toBe(false);
      } finally {
        r.disconnect();
      }
    });

    it("an explicit enableReadyCheck override wins over the safe default", () => {
      const r = new InstrumentedRedis({
        lazyConnect: true,
        enableReadyCheck: true,
      });
      try {
        expect(r.options.enableReadyCheck).toBe(true);
        expect(r.options.maxRetriesPerRequest).toBeNull();
      } finally {
        r.disconnect();
      }
    });
  });

  describe("duplicate() preserves BullMQ-compatible defaults", () => {
    it("duplicate of a default client is also BullMQ-compatible", () => {
      const r = new InstrumentedRedis({ lazyConnect: true });
      const dup = r.duplicate();
      try {
        expect(dup).toBeInstanceOf(InstrumentedRedis);
        expect(dup.options.maxRetriesPerRequest).toBeNull();
        expect(dup.options.enableReadyCheck).toBe(false);
      } finally {
        dup.disconnect();
        r.disconnect();
      }
    });

    it("duplicate({ override }) still produces a BullMQ-compatible client", () => {
      const r = new InstrumentedRedis({ lazyConnect: true });
      const dup = r.duplicate({ db: 3 });
      try {
        expect(dup.options.db).toBe(3);
        expect(dup.options.maxRetriesPerRequest).toBeNull();
        expect(dup.options.enableReadyCheck).toBe(false);
      } finally {
        dup.disconnect();
        r.disconnect();
      }
    });
  });

  describe("BullMqWorkerFactory hands BullMQ a compatible client", () => {
    // The worker boot regression originated here: the factory used to
    // construct `new InstrumentedRedis(this.redisUrl)` from a bare URL
    // string, leaving ioredis's default `maxRetriesPerRequest = 20` in
    // place. BullMQ's `Worker` constructor then threw at bootstrap.
    //
    // To prove the factory itself wires the safe defaults, we invoke
    // `factory.create()` with the BullMQ `Worker` constructor mocked at
    // module scope (see the `jest.mock("bullmq", ...)` block at the
    // top of this file). The mock captures every constructor invocation
    // so we can read the exact `connection` instance the factory passes
    // — closing the gap where a standalone probe could mask a
    // regression in the factory's actual wiring.

    beforeEach(() => {
      bullMqWorkerCalls.length = 0;
    });

    it("passes BullMQ a connection carrying BULLMQ_SAFE_REDIS_DEFAULTS", async () => {
      const factory = new BullMqWorkerFactory("redis://127.0.0.1:6379");
      const handler = jest.fn();
      const created = factory.create("test-queue", handler, {} as WorkerOpts);
      try {
        expect(bullMqWorkerCalls).toHaveLength(1);
        const call = bullMqWorkerCalls[0]!;
        expect(call.queueName).toBe("test-queue");
        // The factory passes its `client` as `options.connection`.
        // Assert on the live ioredis instance, not a sibling probe.
        const conn = call.options.connection as Redis;
        expect(conn).toBeInstanceOf(InstrumentedRedis);
        expect(conn.options.maxRetriesPerRequest).toBeNull();
        expect(conn.options.enableReadyCheck).toBe(false);
      } finally {
        await created.close();
      }
    });

    it("forwards caller-supplied worker options unchanged", async () => {
      const factory = new BullMqWorkerFactory("redis://127.0.0.1:6379");
      const handler = jest.fn();
      const callerOpts = { concurrency: 4, lockDuration: 60_000 } as WorkerOpts;
      const created = factory.create("test-queue", handler, callerOpts);
      try {
        expect(bullMqWorkerCalls).toHaveLength(1);
        const call = bullMqWorkerCalls[0]!;
        expect(call.options).toMatchObject(callerOpts);
        // Connection still carries the safe defaults regardless of
        // caller-supplied WorkerOptions.
        const conn = call.options.connection as Redis;
        expect(conn.options.maxRetriesPerRequest).toBeNull();
        expect(conn.options.enableReadyCheck).toBe(false);
      } finally {
        await created.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 4. InstrumentedRedis.sendCommand — recording on resolve and reject
// ---------------------------------------------------------------------------

describe("InstrumentedRedis.sendCommand — recording", () => {
  let redis: InstrumentedRedis;
  let superSpy: jest.SpyInstance;

  beforeEach(() => {
    redis = new InstrumentedRedis({ lazyConnect: true });
    superSpy = jest
      .spyOn(Redis.prototype, "sendCommand")
      .mockReturnValue(Promise.resolve("ok"));
    mockedRecord.mockClear();
  });

  afterEach(() => {
    superSpy.mockRestore();
    redis.disconnect();
  });

  it("resolves with the value returned by the underlying sendCommand", async () => {
    superSpy.mockReturnValue(Promise.resolve("expected-value"));
    const result = await (redis.sendCommand(makeCommand("get")) as Promise<unknown>);
    expect(result).toBe("expected-value");
  });

  it("calls recordRedisCommandDuration exactly once on resolve", async () => {
    await (redis.sendCommand(makeCommand("get")) as Promise<unknown>);
    expect(mockedRecord).toHaveBeenCalledTimes(1);
  });

  it("records the correct known command label on resolve", async () => {
    await (redis.sendCommand(makeCommand("zadd")) as Promise<unknown>);
    expect(mockedRecord).toHaveBeenCalledWith({ command: "zadd" }, expect.any(Number));
  });

  it('records command="other" for an unknown command on resolve', async () => {
    await (redis.sendCommand(makeCommand("xread")) as Promise<unknown>);
    expect(mockedRecord).toHaveBeenCalledWith({ command: "other" }, expect.any(Number));
  });

  it("records a non-negative duration in seconds on resolve", async () => {
    await (redis.sendCommand(makeCommand("ping")) as Promise<unknown>);
    const calls = mockedRecord.mock.calls;
    for (const [, duration] of calls) {
      expect(duration).toBeGreaterThanOrEqual(0);
      // Unit test completes well under 60 seconds — seconds, not milliseconds
      expect(duration).toBeLessThan(60);
    }
  });

  it("calls recordRedisCommandDuration exactly once on reject", async () => {
    superSpy.mockReturnValue(Promise.reject(new Error("connection refused")));
    await expect(
      redis.sendCommand(makeCommand("get")) as Promise<unknown>,
    ).rejects.toThrow("connection refused");
    expect(mockedRecord).toHaveBeenCalledTimes(1);
  });

  it("records the correct known command label on reject", async () => {
    superSpy.mockReturnValue(Promise.reject(new Error("timeout")));
    await expect(
      redis.sendCommand(makeCommand("set")) as Promise<unknown>,
    ).rejects.toThrow();
    expect(mockedRecord).toHaveBeenCalledWith({ command: "set" }, expect.any(Number));
  });

  it("rethrows the original error object after recording on reject", async () => {
    const originalError = new Error("redis timeout");
    superSpy.mockReturnValue(Promise.reject(originalError));
    await expect(
      redis.sendCommand(makeCommand("get")) as Promise<unknown>,
    ).rejects.toBe(originalError);
  });

  it('records command="other" for an unknown command on reject', async () => {
    superSpy.mockReturnValue(Promise.reject(new Error("fail")));
    await expect(
      redis.sendCommand(makeCommand("brpop")) as Promise<unknown>,
    ).rejects.toThrow();
    expect(mockedRecord).toHaveBeenCalledWith({ command: "other" }, expect.any(Number));
  });

  it("normalises UPPERCASE command names to the bounded label set on resolve", async () => {
    await (redis.sendCommand(makeCommand("GET")) as Promise<unknown>);
    expect(mockedRecord).toHaveBeenCalledWith({ command: "get" }, expect.any(Number));
  });

  it("records duration and returns value when super.sendCommand returns a non-thenable (synchronous path)", () => {
    superSpy.mockReturnValue("sync-value");
    const result = redis.sendCommand(makeCommand("get"));
    expect(result).toBe("sync-value");
    expect(mockedRecord).toHaveBeenCalledTimes(1);
    expect(mockedRecord).toHaveBeenCalledWith({ command: "get" }, expect.any(Number));
  });

  it("records duration and returns null when super.sendCommand returns null (synchronous path)", () => {
    superSpy.mockReturnValue(null);
    const result = redis.sendCommand(makeCommand("ping"));
    expect(result).toBeNull();
    expect(mockedRecord).toHaveBeenCalledTimes(1);
    expect(mockedRecord).toHaveBeenCalledWith({ command: "ping" }, expect.any(Number));
  });
});
