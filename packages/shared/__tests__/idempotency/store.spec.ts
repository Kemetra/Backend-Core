/**
 * IdempotencyKeyStore — unit tests (T260)
 *
 * Strategy: Redis-primary + Postgres-mirror.
 * All dependencies are injected as in-memory fakes — no Docker, no live DB,
 * no ioredis.  Clock is also injected so expiry tests are deterministic.
 *
 * Covered scenarios:
 *   1. First write / round-trip: save then findOrCreate returns hit=true.
 *   2. Duplicate key + same fingerprint: returns stored result (cache hit).
 *   3. Duplicate key + different fingerprint: returns hit="collision".
 *   4. Expired entry: treated as not found (hit=false).
 *   5. Tenant isolation: same key in a different tenant scope is a miss.
 *   6. Postgres mirror writer is called with the correct fields on save().
 */

import {
  IdempotencyKeyStore,
  IdempotencyMirrorConflict,
  type RedisLike,
  type PgMirrorWriter,
  type PgMirrorReader,
  type IdempotencyEntry,
  type StoredResult,
} from "../../src/idempotency";

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

function makeRedis(): RedisLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, _opts: { px: number }) {
      store.set(key, value);
    },
  };
}

type PgWriterCall = Parameters<PgMirrorWriter["insert"]>[0];

function makePgWriter(): PgMirrorWriter & { calls: PgWriterCall[] } {
  const calls: PgWriterCall[] = [];
  return {
    calls,
    async insert(row) {
      calls.push(row);
    },
  };
}

function makePgReader(): PgMirrorReader {
  return {
    async find(_params) {
      return null; // empty DB mirror — tests that need a reader inline-construct one
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000002";
const STORE_1 = "11111111-0000-0000-0000-000000000001";
const CLIENT = "pos-device-001";
const KEY = "receipt-20260514-001";

const FP_A = Buffer.from("deadbeef".repeat(4), "hex"); // 16-byte fingerprint
const FP_B = Buffer.from("cafebabe".repeat(4), "hex"); // different fingerprint

const RESULT_A: StoredResult = { status: 201, body: { id: "sale-001" } };

function makeFixedClock(isoDate: string): () => Date {
  const t = new Date(isoDate);
  return () => new Date(t.getTime()); // fresh copy each call
}

// (makeStore was removed in favour of inline construction per test.)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IdempotencyKeyStore", () => {
  // ── 1. First write / round-trip ──────────────────────────────────────────

  describe("1. first write / round-trip", () => {
    it("returns hit=false on the first call (no prior entry)", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      const result = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A,
      );

      expect(result.hit).toBe(false);
    });

    it("returns hit=true after a save with the same fingerprint", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const clock = makeFixedClock("2026-01-01T00:00:00Z");
      const store = new IdempotencyKeyStore({
        redis, pgWriter, pgReader, clock,
      });

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A);

      const result = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A,
      );

      expect(result.hit).toBe(true);
      if (result.hit === true) {
        expect(result.entry.result).toEqual(RESULT_A);
        expect(result.entry.fingerprint.equals(FP_A)).toBe(true);
      }
    });

    it("round-trips response_status and response_body correctly", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });
      const body = { receipt_id: "r-999", total: "42.50", currency: "USD" };

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, {
        status: 201,
        body,
      });
      const result = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A,
      );

      expect(result.hit).toBe(true);
      if (result.hit === true) {
        expect(result.entry.result.status).toBe(201);
        expect(result.entry.result.body).toEqual(body);
      }
    });
  });

  // ── 2. Duplicate key + same fingerprint ─────────────────────────────────

  describe("2. duplicate key + same fingerprint", () => {
    it("returns the stored result without re-executing", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A);

      const first = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A,
      );
      const second = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A,
      );

      expect(first.hit).toBe(true);
      expect(second.hit).toBe(true);
      if (second.hit === true) {
        expect(second.entry.result).toEqual(RESULT_A);
      }
    });

    it("does not call pgWriter again on the second lookup", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A);
      // findOrCreate should NOT write — only save() does
      await store.findOrCreate(TENANT_A, STORE_1, CLIENT, KEY, FP_A);
      await store.findOrCreate(TENANT_A, STORE_1, CLIENT, KEY, FP_A);

      expect(pgWriter.calls).toHaveLength(1); // only the original save()
    });
  });

  // ── 3. Duplicate key + different fingerprint = collision ─────────────────

  describe("3. duplicate key + different fingerprint (collision)", () => {
    it("returns hit='collision' when the fingerprint differs", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A);

      const result = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_B, // different fingerprint
      );

      expect(result.hit).toBe("collision");
    });

    it("collision does not overwrite the stored entry", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A);
      await store.findOrCreate(TENANT_A, STORE_1, CLIENT, KEY, FP_B);

      // Original entry still intact
      const subsequent = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A,
      );
      expect(subsequent.hit).toBe(true);
    });
  });

  // ── 4. Expired entries ───────────────────────────────────────────────────

  describe("4. expired entries are not reused", () => {
    it("returns hit=false when the stored entry has expired (Redis path)", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();

      // Save at t=0 with a 1-second TTL
      const tSave = new Date("2026-01-01T00:00:00Z");
      const tQuery = new Date("2026-01-01T00:00:02Z"); // 2s later — after expiry

      // Advance clock to tQuery for findOrCreate
      let currentTime = tSave;
      const clock = () => new Date(currentTime.getTime());

      const store = new IdempotencyKeyStore({
        redis,
        pgWriter,
        pgReader,
        clock,
        defaultTtlMs: 1_000, // 1 second TTL
      });

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A);

      // Move clock forward past the expiry
      currentTime = tQuery;

      const result = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A,
      );
      expect(result.hit).toBe(false);
    });

    it("returns hit=true for a non-expired entry", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();

      let currentTime = new Date("2026-01-01T00:00:00Z");
      const clock = () => new Date(currentTime.getTime());

      const store = new IdempotencyKeyStore({
        redis,
        pgWriter,
        pgReader,
        clock,
        defaultTtlMs: 60_000, // 1 minute TTL
      });

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A);

      // Only 10 seconds later — well within TTL
      currentTime = new Date("2026-01-01T00:00:10Z");

      const result = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A,
      );
      expect(result.hit).toBe(true);
    });

    it("respects an explicit expiresAt override in save()", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();

      const tNow = new Date("2026-01-01T12:00:00Z");
      const tExpired = new Date("2026-01-01T11:59:59Z"); // in the past

      let currentTime = tNow;
      const clock = () => new Date(currentTime.getTime());
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader, clock });

      // Save with an already-expired expiresAt
      await store.save(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A, tExpired,
      );

      const result = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A,
      );
      expect(result.hit).toBe(false);
    });
  });

  // ── 5. Tenant isolation ──────────────────────────────────────────────────

  describe("5. tenant isolation", () => {
    it("same key in a different tenant scope does not collide", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      // Save for TENANT_A
      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A);

      // TENANT_B with the same key + fingerprint should be a miss
      const tenantBResult = await store.findOrCreate(
        TENANT_B, STORE_1, CLIENT, KEY, FP_A,
      );
      expect(tenantBResult.hit).toBe(false);
    });

    it("same key + same tenant but different store scopes don't collide", async () => {
      const STORE_2 = "22222222-0000-0000-0000-000000000002";
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A);

      const store2Result = await store.findOrCreate(
        TENANT_A, STORE_2, CLIENT, KEY, FP_A,
      );
      expect(store2Result.hit).toBe(false);
    });

    it("null store_id is treated as a distinct scope from a store-scoped key", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      // Save under tenant-level scope (no store)
      await store.save(TENANT_A, null, CLIENT, KEY, FP_A, RESULT_A);

      // Same key but with a store_id should be a miss
      const storeResult = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A,
      );
      expect(storeResult.hit).toBe(false);

      // But the tenant-level scope should still hit
      const tenantResult = await store.findOrCreate(
        TENANT_A, null, CLIENT, KEY, FP_A,
      );
      expect(tenantResult.hit).toBe(true);
    });

    it("TENANT_A and TENANT_B entries coexist without interference", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      const RESULT_B: StoredResult = { status: 200, body: { id: "sale-B" } };

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A);
      await store.save(TENANT_B, STORE_1, CLIENT, KEY, FP_B, RESULT_B);

      const a = await store.findOrCreate(TENANT_A, STORE_1, CLIENT, KEY, FP_A);
      const b = await store.findOrCreate(TENANT_B, STORE_1, CLIENT, KEY, FP_B);

      expect(a.hit).toBe(true);
      expect(b.hit).toBe(true);
      if (a.hit === true) expect(a.entry.result).toEqual(RESULT_A);
      if (b.hit === true) expect(b.entry.result).toEqual(RESULT_B);
    });
  });

  // ── 6. Postgres mirror writer is called with correct fields ──────────────

  describe("6. Postgres mirror writer fields", () => {
    it("calls pgWriter.insert with all required fields on save()", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const now = new Date("2026-05-14T10:00:00Z");
      const expiry = new Date("2026-05-15T10:00:00Z");
      const clock = () => new Date(now.getTime());

      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader, clock });

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A, expiry);

      expect(pgWriter.calls).toHaveLength(1);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const call = pgWriter.calls[0]!;
      expect(call.tenantId).toBe(TENANT_A);
      expect(call.storeId).toBe(STORE_1);
      expect(call.clientId).toBe(CLIENT);
      expect(call.key).toBe(KEY);
      expect(call.fingerprint.equals(FP_A)).toBe(true);
      expect(call.result).toEqual(RESULT_A);
      expect(call.expiresAt).toEqual(expiry);
    });

    it("passes storeId=null when no store scope is given", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      await store.save(TENANT_A, null, CLIENT, KEY, FP_A, RESULT_A);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(pgWriter.calls[0]!.storeId).toBeNull();
    });

    it("pgWriter is NOT called by findOrCreate (read-only path)", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, RESULT_A);
      const callsAfterSave = pgWriter.calls.length;

      await store.findOrCreate(TENANT_A, STORE_1, CLIENT, KEY, FP_A);
      await store.findOrCreate(TENANT_A, STORE_1, CLIENT, KEY, FP_A);

      expect(pgWriter.calls.length).toBe(callsAfterSave); // no new calls
    });

    it("pgWriter.insert is called with result.status and result.body", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const pgReader = makePgReader();
      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });
      const result: StoredResult = { status: 409, body: { error: "conflict" } };

      await store.save(TENANT_A, STORE_1, CLIENT, KEY, FP_A, result);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(pgWriter.calls[0]!.result.status).toBe(409);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(pgWriter.calls[0]!.result.body).toEqual({ error: "conflict" });
    });
  });

  // ── Postgres mirror reader fallback ─────────────────────────────────────

  describe("Postgres mirror reader fallback (cold-start scenario)", () => {
    it("returns hit=true from the Postgres mirror when Redis is empty", async () => {
      const redis = makeRedis(); // cold Redis
      const pgWriter = makePgWriter();

      const stored: IdempotencyEntry = {
        fingerprint: FP_A,
        result: RESULT_A,
        expiresAt: new Date("2099-12-31T23:59:59Z"),
      };

      // pgReader returns the stored entry for our scope
      const pgReader: PgMirrorReader = {
        async find(params) {
          if (
            params.tenantId === TENANT_A &&
            params.storeId === STORE_1 &&
            params.clientId === CLIENT &&
            params.key === KEY
          ) {
            return stored;
          }
          return null;
        },
      };

      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      const result = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A,
      );
      expect(result.hit).toBe(true);
    });

    it("returns hit='collision' from the Postgres mirror when fingerprint differs", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const stored: IdempotencyEntry = {
        fingerprint: FP_A,
        result: RESULT_A,
        expiresAt: new Date("2099-12-31T23:59:59Z"),
      };
      const pgReader: PgMirrorReader = {
        async find(_params) {
          return stored;
        },
      };

      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      const result = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_B,
      );
      expect(result.hit).toBe("collision");
    });

    it("treats an expired Postgres mirror entry as not found", async () => {
      const redis = makeRedis();
      const pgWriter = makePgWriter();
      const expired: IdempotencyEntry = {
        fingerprint: FP_A,
        result: RESULT_A,
        expiresAt: new Date("2020-01-01T00:00:00Z"), // well in the past
      };
      const pgReader: PgMirrorReader = {
        async find(_params) {
          return expired;
        },
      };

      const store = new IdempotencyKeyStore({ redis, pgWriter, pgReader });

      const result = await store.findOrCreate(
        TENANT_A, STORE_1, CLIENT, KEY, FP_A,
      );
      expect(result.hit).toBe(false);
    });
  });

  describe("#614 claim and in-progress mirror rows", () => {
    it("returns in_progress for a claim row with the same fingerprint", async () => {
      const redis = makeRedis();
      const entry: IdempotencyEntry = {
        fingerprint: FP_A,
        result: { status: 0, body: { __dp2IdempotencyClaim: true } },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      };
      const store = new IdempotencyKeyStore({
        redis,
        pgWriter: makePgWriter(),
        pgReader: { async find() { return entry; } },
      });
      const result = await store.findOrCreate(TENANT_A, STORE_1, CLIENT, KEY, FP_A);
      expect(result.hit).toBe("in_progress");
    });

    it("claim returns conflict when the writer raises IdempotencyMirrorConflict", async () => {
      const store = new IdempotencyKeyStore({
        redis: makeRedis(),
        pgWriter: {
          async insert() { /* unused */ },
          async claim() { throw new IdempotencyMirrorConflict(); },
        },
        pgReader: makePgReader(),
      });
      const outcome = await store.claim({
        tenantId: TENANT_A,
        storeId: STORE_1,
        clientId: CLIENT,
        key: KEY,
        fingerprint: FP_A,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      expect(outcome).toBe("conflict");
    });

    it("claim is unsupported when the tenant id is not a uuid", async () => {
      let called = false;
      const store = new IdempotencyKeyStore({
        redis: makeRedis(),
        pgWriter: {
          async insert() { /* unused */ },
          async claim() { called = true; },
        },
        pgReader: makePgReader(),
      });
      const outcome = await store.claim({
        tenantId: "no-tenant",
        storeId: null,
        clientId: CLIENT,
        key: KEY,
        fingerprint: FP_A,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      expect(outcome).toBe("unsupported");
      expect(called).toBe(false);
    });
  });
});
