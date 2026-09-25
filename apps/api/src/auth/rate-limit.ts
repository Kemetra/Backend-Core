/**
 * Rate-limit helper — slice 3b.
 *
 * Generic fixed-window counter backed by Redis. The same primitive serves
 * the three buckets defined in research.md §PQ-4:
 *
 *   - per-account failed sign-ins: 5 / 15 minutes
 *   - per-IP failed sign-ins:      30 / hour
 *   - per-IP password-reset:       100 / day  (wired by slice 3c)
 *
 * Each bucket is one Redis key. The first hit in a window does
 * `INCR` + `PEXPIRE`; subsequent hits in the same window only `INCR`.
 * `PTTL` is read alongside so callers can surface `resetAt` to the
 * client (HTTP `Retry-After`-equivalent).
 *
 * The implementation depends on a narrow `RedisLike` interface, NOT on
 * `ioredis` directly, so:
 *
 *   - this slice ships zero new runtime deps, and
 *   - tests use an in-memory fake (see `rate-limit.spec.ts`); the
 *     production Redis client is wired in a later slice the same way
 *     `SessionCache` is — adapter on the edge, algorithm in the core.
 *
 * The atomic guarantees we actually need on Redis (`INCR` is atomic,
 * `PEXPIRE` is best-effort idempotent on first set) are weaker than
 * "exactly-N-in-the-window"; that's deliberate. A fixed-window counter
 * with a small over-count under contention is the standard contract for
 * sign-in rate limits. See research.md §PQ-4.
 */
import { Injectable } from "@nestjs/common";

/**
 * Minimal Redis surface this helper requires. Production wiring picks a
 * concrete implementation (`ioredis`, `node-redis`, …) and adapts it to
 * this shape.
 */
export interface RedisLike {
  /** Atomically increment `key` and return the new value. */
  incr(key: string): Promise<number>;
  /**
   * Set the key's TTL (in milliseconds) only if the key has no TTL yet.
   * Implementations should map this to `PEXPIRE … NX` for ioredis or the
   * equivalent option for node-redis. Returns `1` if the TTL was applied,
   * `0` otherwise.
   */
  pexpireNx(key: string, ttlMs: number): Promise<number>;
  /** Milliseconds until expiry. -1 = no TTL set, -2 = key missing. */
  pttl(key: string): Promise<number>;
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
   * Wall-clock ms until the window resets. -1 only on the unusual path
   * where Redis reports no TTL; callers should treat that as "now".
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
   * The first hit in a fresh window seeds the TTL; subsequent hits in
   * the same window keep counting until `limit` is reached, after which
   * `allowed === false` until the window rolls.
   */
  async check(
    bucketName: string,
    identifier: string,
    bucket: RateLimitBucket,
  ): Promise<RateLimitDecision> {
    const key = buildKey(bucketName, identifier);
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.pexpireNx(key, bucket.windowMs);
    }

    const ttl = await this.redis.pttl(key);
    const resetMs = ttl < 0 ? -1 : ttl;
    const remaining = Math.max(0, bucket.limit - count);
    const allowed = count <= bucket.limit;

    return { allowed, count, remaining, resetMs };
  }
}
