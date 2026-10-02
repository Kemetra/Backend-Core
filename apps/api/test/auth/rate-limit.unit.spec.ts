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
 *   - INCR called with correct key (`rl:<bucketName>:<identifier>`)
 *   - PEXPIRE NX called only on first hit (count === 1)
 *   - PEXPIRE NX NOT called on subsequent hits
 *   - resetMs maps to pttl result when ttl >= 0
 *   - resetMs is -1 when pttl returns negative (no-TTL / missing-key path)
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
} from "../../src/auth/rate-limit";

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockRedis(overrides: Partial<{
  incrResult: number;
  pexpireNxResult: number;
  pttlResult: number;
}> = {}): jest.Mocked<RedisLike> {
  return {
    incr: jest.fn<Promise<number>, [string]>().mockResolvedValue(overrides.incrResult ?? 1),
    pexpireNx: jest.fn<Promise<number>, [string, number]>().mockResolvedValue(overrides.pexpireNxResult ?? 1),
    pttl: jest.fn<Promise<number>, [string]>().mockResolvedValue(overrides.pttlResult ?? 900_000),
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
  it("RL-U1: builds key as `rl:<bucketName>:<identifier>` and calls incr with it", async () => {
    const redis = makeMockRedis();
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);

    expect(redis.incr).toHaveBeenCalledWith("rl:signin_account:user-alice");
  });

  it("RL-U2: different bucket names produce different keys for the same identifier", async () => {
    const redis = makeMockRedis();
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);
    await limiter.check("signin_ip", "user-alice", BUCKET_IP);

    const keys = (redis.incr as jest.Mock).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(keys[0]).toBe("rl:signin_account:user-alice");
    expect(keys[1]).toBe("rl:signin_ip:user-alice");
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("RL-U3: same bucket + different identifiers produce different keys", async () => {
    const redis = makeMockRedis();
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);
    await limiter.check("signin_account", "bob", BUCKET_ACCOUNT);

    const keys = (redis.incr as jest.Mock).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(keys[0]).toBe("rl:signin_account:alice");
    expect(keys[1]).toBe("rl:signin_account:bob");
  });
});

// ===========================================================================
// PEXPIRE NX seeding behaviour
// ===========================================================================

describe("RateLimiter — PEXPIRE NX seeding", () => {
  it("RL-U4: calls pexpireNx on first hit (count === 1) with key and bucket.windowMs", async () => {
    const redis = makeMockRedis({ incrResult: 1 });
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);

    expect(redis.pexpireNx).toHaveBeenCalledTimes(1);
    expect(redis.pexpireNx).toHaveBeenCalledWith(
      "rl:signin_account:user-alice",
      BUCKET_ACCOUNT.windowMs,
    );
  });

  it("RL-U5: does NOT call pexpireNx when count > 1 (window already seeded)", async () => {
    const redis = makeMockRedis({ incrResult: 2 });
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);

    expect(redis.pexpireNx).not.toHaveBeenCalled();
  });

  it("RL-U6: does NOT call pexpireNx when count equals bucket.limit (not first hit)", async () => {
    const redis = makeMockRedis({ incrResult: BUCKET_ACCOUNT.limit });
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);

    expect(redis.pexpireNx).not.toHaveBeenCalled();
  });

  it("RL-U7: pexpireNx receives correct windowMs for each bucket type", async () => {
    async function checkWindowMs(bucketName: string, bucket: typeof BUCKET_ACCOUNT | typeof BUCKET_IP | typeof BUCKET_RESET): Promise<void> {
      const redis = makeMockRedis({ incrResult: 1 });
      const limiter = new RateLimiter(redis);
      await limiter.check(bucketName, "192.0.2.1", bucket);
      expect(redis.pexpireNx).toHaveBeenCalledWith(
        `rl:${bucketName}:192.0.2.1`,
        bucket.windowMs,
      );
    }

    await checkWindowMs("signin_account", BUCKET_ACCOUNT);
    await checkWindowMs("signin_ip", BUCKET_IP);
    await checkWindowMs("pwreset_ip", BUCKET_RESET);
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

  it("RL-U10: resetMs equals pttl return value when pttl >= 0", async () => {
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
// PTTL negative paths (no-TTL / missing-key edge cases)
// ===========================================================================

describe("RateLimiter — resetMs from negative pttl values", () => {
  it("RL-U13: resetMs is -1 when pttl returns -1 (key has no TTL)", async () => {
    const redis = makeMockRedis({ incrResult: 2, pttlResult: -1 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.resetMs).toBe(-1);
  });

  it("RL-U14: resetMs is -1 when pttl returns -2 (key does not exist)", async () => {
    const redis = makeMockRedis({ incrResult: 2, pttlResult: -2 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.resetMs).toBe(-1);
  });

  it("RL-U15: resetMs is 0 when pttl returns 0 (key is expiring now)", async () => {
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
