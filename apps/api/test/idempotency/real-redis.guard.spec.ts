/**
 * O7 — idempotency suites must not look green on AlwaysAllowRedis.
 *
 * Relationship before this guard (REDIS_URL unset in unit/CI):
 * - replay.spec.ts / conflict.spec.ts inject a retaining in-memory FakeRedis.
 *   Substituting AlwaysAllowRedis drops the replay header and the 409, so
 *   those assertions are real. The guard below fails the suite if that fake
 *   stops retaining.
 * - in-progress.spec.ts previously used a Redis double with the same shape as
 *   AlwaysAllowRedis (get → null, set → "OK"). The 425 cases never read it;
 *   they stub InProgressMarker.trySet to false. That file now requires a
 *   retaining client. Redis NX itself is not what those cases prove.
 * - Integration harnesses (sales capture, inventory movement, settlement
 *   intent, apply-payment) use a retaining FakeRedis plus a no-op interceptor
 *   pg mirror. Settlement cases that clear the fake and still replay talk to
 *   Postgres through ReceivableService. Those stay; this file does not delete
 *   them. The harnesses now fail if their Redis double stops retaining.
 * - Production redisClientFactory returns AlwaysAllowRedis when REDIS_URL is
 *   unset outside production. That client does not retain keys.
 *
 * Without REDIS_URL the real-Redis describe is skipped, and the skip name
 * states that the run does not prove idempotency. Docker-less unit runs stay
 * green. Pure-function unit tests are not routed through this file.
 */
import Redis from "ioredis";

import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import { AlwaysAllowRedis } from "../../src/auth/auth.module";
import { IoredisIdempotencyAdapter } from "../../src/auth/ioredis-idempotency-adapter";
import { InProgressMarker } from "../../src/idempotency/in-progress-marker";
import { assertIdempotencyRedisRetains } from "./require-retaining-redis";

const REDIS_URL = process.env["REDIS_URL"];
const proveRealRedis = REDIS_URL ? describe : describe.skip;

const TENANT = "aaaaaaaa-0000-4000-8000-0000000000a7";
const CLIENT = "o7-probe";
const FP_A = Buffer.alloc(32, 1);
const FP_B = Buffer.alloc(32, 2);
const SAVED = { status: 201, body: { ok: true } };

function redisOnlyStore(redis: IoredisIdempotencyAdapter): IdempotencyKeyStore {
  return new IdempotencyKeyStore({
    redis,
    pgWriter: { async insert() {} },
    pgReader: { async find() { return null; } },
  });
}

async function saveThenFind(
  redis: IoredisIdempotencyAdapter,
  key: string,
  savedFp: Buffer,
  lookupFp: Buffer,
) {
  const store = redisOnlyStore(redis);
  await store.save(TENANT, null, CLIENT, key, savedFp, SAVED);
  return store.findOrCreate(TENANT, null, CLIENT, key, lookupFp);
}

describe("O7 AlwaysAllowRedis is not idempotency coverage", () => {
  it("fails the retaining-redis guard (set returns OK, get returns null)", async () => {
    const redis = new AlwaysAllowRedis();
    await expect(
      assertIdempotencyRedisRetains(redis, "AlwaysAllowRedis"),
    ).rejects.toThrow(/does not prove idempotency/);
  });

  it("lets both in-flight trySet calls win, so a green pair is not exclusion", async () => {
    const marker = new InProgressMarker(new AlwaysAllowRedis());
    await expect(marker.trySet("o7-always-allow")).resolves.toBe(true);
    await expect(marker.trySet("o7-always-allow")).resolves.toBe(true);
  });
});

proveRealRedis(
  "O7 real Redis idempotency — skipped without REDIS_URL because this run does not prove idempotency (AlwaysAllowRedis returns OK for every set and null for every get)",
  () => {
    let client: Redis;
    let adapter: IoredisIdempotencyAdapter;

    beforeAll(async () => {
      client = new Redis(REDIS_URL as string, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: true,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      await client.connect();
      adapter = new IoredisIdempotencyAdapter(client);
      await assertIdempotencyRedisRetains(adapter, "real-redis.guard.spec.ts");
    });

    afterAll(async () => {
      if (client) await client.quit();
    });

    it("replays a saved record", async () => {
      const key = `o7-replay-${Date.now()}`;
      const hit = await saveThenFind(adapter, key, FP_A, FP_A);
      expect(hit.hit).toBe(true);
      await adapter.del(`idempotency:${TENANT}:null:${CLIENT}:${key}`);
    });

    it("conflicts when the retained fingerprint differs", async () => {
      const key = `o7-conflict-${Date.now()}`;
      const hit = await saveThenFind(adapter, key, FP_A, FP_B);
      expect(hit.hit).toBe("collision");
      await adapter.del(`idempotency:${TENANT}:null:${CLIENT}:${key}`);
    });

    it("in-flight marker loses the second SET NX", async () => {
      const marker = new InProgressMarker(adapter);
      const tuple = `o7-inflight-${Date.now()}`;
      await expect(marker.trySet(tuple, 30)).resolves.toBe(true);
      await expect(marker.trySet(tuple, 30)).resolves.toBe(false);
      await marker.del(tuple);
    });

    it("pg mirror reader answers after the Redis record is removed", async () => {
      const key = `o7-mirror-${Date.now()}`;
      const redisKey = `idempotency:${TENANT}:null:${CLIENT}:${key}`;
      let mirrored: {
        fingerprint: Buffer;
        result: { status: number; body: unknown };
        expiresAt: Date;
      } | null = null;
      const store = new IdempotencyKeyStore({
        redis: adapter,
        pgWriter: {
          async insert(row) {
            mirrored = {
              fingerprint: row.fingerprint,
              result: row.result,
              expiresAt: row.expiresAt,
            };
          },
        },
        pgReader: {
          async find() {
            return mirrored;
          },
        },
      });
      await store.save(TENANT, null, CLIENT, key, FP_A, {
        status: 201,
        body: { mirrored: true },
      });
      expect(mirrored).not.toBeNull();
      await adapter.del(redisKey);
      const hit = await store.findOrCreate(TENANT, null, CLIENT, key, FP_A);
      expect(hit.hit).toBe(true);
      if (hit.hit === true) {
        expect(hit.entry.result.body).toEqual({ mirrored: true });
      }
    });
  },
);
