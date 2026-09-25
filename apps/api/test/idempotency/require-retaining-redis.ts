/**
 * Guard for suites that claim idempotency coverage (replay, conflict,
 * in-flight marker, pg mirror).
 *
 * `AlwaysAllowRedis` returns "OK" for every set and null for every get, so
 * every trySet wins and every findOrCreate misses while the suite stays green.
 * A retaining double (or a real Redis) keeps the suite. A non-retaining client
 * fails here instead of looking like coverage.
 *
 * Unit tests of pure functions do not call this. Docker-less runs
 * (`MIGRATION_TEST_ALLOW_SKIP=1`) are unchanged: this does not open a socket.
 */
export const IDEMPOTENCY_REDIS_UNPROVEN =
  "does not prove idempotency: Redis client did not retain the probe key. " +
  "AlwaysAllowRedis returns OK for every set and null for every get. " +
  "Point REDIS_URL at a real Redis. This run does not prove replay, conflict, " +
  "the in-flight marker, or the pg mirror.";

export async function assertIdempotencyRedisRetains(
  redis: {
    get(key: string): Promise<string | null>;
    set(
      key: string,
      value: string,
      options: { px: number },
    ): Promise<unknown>;
  },
  suite: string,
): Promise<void> {
  const key = `idempotency:probe:${suite}`;
  await redis.set(key, "retained", { px: 60_000 });
  const got = await redis.get(key);
  if (got !== "retained") {
    throw new Error(`${suite} ${IDEMPOTENCY_REDIS_UNPROVEN}`);
  }
}
