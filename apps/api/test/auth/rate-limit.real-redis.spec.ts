/**
 * RT-618 — RateLimiter against a real Redis (one atomic round trip, TTL
 * self-heal).
 *
 * The real-Redis describe needs `REDIS_URL` (for example a local
 * `docker run -p 6379:6379 redis:7-alpine`). CI has no Redis service, so it
 * is skipped there and the skip name says so; the Docker-free behaviour is
 * pinned by rate-limit.spec.ts / rate-limit.unit.spec.ts /
 * ioredis-idempotency-adapter.spec.ts.
 *
 * Covered here:
 *   - the adapter's Lua script runs on a real server (INCR, TTL seed, PTTL)
 *   - one command per check (MONITOR-free: counted via the client's
 *     `sendCommand`)
 *   - window rollover
 *   - concurrent checks count 1..N exactly once each and seed one TTL
 *   - the kill-between-commands case: a counter left with no TTL is
 *     given one on the next check
 *   - release (RT-136) is unchanged
 */
import Redis from "ioredis";

import { AlwaysAllowRedis } from "../../src/auth/auth.module";
import { IoredisIdempotencyAdapter } from "../../src/auth/ioredis-idempotency-adapter";
import { RATE_LIMIT_BUCKETS, RateLimiter } from "../../src/auth/rate-limit";

const REDIS_URL = process.env["REDIS_URL"];
const withRealRedis = REDIS_URL ? describe : describe.skip;

describe("AlwaysAllowRedis — the dev/CI stub never limits (RT-618 port)", () => {
  it("every check is allowed with count 1 and resetMs -1", async () => {
    const limiter = new RateLimiter(new AlwaysAllowRedis());
    for (let i = 0; i < 10; i++) {
      await expect(
        limiter.check("signin_account", "alice", RATE_LIMIT_BUCKETS.signInPerAccount),
      ).resolves.toEqual({ allowed: true, count: 1, remaining: 4, resetMs: -1 });
    }
    await expect(limiter.release("signin_account", "alice")).resolves.toBeUndefined();
  });
});

withRealRedis(
  "RT-618 RateLimiter on a real Redis — skipped without REDIS_URL (CI has no Redis service; run locally against redis:7)",
  () => {
    let client: Redis;
    let limiter: RateLimiter;
    const suffix = `${process.pid}-${Date.now()}`;
    const id = (name: string): string => `${name}-${suffix}`;
    const key = (bucket: string, name: string): string => `rl:${bucket}:${id(name)}`;

    beforeAll(async () => {
      client = new Redis(REDIS_URL as string);
      limiter = new RateLimiter(new IoredisIdempotencyAdapter(client));
      await client.ping(); // finish the connection handshake before counting commands
    });

    afterAll(async () => {
      const keys = await client.keys(`rl:*${suffix}`);
      if (keys.length > 0) await client.del(...keys);
      client.disconnect();
    });

    it("check is one Redis command (one round trip)", async () => {
      const spy = jest.spyOn(client, "sendCommand");
      await limiter.check("rt618_one", id("a"), { limit: 5, windowMs: 60_000 });
      const names = spy.mock.calls.map(([cmd]) => (cmd as { name: string }).name.toLowerCase());
      spy.mockRestore();
      expect(names).toHaveLength(1);
      expect(["eval", "evalsha"]).toContain(names[0]);
    });

    it("seeds the TTL on the first hit and returns it with the count", async () => {
      const first = await limiter.check("rt618_seed", id("a"), { limit: 2, windowMs: 60_000 });
      expect(first.count).toBe(1);
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(1);
      expect(first.resetMs).toBeGreaterThan(59_000);
      expect(first.resetMs).toBeLessThanOrEqual(60_000);

      await limiter.check("rt618_seed", id("a"), { limit: 2, windowMs: 60_000 });
      const third = await limiter.check("rt618_seed", id("a"), { limit: 2, windowMs: 60_000 });
      expect(third).toMatchObject({ allowed: false, count: 3, remaining: 0 });
      expect(third.resetMs).toBeLessThanOrEqual(first.resetMs); // never refreshed
    });

    it("rolls the window over once the TTL expires", async () => {
      const policy = { limit: 1, windowMs: 300 };
      expect((await limiter.check("rt618_roll", id("a"), policy)).allowed).toBe(true);
      expect((await limiter.check("rt618_roll", id("a"), policy)).allowed).toBe(false);
      await new Promise((r) => setTimeout(r, 450));
      const fresh = await limiter.check("rt618_roll", id("a"), policy);
      expect(fresh).toMatchObject({ allowed: true, count: 1 });
    });

    it("concurrent checks get distinct counts 1..N and one TTL", async () => {
      const policy = { limit: 25, windowMs: 60_000 };
      const decisions = await Promise.all(
        Array.from({ length: 40 }, () => limiter.check("rt618_conc", id("a"), policy)),
      );
      const counts = decisions.map((d) => d.count).sort((x, y) => x - y);
      expect(counts).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      expect(decisions.filter((d) => d.allowed)).toHaveLength(25);
      expect(await client.pttl(key("rt618_conc", "a"))).toBeGreaterThan(0);
    });

    it("self-heals a counter left with no TTL (crash between the old INCR and PEXPIRE)", async () => {
      const k = key("rt618_heal", "a");
      await client.set(k, "9"); // over the limit and TTL-less: the old code locked it forever
      expect(await client.pttl(k)).toBe(-1);

      const decision = await limiter.check("rt618_heal", id("a"), { limit: 5, windowMs: 60_000 });

      expect(decision).toMatchObject({ allowed: false, count: 10, remaining: 0 });
      expect(decision.resetMs).toBeGreaterThan(59_000);
      const ttl = await client.pttl(k);
      expect(ttl).toBeGreaterThan(59_000);
      expect(ttl).toBeLessThanOrEqual(60_000);
    });

    it("release keeps RT-136 semantics: gives a hit back, keeps the TTL, cleans a below-zero key", async () => {
      const policy = { limit: 5, windowMs: 60_000 };
      await limiter.check("rt618_rel", id("a"), policy);
      await limiter.check("rt618_rel", id("a"), policy);
      await limiter.release("rt618_rel", id("a"));
      expect(await client.get(key("rt618_rel", "a"))).toBe("1");
      expect(await client.pttl(key("rt618_rel", "a"))).toBeGreaterThan(0);

      await limiter.release("rt618_rel", id("b")); // window already gone
      expect(await client.exists(key("rt618_rel", "b"))).toBe(0);
    });
  },
);
