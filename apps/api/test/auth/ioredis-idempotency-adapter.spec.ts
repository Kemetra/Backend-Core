/**
 * ioredis-idempotency-adapter.spec.ts
 *
 * Unit tests for IoredisIdempotencyAdapter.
 *
 * Strategy: use jest.fn()-based mocks for the underlying ioredis client —
 * no real Redis, no ioredis-mock, no Testcontainers. The purpose is to
 * verify that each adapter method calls the real ioredis client with the
 * correct variadic-string arguments, not the options-object form.
 *
 * The factory branch test (`redis-client factory with REDIS_URL set`) uses
 * `jest.mock("ioredis")` to prevent ioredis from opening a real TCP connection.
 */

// ---------------------------------------------------------------------------
// Mock the IoredisIdempotencyAdapter's ioredis dependency for the factory test
// ---------------------------------------------------------------------------

// We separate factory tests into their own describe block that resets the mock.

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import { IoredisIdempotencyAdapter } from "../../src/auth/ioredis-idempotency-adapter";

// ---------------------------------------------------------------------------
// Mock ioredis client factory (plain object, no real connection)
// ---------------------------------------------------------------------------
function makeMockClient() {
  return {
    get: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
    set: jest.fn<Promise<"OK" | null>, unknown[]>().mockResolvedValue("OK"),
    del: jest.fn<Promise<number>, [string]>().mockResolvedValue(1),
    incr: jest.fn<Promise<number>, [string]>().mockResolvedValue(1),
    decr: jest.fn<Promise<number>, [string]>().mockResolvedValue(0),
    pexpire: jest.fn<Promise<number>, unknown[]>().mockResolvedValue(1),
    pttl: jest.fn<Promise<number>, [string]>().mockResolvedValue(900_000),
  };
}

// ===========================================================================
// set() — options-object → variadic-string translation
// ===========================================================================

describe("IoredisIdempotencyAdapter — set() translation", () => {
  it("ADAPTER-1: set with { nx: true, ex } calls client.set(key, value, 'EX', seconds, 'NX')", async () => {
    const client = makeMockClient();
    const adapter = new IoredisIdempotencyAdapter(client as never);

    await adapter.set("some:key", "1", { nx: true, ex: 60 });

    expect(client.set).toHaveBeenCalledTimes(1);
    expect(client.set).toHaveBeenCalledWith("some:key", "1", "EX", 60, "NX");
  });

  it("ADAPTER-2: set with { px } calls client.set(key, value, 'PX', ms)", async () => {
    const client = makeMockClient();
    const adapter = new IoredisIdempotencyAdapter(client as never);

    await adapter.set("store:key", "serialised-value", { px: 5000 });

    expect(client.set).toHaveBeenCalledTimes(1);
    expect(client.set).toHaveBeenCalledWith("store:key", "serialised-value", "PX", 5000);
  });

  it("ADAPTER-3: set with NX passing returns null when client returns null (key already existed)", async () => {
    const client = makeMockClient();
    client.set.mockResolvedValue(null);
    const adapter = new IoredisIdempotencyAdapter(client as never);

    const result = await adapter.set("idem:inflight:abc", "1", { nx: true, ex: 60 });

    expect(result).toBeNull();
  });

  it("ADAPTER-4: set with NX passing returns 'OK' when client returns 'OK' (key was set)", async () => {
    const client = makeMockClient();
    client.set.mockResolvedValue("OK");
    const adapter = new IoredisIdempotencyAdapter(client as never);

    const result = await adapter.set("idem:inflight:abc", "1", { nx: true, ex: 60 });

    expect(result).toBe("OK");
  });
});

// ===========================================================================
// get() — direct delegation
// ===========================================================================

describe("IoredisIdempotencyAdapter — get() delegation", () => {
  it("ADAPTER-5: get(key) delegates to client.get(key) and passes value through", async () => {
    const client = makeMockClient();
    client.get.mockResolvedValue("stored-value");
    const adapter = new IoredisIdempotencyAdapter(client as never);

    const result = await adapter.get("idempotency:t1:null:c1:k1");

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith("idempotency:t1:null:c1:k1");
    expect(result).toBe("stored-value");
  });

  it("ADAPTER-5b: get(key) returns null when client returns null (cache miss)", async () => {
    const client = makeMockClient();
    client.get.mockResolvedValue(null);
    const adapter = new IoredisIdempotencyAdapter(client as never);

    const result = await adapter.get("idempotency:missing:key");

    expect(result).toBeNull();
  });
});

// ===========================================================================
// del() — direct delegation
// ===========================================================================

describe("IoredisIdempotencyAdapter — del() delegation", () => {
  it("ADAPTER-6: del(key) delegates to client.del(key) and returns the number", async () => {
    const client = makeMockClient();
    client.del.mockResolvedValue(1);
    const adapter = new IoredisIdempotencyAdapter(client as never);

    const result = await adapter.del("idem:inflight:abc123");

    expect(client.del).toHaveBeenCalledTimes(1);
    expect(client.del).toHaveBeenCalledWith("idem:inflight:abc123");
    expect(result).toBe(1);
  });
});

// ===========================================================================
// incr() — direct delegation (rate-limit surface)
// ===========================================================================

describe("IoredisIdempotencyAdapter — incr() delegation", () => {
  it("ADAPTER-7: incr(key) delegates to client.incr(key) and passes result through", async () => {
    const client = makeMockClient();
    client.incr.mockResolvedValue(3);
    const adapter = new IoredisIdempotencyAdapter(client as never);

    const result = await adapter.incr("rl:signin_account:alice");

    expect(client.incr).toHaveBeenCalledTimes(1);
    expect(client.incr).toHaveBeenCalledWith("rl:signin_account:alice");
    expect(result).toBe(3);
  });
});

describe("IoredisIdempotencyAdapter — decr() delegation (RT-136)", () => {
  it("ADAPTER-7b: decr(key) delegates to client.decr(key) and passes result through", async () => {
    const client = makeMockClient();
    client.decr.mockResolvedValue(2);
    const adapter = new IoredisIdempotencyAdapter(client as never);

    const result = await adapter.decr("rl:signin_account:alice");

    expect(client.decr).toHaveBeenCalledTimes(1);
    expect(client.decr).toHaveBeenCalledWith("rl:signin_account:alice");
    expect(result).toBe(2);
  });
});

// ===========================================================================
// pexpireNx() — translated to pexpire(key, ms, "NX") (rate-limit surface)
// ===========================================================================

describe("IoredisIdempotencyAdapter — pexpireNx() translation", () => {
  it("ADAPTER-8: pexpireNx(key, ttlMs) calls client.pexpire(key, ttlMs, 'NX')", async () => {
    const client = makeMockClient();
    client.pexpire.mockResolvedValue(1);
    const adapter = new IoredisIdempotencyAdapter(client as never);

    const result = await adapter.pexpireNx("rl:signin_account:alice", 900_000);

    expect(client.pexpire).toHaveBeenCalledTimes(1);
    expect(client.pexpire).toHaveBeenCalledWith("rl:signin_account:alice", 900_000, "NX");
    expect(result).toBe(1);
  });

  it("ADAPTER-8b: pexpireNx returns 0 when key already has a TTL (NX condition not met)", async () => {
    const client = makeMockClient();
    client.pexpire.mockResolvedValue(0);
    const adapter = new IoredisIdempotencyAdapter(client as never);

    const result = await adapter.pexpireNx("rl:signin_account:alice", 900_000);

    expect(result).toBe(0);
  });
});

// ===========================================================================
// pttl() — direct delegation (rate-limit surface)
// ===========================================================================

describe("IoredisIdempotencyAdapter — pttl() delegation", () => {
  it("ADAPTER-9: pttl(key) delegates to client.pttl(key) and passes result through", async () => {
    const client = makeMockClient();
    client.pttl.mockResolvedValue(543_210);
    const adapter = new IoredisIdempotencyAdapter(client as never);

    const result = await adapter.pttl("rl:signin_account:alice");

    expect(client.pttl).toHaveBeenCalledTimes(1);
    expect(client.pttl).toHaveBeenCalledWith("rl:signin_account:alice");
    expect(result).toBe(543_210);
  });
});

// ===========================================================================
// Single client instance — adapter holds exactly one Redis instance
// ===========================================================================

describe("IoredisIdempotencyAdapter — single client instance", () => {
  it("ADAPTER-10: all methods delegate to the same client instance passed at construction", async () => {
    const client = makeMockClient();
    const adapter = new IoredisIdempotencyAdapter(client as never);

    await adapter.get("k1");
    await adapter.set("k2", "v", { px: 100 });
    await adapter.del("k3");
    await adapter.incr("k4");
    await adapter.pexpireNx("k5", 1000);
    await adapter.pttl("k6");

    // All calls went to the same mock client
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.set).toHaveBeenCalledTimes(1);
    expect(client.del).toHaveBeenCalledTimes(1);
    expect(client.incr).toHaveBeenCalledTimes(1);
    expect(client.pexpire).toHaveBeenCalledTimes(1);
    expect(client.pttl).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// AuthModule factory — REDIS_CLIENT provider resolves to IoredisIdempotencyAdapter
// ===========================================================================

/**
 * We mock ioredis entirely so `new Redis(url)` inside `redisClientFactory`
 * does not attempt a TCP connection. This mirrors the `jest.mock("bullmq")`
 * pattern in email-queue.wiring.spec.ts.
 */
jest.mock("ioredis", () => {
  const MockRedis = jest.fn().mockImplementation(function () {
    return {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      incr: jest.fn(),
      pexpire: jest.fn(),
      pttl: jest.fn(),
    };
  });
  return { default: MockRedis, __esModule: true };
});

// Import AFTER jest.mock so the factory's `new Redis(url)` resolves to the mock.
import {
  redisClientFactory,
  AlwaysAllowRedis,
} from "../../src/auth/auth.module";
import { IoredisIdempotencyAdapter } from "../../src/auth/ioredis-idempotency-adapter";

describe("redisClientFactory — REDIS_CLIENT provider wiring", () => {
  const ORIGINAL_REDIS_URL = process.env["REDIS_URL"];

  afterEach(() => {
    if (ORIGINAL_REDIS_URL === undefined) {
      delete process.env["REDIS_URL"];
    } else {
      process.env["REDIS_URL"] = ORIGINAL_REDIS_URL;
    }
  });

  it("ADAPTER-11: returns AlwaysAllowRedis when REDIS_URL is not set", () => {
    delete process.env["REDIS_URL"];
    const result = redisClientFactory();
    expect(result).toBeInstanceOf(AlwaysAllowRedis);
  });

  it("ADAPTER-12: returns IoredisIdempotencyAdapter (not raw Redis) when REDIS_URL is set", () => {
    process.env["REDIS_URL"] = "redis://localhost:6379";
    const result = redisClientFactory();
    expect(result).toBeInstanceOf(IoredisIdempotencyAdapter);
  });
});
