/**
 * Rate-limit helper — slice 3b.
 *
 * Generic fixed-window counter backed by Redis. The same primitive serves
 * the three buckets defined in research.md §PQ-4:
 *
 *   - per-account failed sign-ins: 5 / 15 minutes (a hit is released
 *     again unless the sign-in fails authentication — RT-136)
 *   - per-IP failed sign-ins:      30 / hour
 *   - per-IP password-reset:       100 / day  (wired by slice 3c)
 *
 * Each bucket is one Redis key. RT-618: every hit is ONE atomic round
 * trip (`RedisLike.incrWindow`, a Lua script in the ioredis adapter) that
 * does `INCR`, seeds the window TTL when the key has none, and returns
 * the count with the remaining TTL so callers can surface `resetAt` to
 * the client (HTTP `Retry-After`-equivalent). Seeding "when the key has
 * no TTL" rather than "when count === 1" is the self-heal: a counter that
 * was ever left without a TTL (a crash between the former separate
 * `INCR` and `PEXPIRE`, a manual `SET`) gets one on its next hit instead
 * of locking the bucket forever.
 *
 * The implementation depends on a narrow `RedisLike` interface, NOT on
 * `ioredis` directly, so:
 *
 *   - this slice ships zero new runtime deps, and
 *   - tests use an in-memory fake (see `rate-limit.spec.ts`); the
 *     production Redis client is wired in a later slice the same way
 *     `SessionCache` is — adapter on the edge, algorithm in the core.
 *
 * A fixed-window counter can admit up to twice the limit across a window
 * boundary; that's deliberate and the standard contract for sign-in rate
 * limits. See research.md §PQ-4.
 */
import { Injectable } from "@nestjs/common";

/**
 * Minimal Redis surface this helper requires. Production wiring picks a
 * concrete implementation (`ioredis`, `node-redis`, …) and adapts it to
 * this shape.
 */
export interface RedisLike {
  /**
   * RT-618: ONE atomic round trip for a fixed-window hit. Increments `key`,
   * gives it a TTL of `ttlMs` if it has none (the first hit of a window, or
   * a counter that lost its TTL), and returns the new count with the key's
   * remaining TTL in milliseconds. The ioredis adapter runs this as a Lua
   * script, so no other command can interleave between the steps.
   */
  incrWindow(key: string, ttlMs: number): Promise<WindowHit>;
  /** Milliseconds until expiry. -1 = no TTL set, -2 = key missing. */
  pttl(key: string): Promise<number>;
  /** Atomically decrement `key` and return the new value. */
  decr(key: string): Promise<number>;
  /** Delete `key`; returns the number of keys removed. */
  del(key: string): Promise<number>;
}

/** Result of {@link RedisLike.incrWindow}. */
export interface WindowHit {
  /** The counter's value after this hit. */
  count: number;
  /** Remaining TTL in ms; negative only from a stub that keeps no TTL. */
  ttlMs: number;
}

/**
 * Public, purpose-built buckets. The values here come from
 * research.md §PQ-4 (defaults). Callers should prefer these constants
 * over magic numbers so the rate-limit policy lives in exactly one
 * place.
 */
export const RATE_LIMIT_BUCKETS = {
  signInPerAccount: { limit: 5, windowMs: 15 * 60 * 1000 },
  signInPerIp: { limit: 30, windowMs: 60 * 60 * 1000 },
  passwordResetPerIp: { limit: 100, windowMs: 24 * 60 * 60 * 1000 },
  passwordResetConfirmPerIp: { limit: 10, windowMs: 15 * 60 * 1000 },
  pairingPerIp: { limit: 30, windowMs: 60 * 60 * 1000 },
  // RT-141: verification-email requests per user. Over the limit the request
  // is still answered 202 (contract) but no further email is sent.
  emailVerifyRequestPerUser: { limit: 3, windowMs: 60 * 60 * 1000 },
  // RT-141: wrong pairing codes across ALL sources. Only guesses that match
  // no code consume it (a hit is released when the code exists), so a
  // distributed enumeration cannot sidestep the per-IP budget.
  pairingInvalidGlobal: { limit: 300, windowMs: 15 * 60 * 1000 },
} as const satisfies Record<string, RateLimitBucket>;

/**
 * POS write-endpoint buckets — ADR 0009 (audit M-2). Keyed per DEVICE (the bucket
 * identifier is the bound device id), NOT per IP or per operator token (ADR 0009
 * D1). These are the ADR 0009 D2 TUNABLE STARTING DEFAULTS — set conservatively
 * above realistic single-terminal throughput; calibrate from the AD-TOOL-003
 * observability layer's real per-device write rates. Enforced by
 * `PosWriteRateLimitGuard`.
 */
export const POS_WRITE_RATE_LIMIT_BUCKETS = {
  posWriteSale: { limit: 300, windowMs: 60 * 60 * 1000 },
  posWriteSettlementIntent: { limit: 120, windowMs: 60 * 60 * 1000 },
  // RT-17: the shift cash-up writes (open, pay-in / pay-out, close). A shift
  // is one open, a few movements and one close per terminal, so this sits
  // far above a real till's rate, including an offline backlog drain.
  posWriteShift: { limit: 120, windowMs: 60 * 60 * 1000 },
  // RT-539: the POS sale history. The same per-device limiter (ADR 0009) is
  // reused for the two reads (list and detail share one bucket, so a 31-day
  // scan cannot be repeated without bound) and for the reprint record.
  posReadSaleHistory: { limit: 1200, windowMs: 60 * 60 * 1000 },
  posWriteSaleReprint: { limit: 120, windowMs: 60 * 60 * 1000 },
  // RT-369: the device token rotation. A till rotates about once per 75 days
  // (plus a retry after a lost response), so this only bounds abuse by a
  // device that holds a live token.
  posRotateDevice: { limit: 10, windowMs: 60 * 60 * 1000 },
  // RT-369: `pos.device.rotation_rejected` rows per matched device. Separate
  // from posRotateDevice, so a refused (stale) token can never spend the
  // live till's rotation budget and 429 its real rotation.
  posRotateRefusalAudit: { limit: 20, windowMs: 60 * 60 * 1000 },
} as const satisfies Record<string, RateLimitBucket>;

export interface RateLimitBucket {
  /** Maximum number of allowed hits in the window. */
  readonly limit: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
}

export interface RateLimitDecision {
  /** True if this hit is allowed; false if the window is exhausted. */
  allowed: boolean;
  /** Hits consumed in the current window after this call. */
  count: number;
  /** Hits remaining before the bucket locks (never negative). */
  remaining: number;
  /**
   * Wall-clock ms until the window resets. -1 only from a stub client that
   * keeps no TTL (`AlwaysAllowRedis`); callers should treat that as "now".
   */
  resetMs: number;
}

const KEY_PREFIX = "rl:";

function buildKey(bucketName: string, identifier: string): string {
  return `${KEY_PREFIX}${bucketName}:${identifier}`;
}

@Injectable()
export class RateLimiter {
  constructor(private readonly redis: RedisLike) {}

  /**
   * Atomically count this hit against a bucket and decide whether it is
   * allowed. The bucket key is `rl:<bucketName>:<identifier>` — bucket
   * name namespaces the policy (e.g. `signin_account`), identifier is
   * the per-caller dimension (account id, IP, …).
   *
   * One Redis round trip (RT-618). The first hit in a fresh window seeds
   * the TTL; subsequent hits in the same window keep counting until
   * `limit` is reached, after which `allowed === false` until the window
   * rolls. A key found without a TTL is given one (self-heal).
   */
  async check(
    bucketName: string,
    identifier: string,
    bucket: RateLimitBucket,
  ): Promise<RateLimitDecision> {
    const key = buildKey(bucketName, identifier);
    const { count, ttlMs } = await this.redis.incrWindow(key, bucket.windowMs);
    const resetMs = ttlMs < 0 ? -1 : ttlMs;
    const remaining = Math.max(0, bucket.limit - count);
    const allowed = count <= bucket.limit;

    return { allowed, count, remaining, resetMs };
  }

  /**
   * Give back one hit taken by {@link check}, for a hit that turned out not
   * to count — e.g. a sign-in that did not fail authentication (RT-136).
   * Reserving with `check` first and releasing afterwards keeps the limit
   * atomic under concurrent attempts.
   *
   * If the window expired in between, DECR recreates the key below zero with
   * no TTL; that key is deleted so the next window starts clean.
   */
  async release(bucketName: string, identifier: string): Promise<void> {
    const key = buildKey(bucketName, identifier);
    const count = await this.redis.decr(key);
    if (count < 0) await this.redis.del(key);
  }
}
