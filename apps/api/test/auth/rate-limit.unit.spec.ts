/**
 * rate-limit.unit.spec.ts
 *
 * Docker-free unit coverage for RateLimiter.
 *
 * Strategy: jest.fn()-based mocks for the RedisLike interface.
 * No real Redis, no Testcontainers, no ioredis.
 *
 * The integration spec (rate-limit.spec.ts) covers the full fixed-window
 * logic with a VirtualClock fake. This spec pins the RateLimiter class's
 * own responsibilities using jest mocks:
 *   - RT-618: `check` is ONE port call (`incrWindow`) with the correct key
 *     (`rl:<bucketName>:<identifier>`) and the bucket's windowMs. The
 *     INCR / TTL seed / PTTL sequence lives inside that one atomic call
 *     (a Lua script in the ioredis adapter), so the old per-command
 *     assertions (INCR, then PEXPIRE NX only on the first hit, then PTTL)
 *     are replaced by single-call assertions.
 *   - resetMs maps to the returned ttlMs when ttlMs >= 0
 *   - resetMs is -1 when the port reports a negative ttlMs (a stub such as
 *     AlwaysAllowRedis; a real Redis always seeds the TTL)
 *   - allowed is true when count <= bucket.limit
 *   - allowed is false when count > bucket.limit
 *   - remaining is max(0, limit - count) — never negative
 *   - different bucket names produce different key namespaces
 */

import {
  RATE_LIMIT_BUCKETS,
  RateLimiter,
  type RedisLike,
  type RateLimitDecision,
  type WindowHit,
} from "../../src/auth/rate-limit";

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockRedis(overrides: Partial<{
  incrResult: number;
  pttlResult: number;
}> = {}): jest.Mocked<RedisLike> {
  return {
    incrWindow: jest
      .fn<Promise<WindowHit>, [string, number]>()
      .mockResolvedValue({ count: overrides.incrResult ?? 1, ttlMs: overrides.pttlResult ?? 900_000 }),
    pttl: jest.fn<Promise<number>, [string]>().mockResolvedValue(900_000),
    decr: jest.fn<Promise<number>, [string]>().mockResolvedValue(0),
    del: jest.fn<Promise<number>, [string]>().mockResolvedValue(1),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUCKET_ACCOUNT = RATE_LIMIT_BUCKETS.signInPerAccount; // limit: 5, windowMs: 900_000
const BUCKET_IP      = RATE_LIMIT_BUCKETS.signInPerIp;       // limit: 30, windowMs: 3_600_000
const BUCKET_RESET   = RATE_LIMIT_BUCKETS.passwordResetPerIp; // limit: 100, windowMs: 86_400_000

// ===========================================================================
// Key construction
// ===========================================================================

describe("RateLimiter — key construction", () => {
  it("RL-U1: builds key as `rl:<bucketName>:<identifier>` and calls incrWindow with it", async () => {
    const redis = makeMockRedis();
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);

    expect(redis.incrWindow).toHaveBeenCalledWith("rl:signin_account:user-alice", BUCKET_ACCOUNT.windowMs);
  });

  it("RL-U2: different bucket names produce different keys for the same identifier", async () => {
    const redis = makeMockRedis();
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);
    await limiter.check("signin_ip", "user-alice", BUCKET_IP);

    const keys = (redis.incrWindow as jest.Mock).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(keys[0]).toBe("rl:signin_account:user-alice");
    expect(keys[1]).toBe("rl:signin_ip:user-alice");
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("RL-U3: same bucket + different identifiers produce different keys", async () => {
    const redis = makeMockRedis();
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);
    await limiter.check("signin_account", "bob", BUCKET_ACCOUNT);

    const keys = (redis.incrWindow as jest.Mock).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(keys[0]).toBe("rl:signin_account:alice");
    expect(keys[1]).toBe("rl:signin_account:bob");
  });
});

// ===========================================================================
// RT-618 — one atomic round trip per check
// ===========================================================================

describe("RateLimiter — one atomic round trip (RT-618)", () => {
  it("RL-U4: check makes exactly one port call and no other Redis command", async () => {
    const redis = makeMockRedis({ incrResult: 1 });
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);

    expect(redis.incrWindow).toHaveBeenCalledTimes(1);
    expect(redis.pttl).not.toHaveBeenCalled();
    expect(redis.decr).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("RL-U5: the window is passed on every hit, not only the first (TTL self-heal lives in the atomic call)", async () => {
    const redis = makeMockRedis({ incrResult: 2 });
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);

    expect(redis.incrWindow).toHaveBeenCalledWith("rl:signin_account:user-alice", BUCKET_ACCOUNT.windowMs);
  });

  it("RL-U6: a hit at the limit is still one call", async () => {
    const redis = makeMockRedis({ incrResult: BUCKET_ACCOUNT.limit });
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);

    expect(redis.incrWindow).toHaveBeenCalledTimes(1);
  });

  it("RL-U7: incrWindow receives correct windowMs for each bucket type", async () => {
    async function checkWindowMs(bucketName: string, bucket: typeof BUCKET_ACCOUNT | typeof BUCKET_IP | typeof BUCKET_RESET): Promise<void> {
      const redis = makeMockRedis({ incrResult: 1 });
      const limiter = new RateLimiter(redis);
      await limiter.check(bucketName, "192.0.2.1", bucket);
      expect(redis.incrWindow).toHaveBeenCalledWith(
        `rl:${bucketName}:192.0.2.1`,
        bucket.windowMs,
      );
    }

    await checkWindowMs("signin_account", BUCKET_ACCOUNT);
    await checkWindowMs("signin_ip", BUCKET_IP);
    await checkWindowMs("pwreset_ip", BUCKET_RESET);
  });

  it("RL-U7b: a port error propagates unchanged (callers own the fail posture)", async () => {
    const redis = makeMockRedis();
    redis.incrWindow.mockRejectedValueOnce(new Error("redis down"));
    const limiter = new RateLimiter(redis);

    await expect(limiter.check("signin_account", "alice", BUCKET_ACCOUNT)).rejects.toThrow("redis down");
  });
});

// ===========================================================================
// Decision — allowed / count / remaining / resetMs
// ===========================================================================

describe("RateLimiter — decision fields (allowed path)", () => {
  it("RL-U8: first hit is allowed, count=1, remaining=limit-1", async () => {
    const redis = makeMockRedis({ incrResult: 1, pttlResult: BUCKET_ACCOUNT.windowMs });
    const limiter = new RateLimiter(redis);

    const decision: RateLimitDecision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.allowed).toBe(true);
    expect(decision.count).toBe(1);
    expect(decision.remaining).toBe(BUCKET_ACCOUNT.limit - 1);
  });

  it("RL-U9: hit at exactly limit is allowed, remaining=0", async () => {
    const redis = makeMockRedis({ incrResult: BUCKET_ACCOUNT.limit, pttlResult: 60_000 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.allowed).toBe(true);
    expect(decision.count).toBe(BUCKET_ACCOUNT.limit);
    expect(decision.remaining).toBe(0);
  });

  it("RL-U10: resetMs equals the returned ttlMs when ttlMs >= 0", async () => {
    const redis = makeMockRedis({ incrResult: 1, pttlResult: 543_210 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.resetMs).toBe(543_210);
  });
});

describe("RateLimiter — decision fields (blocked path)", () => {
  it("RL-U11: hit at limit+1 is blocked, allowed=false, remaining=0, count=limit+1", async () => {
    const redis = makeMockRedis({ incrResult: BUCKET_ACCOUNT.limit + 1, pttlResult: 300_000 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.allowed).toBe(false);
    expect(decision.count).toBe(BUCKET_ACCOUNT.limit + 1);
    expect(decision.remaining).toBe(0);
  });

  it("RL-U12: remaining is never negative — clamped at 0 when count far exceeds limit", async () => {
    const redis = makeMockRedis({ incrResult: 999, pttlResult: 100 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.remaining).toBe(0);
    expect(decision.allowed).toBe(false);
  });
});

// ===========================================================================
// Negative ttlMs from the port (stubs only; a real Redis always seeds the TTL)
// ===========================================================================

describe("RateLimiter — resetMs from negative pttl values", () => {
  it("RL-U13: resetMs is -1 when the port reports ttlMs -1 (stub such as AlwaysAllowRedis)", async () => {
    const redis = makeMockRedis({ incrResult: 2, pttlResult: -1 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.resetMs).toBe(-1);
  });

  it("RL-U14: resetMs is -1 when the port reports ttlMs -2", async () => {
    const redis = makeMockRedis({ incrResult: 2, pttlResult: -2 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.resetMs).toBe(-1);
  });

  it("RL-U15: resetMs is 0 when ttlMs is 0 (key is expiring now)", async () => {
    const redis = makeMockRedis({ incrResult: 2, pttlResult: 0 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.resetMs).toBe(0);
  });
});

// ===========================================================================
// RATE_LIMIT_BUCKETS constants
// ===========================================================================

describe("RATE_LIMIT_BUCKETS constants", () => {
  it("RL-U16: signInPerAccount has limit=5 and windowMs=15min", () => {
    expect(BUCKET_ACCOUNT.limit).toBe(5);
    expect(BUCKET_ACCOUNT.windowMs).toBe(15 * 60 * 1000);
  });

  it("RL-U17: signInPerIp has limit=30 and windowMs=1hour", () => {
    expect(BUCKET_IP.limit).toBe(30);
    expect(BUCKET_IP.windowMs).toBe(60 * 60 * 1000);
  });

  it("RL-U18: passwordResetPerIp has limit=100 and windowMs=24hours", () => {
    expect(BUCKET_RESET.limit).toBe(100);
    expect(BUCKET_RESET.windowMs).toBe(24 * 60 * 60 * 1000);
  });
});
