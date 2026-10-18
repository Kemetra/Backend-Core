/**
 * IoredisIdempotencyAdapter — translates the options-object Redis API used by
 * the idempotency and rate-limit modules into ioredis's variadic-string form.
 *
 * Background: ioredis's `set` uses positional string flags ("EX", "NX",
 * "PX"), not an options object. The idempotency module
 * (InProgressMarker, IdempotencyKeyStore) calls `redis.set(k, v, { nx, ex })`
 * and `redis.set(k, v, { px })`, which would silently store `"[object Object]"`
 * against a real ioredis client. The rate-limit hit (`incrWindow`, RT-618) is
 * not a native command either; it runs as one atomic Lua script (EVAL).
 *
 * This adapter wraps a single `Redis` instance and provides the union of three
 * surfaces:
 *
 *   1. Rate-limit surface (`RedisLike` from `rate-limit.ts`):
 *      `incrWindow`, `pttl`, `decr`, `del`
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

import type { WindowHit } from "./rate-limit";

/**
 * RT-618: the fixed-window hit as one atomic script. INCR, then seed the
 * window TTL if the key has none (PTTL -1: the first hit, or a counter that
 * lost its TTL; this is the self-heal), then return `{count, pttl}`. Inside a
 * script, PTTL plus a conditional PEXPIRE is equivalent to `PEXPIRE ... NX`
 * (no other command can interleave) and does not need Redis 7's NX flag.
 */
export const INCR_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export class IoredisIdempotencyAdapter {
  constructor(private readonly client: Redis) {}

  // ---------------------------------------------------------------------------
  // Idempotency store + in-progress marker surface
  // ---------------------------------------------------------------------------

  get(key: string): Promise<string | null> {
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

  del(key: string): Promise<number> {
    return this.client.del(key);
  }

  // ---------------------------------------------------------------------------
  // Rate-limit surface
  // ---------------------------------------------------------------------------

  /**
   * One EVAL round trip (RT-618). The script is about 200 bytes; Redis caches
   * its compiled form by SHA, so resending it costs only the bytes.
   */
  async incrWindow(key: string, ttlMs: number): Promise<WindowHit> {
    const reply: unknown = await this.client.eval(INCR_WINDOW_SCRIPT, 1, key, String(ttlMs));
    if (!Array.isArray(reply) || reply.length !== 2 || !isInteger(reply[0]) || !isInteger(reply[1])) {
      throw new Error("IoredisIdempotencyAdapter.incrWindow: unexpected reply from the rate-limit script");
    }
    return { count: reply[0], ttlMs: reply[1] };
  }

  decr(key: string): Promise<number> {
    return this.client.decr(key);
  }

  pttl(key: string): Promise<number> {
    return this.client.pttl(key);
  }
}
