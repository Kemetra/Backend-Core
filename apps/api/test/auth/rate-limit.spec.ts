/**
 * T106 — rate-limit helper spec.
 *
 * Strategy B (per the slice approval): no real Redis. The helper depends
 * on a narrow `RedisLike` interface; this spec drives an in-memory fake
 * with simulated time so we exercise INCR + PEXPIRE NX + PTTL behaviour
 * without booting a container.
 *
 * The fake's behaviour mirrors the parts of Redis the helper relies on:
 *
 *   - `incrWindow` mirrors the RT-618 Lua script, as one atomic step:
 *     INCR (creating the key with value 1 and no TTL), then PTTL, then
 *     PEXPIRE when the key has no TTL; it returns the count and the TTL.
 *   - PTTL returns -2 for a missing key, -1 for no-TTL, otherwise ms.
 *   - Expiry is checked lazily on every operation against a virtual
 *     clock the test controls.
 *
 * Coverage:
 *   - per-account 5 / 15 min: 5 allowed, 6th blocked, allowed again
 *     after the window
 *   - per-IP 30 / hr: 30 allowed, 31st blocked, distinct IPs do not
 *     share counters
 *   - per-IP 100 / day password-reset: 100 allowed, 101st blocked
 *     (reuses the same primitive — proves the helper is generic)
 *   - the TTL is returned with the count so callers can surface `resetMs`
 *   - the TTL is seeded once per window and never refreshed
 *   - RT-618: a key left without a TTL (process died between the old
 *     INCR and PEXPIRE) is given one on the next check (no permanent lock)
 */
import {
  POS_WRITE_RATE_LIMIT_BUCKETS,
  RATE_LIMIT_BUCKETS,
  RateLimiter,
  type RedisLike,
} from "../../src/auth/rate-limit";

class VirtualClock {
  constructor(private now = 0) {}
  advance(ms: number): void {
    this.now += ms;
  }
  read(): number {
    return this.now;
  }
}

interface FakeEntry {
  value: number;
  /** Wall-clock ms (clock.read()) at which the key expires. null = no TTL. */
  expiresAt: number | null;
}

class FakeRedis implements RedisLike {
  private readonly store = new Map<string, FakeEntry>();
  /** How many times a TTL was seeded — proves first-hit seeding and self-heal. */
  ttlSeeded = 0;

  constructor(private readonly clock: VirtualClock) {}

  private gc(key: string): FakeEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && this.clock.read() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async incrWindow(key: string, ttlMs: number): Promise<{ count: number; ttlMs: number }> {
    let live = this.gc(key);
    if (!live) {
      live = { value: 0, expiresAt: null };
      this.store.set(key, live);
    }
    live.value += 1;
    if (live.expiresAt === null) {
      live.expiresAt = this.clock.read() + ttlMs;
      this.ttlSeeded += 1;
    }
    return { count: live.value, ttlMs: live.expiresAt - this.clock.read() };
  }

  /** Test seam: a counter left with no TTL, as a crash between the old INCR and PEXPIRE would. */
  plantWithoutTtl(key: string, value: number): void {
    this.store.set(key, { value, expiresAt: null });
  }

  async pttl(key: string): Promise<number> {
    const live = this.gc(key);
    if (!live) return -2;
    if (live.expiresAt === null) return -1;
    return Math.max(0, live.expiresAt - this.clock.read());
  }

  async decr(key: string): Promise<number> {
    const live = this.gc(key);
    if (!live) {
      this.store.set(key, { value: -1, expiresAt: null });
      return -1;
    }
    live.value -= 1;
    return live.value;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  has(key: string): boolean {
    return this.gc(key) !== undefined;
  }
}

let clock: VirtualClock;
let redis: FakeRedis;
let limiter: RateLimiter;

beforeEach(() => {
  clock = new VirtualClock();
  redis = new FakeRedis(clock);
  limiter = new RateLimiter(redis);
});

describe("RateLimiter — per-account sign-in (5 / 15 min)", () => {
  const bucket = RATE_LIMIT_BUCKETS.signInPerAccount;
  const account = "user-alice";

  it("allows the first 5 hits and blocks the 6th in the same window", async () => {
    for (let i = 1; i <= 5; i++) {
      const decision = await limiter.check("signin_account", account, bucket);
      expect(decision.allowed).toBe(true);
      expect(decision.count).toBe(i);
      expect(decision.remaining).toBe(5 - i);
    }
    const blocked = await limiter.check("signin_account", account, bucket);
    expect(blocked.allowed).toBe(false);
    expect(blocked.count).toBe(6);
    expect(blocked.remaining).toBe(0);
  });

  it("seeds the TTL only on the first hit and never refreshes it on subsequent hits", async () => {
    await limiter.check("signin_account", account, bucket);
    clock.advance(1_000);
    await limiter.check("signin_account", account, bucket);
    const third = await limiter.check("signin_account", account, bucket);
    expect(redis.ttlSeeded).toBe(1);
    expect(third.resetMs).toBe(bucket.windowMs - 1_000); // not refreshed by later hits
  });

  it("exposes resetMs that decreases as time advances", async () => {
    const first = await limiter.check("signin_account", account, bucket);
    expect(first.resetMs).toBe(bucket.windowMs);

    clock.advance(60_000);
    const later = await limiter.check("signin_account", account, bucket);
    expect(later.resetMs).toBe(bucket.windowMs - 60_000);
  });

  it("allows again once the 15-minute window has rolled", async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check("signin_account", account, bucket);
    }
    const blocked = await limiter.check("signin_account", account, bucket);
    expect(blocked.allowed).toBe(false);

    clock.advance(bucket.windowMs); // window expires
    const fresh = await limiter.check("signin_account", account, bucket);
    expect(fresh.allowed).toBe(true);
    expect(fresh.count).toBe(1);
    expect(fresh.remaining).toBe(4);
  });

  it("does NOT share counters across different accounts", async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check("signin_account", "alice", bucket);
    }
    const aliceBlocked = await limiter.check("signin_account", "alice", bucket);
    expect(aliceBlocked.allowed).toBe(false);

    const bobFirst = await limiter.check("signin_account", "bob", bucket);
    expect(bobFirst.allowed).toBe(true);
    expect(bobFirst.count).toBe(1);
  });
});

describe("RateLimiter — per-IP sign-in (30 / hour)", () => {
  const bucket = RATE_LIMIT_BUCKETS.signInPerIp;

  it("allows 30, blocks the 31st, and tracks remaining correctly", async () => {
    for (let i = 1; i <= 30; i++) {
      const dec = await limiter.check("signin_ip", "203.0.113.7", bucket);
      expect(dec.allowed).toBe(true);
      expect(dec.remaining).toBe(30 - i);
    }
    const blocked = await limiter.check("signin_ip", "203.0.113.7", bucket);
    expect(blocked.allowed).toBe(false);
    expect(blocked.count).toBe(31);
  });

  it("tracks two IPs independently", async () => {
    for (let i = 0; i < 30; i++) {
      await limiter.check("signin_ip", "203.0.113.7", bucket);
    }
    const aBlocked = await limiter.check("signin_ip", "203.0.113.7", bucket);
    expect(aBlocked.allowed).toBe(false);

    const bFirst = await limiter.check("signin_ip", "198.51.100.42", bucket);
    expect(bFirst.allowed).toBe(true);
    expect(bFirst.count).toBe(1);
  });

  it("uses different namespaces from per-account so the same identifier is independent", async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check("signin_account", "203.0.113.7", RATE_LIMIT_BUCKETS.signInPerAccount);
    }
    // Account bucket is exhausted, but the IP bucket for the same string
    // value should still be untouched.
    const ipFirst = await limiter.check("signin_ip", "203.0.113.7", bucket);
    expect(ipFirst.allowed).toBe(true);
    expect(ipFirst.count).toBe(1);
  });
});

describe("RateLimiter — per-IP password reset (100 / day)", () => {
  const bucket = RATE_LIMIT_BUCKETS.passwordResetPerIp;

  it("allows 100 hits and blocks the 101st (proves the primitive is generic)", async () => {
    for (let i = 1; i <= 100; i++) {
      const dec = await limiter.check("pwreset_ip", "203.0.113.7", bucket);
      expect(dec.allowed).toBe(true);
    }
    const blocked = await limiter.check("pwreset_ip", "203.0.113.7", bucket);
    expect(blocked.allowed).toBe(false);
    expect(blocked.count).toBe(101);
    expect(blocked.remaining).toBe(0);
  });
});

describe("RateLimiter — release (RT-136)", () => {
  const bucket = RATE_LIMIT_BUCKETS.signInPerAccount;
  const account = "user-alice";

  it("a released hit no longer counts toward the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check("signin_account", account, bucket);
      await limiter.release("signin_account", account);
    }
    // Five reserved-and-released hits leave the full budget.
    for (let i = 0; i < 5; i++) {
      expect((await limiter.check("signin_account", account, bucket)).allowed).toBe(true);
    }
    expect((await limiter.check("signin_account", account, bucket)).allowed).toBe(false);
  });

  it("keeps the window's original TTL when a hit is released", async () => {
    await limiter.check("signin_account", account, bucket);
    clock.advance(60_000);
    await limiter.check("signin_account", account, bucket);
    await limiter.release("signin_account", account);
    const next = await limiter.check("signin_account", account, bucket);
    expect(next.count).toBe(2);
    expect(next.resetMs).toBe(bucket.windowMs - 60_000);
  });

  it("deletes the key instead of leaving a negative, TTL-less counter when the window expired first", async () => {
    await limiter.check("signin_account", account, bucket);
    clock.advance(bucket.windowMs);
    await limiter.release("signin_account", account);
    expect(redis.has("rl:signin_account:user-alice")).toBe(false);
    const fresh = await limiter.check("signin_account", account, bucket);
    expect(fresh.count).toBe(1);
    expect(fresh.resetMs).toBe(bucket.windowMs);
  });
});

describe("RateLimiter — TTL self-heal (RT-618)", () => {
  const bucket = RATE_LIMIT_BUCKETS.signInPerAccount;
  const key = "rl:signin_account:user-alice";

  it("gives a TTL-less counter a TTL on the next check instead of locking it forever", async () => {
    redis.plantWithoutTtl(key, bucket.limit + 3); // locked, and would never roll
    const blocked = await limiter.check("signin_account", "user-alice", bucket);
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetMs).toBe(bucket.windowMs);
    expect(await redis.pttl(key)).toBe(bucket.windowMs);

    clock.advance(bucket.windowMs);
    const fresh = await limiter.check("signin_account", "user-alice", bucket);
    expect(fresh.allowed).toBe(true);
    expect(fresh.count).toBe(1);
  });

  it("returns the same decision fields for every existing bucket on a fresh window", async () => {
    const all = { ...RATE_LIMIT_BUCKETS, ...POS_WRITE_RATE_LIMIT_BUCKETS };
    for (const [name, policy] of Object.entries(all)) {
      const decision = await limiter.check(name, "same-id", policy);
      expect(decision).toEqual({
        allowed: true,
        count: 1,
        remaining: policy.limit - 1,
        resetMs: policy.windowMs,
      });
    }
  });
});
