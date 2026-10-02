/**
 * IoredisIdempotencyAdapter — translates the options-object Redis API used by
 * the idempotency and rate-limit modules into ioredis's variadic-string form.
 *
 * Background: ioredis's `set` and `pexpire` use positional string flags
 * ("EX", "NX", "PX", "NX"), not an options object. The idempotency module
 * (InProgressMarker, IdempotencyKeyStore) calls `redis.set(k, v, { nx, ex })`
 * and `redis.set(k, v, { px })`, which would silently store `"[object Object]"`
 * against a real ioredis client. Similarly, `pexpireNx` is not a native ioredis
 * method; the real call is `pexpire(key, ms, "NX")`.
 *
 * This adapter wraps a single `Redis` instance and provides the union of three
 * surfaces:
 *
 *   1. Rate-limit surface (`RedisLike` from `rate-limit.ts`):
 *      `incr`, `pexpireNx`, `pttl`, `decr`, `del`
 *   2. Idempotency store surface (`RedisLike` from `packages/shared`):
 *      `get`, `set(key, value, { px })`
 *   3. In-progress marker surface (`InflightRedis` from `in-progress-marker.ts`):
 *      `set(key, value, { nx: true, ex })`, `del`
 *
 * The adapter is the only point of contact with the real ioredis client; all
 * module-level code continues to call the narrow port interfaces they already
 * depend on.
 */
import Redis from "ioredis";

export class IoredisIdempotencyAdapter {
  constructor(private readonly client: Redis) {}

  // ---------------------------------------------------------------------------
  // Idempotency store + in-progress marker surface
  // ---------------------------------------------------------------------------

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /**
   * Translated `SET` with options object → ioredis variadic string flags.
   *
   * `{ nx: true, ex }` → `SET key value EX seconds NX` (returns "OK" | null)
   * `{ px }`           → `SET key value PX ms`          (returns "OK")
   */
  async set(
    key: string,
    value: string,
    options: { nx: true; ex: number } | { px: number },
  ): Promise<"OK" | null> {
    if ("nx" in options) {
      // ioredis: set(key, value, "EX", seconds, "NX") → "OK" | null
      const result = await this.client.set(key, value, "EX", options.ex, "NX");
      return result;
    }
    // ioredis: set(key, value, "PX", ms) → "OK"
    const result = await this.client.set(key, value, "PX", options.px);
    return result;
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  // ---------------------------------------------------------------------------
  // Rate-limit surface
  // ---------------------------------------------------------------------------

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async decr(key: string): Promise<number> {
    return this.client.decr(key);
  }

  /**
   * Translates `pexpireNx(key, ttlMs)` → ioredis `pexpire(key, ms, "NX")`.
   * The `"NX"` flag sets the TTL only if the key currently has no TTL — this
   * is the standard fixed-window rate-limit seeding semantics.
   */
  async pexpireNx(key: string, ttlMs: number): Promise<number> {
    return this.client.pexpire(key, ttlMs, "NX");
  }

  async pttl(key: string): Promise<number> {
    return this.client.pttl(key);
  }
}
