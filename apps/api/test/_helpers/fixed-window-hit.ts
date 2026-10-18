/**
 * In-memory twin of the RT-618 rate-limit script, shared by the stateful
 * `RedisLike` fakes: INCR (creating the key with no TTL), seed the TTL when
 * the key has none, and return the count with the remaining TTL.
 */
import type { WindowHit } from "../../src/auth/rate-limit";

export interface FixedWindowEntry {
  value: number;
  /** Wall-clock ms at which the key expires; null = no TTL. */
  expiresAt: number | null;
}

/** `live` is the key's unexpired entry (or undefined); `now` is the fake's clock. */
export function fixedWindowHit(
  store: Map<string, FixedWindowEntry>,
  key: string,
  live: FixedWindowEntry | undefined,
  ttlMs: number,
  now: number,
): WindowHit {
  const entry = live ?? { value: 0, expiresAt: null };
  store.set(key, entry);
  entry.value += 1;
  entry.expiresAt ??= now + ttlMs;
  return { count: entry.value, ttlMs: Math.max(0, entry.expiresAt - now) };
}
