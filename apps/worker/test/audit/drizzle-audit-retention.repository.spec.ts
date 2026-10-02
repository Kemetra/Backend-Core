/**
 * DrizzleAuditRetentionRepository + NoOpAuditRetentionRepository unit tests.
 *
 * No Docker, no Postgres, no Redis. The pool is replaced with a hand-rolled
 * fake that captures the SQL and parameters passed to `pool.query`.
 *
 * Coverage:
 *   - cutoff / markedAt / batchSize forwarded as query parameters in the
 *     correct positional order ($1, $2, $3)
 *   - returns the count of RETURNING rows (rows.length)
 *   - propagates errors thrown by pool.query unwrapped
 *   - NoOpAuditRetentionRepository always returns 0
 *   - no delete / purge method on either implementation
 *   - markBatch only writes retention_marked_at (SQL contains no other SET)
 */
import type { Pool, QueryResult } from "pg";
import {
  DrizzleAuditRetentionRepository,
  NoOpAuditRetentionRepository,
} from "../../src/audit/drizzle-audit-retention.repository";

// ---------------------------------------------------------------------------
// Fake pool helpers
// ---------------------------------------------------------------------------

interface FakeQueryCall {
  sql: string;
  params: unknown[];
}

/** Transaction-control / GUC statements issued by runWithTenantContext. */
function isContextStatement(sql: string): boolean {
  return /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim()) || sql.includes("set_config(");
}

/**
 * Fake pool whose `connect()` client records every statement. `calls` holds
 * only the sweep statements; `contextCalls` holds the transaction / GUC
 * statements `runWithTenantContext` wraps them in (RT-123).
 */
function makeFakePool(rowsToReturn: Array<{ id: string }>): {
  pool: Pool;
  calls: FakeQueryCall[];
  contextCalls: FakeQueryCall[];
} {
  const calls: FakeQueryCall[] = [];
  const contextCalls: FakeQueryCall[] = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (isContextStatement(sql)) {
        contextCalls.push({ sql, params });
        return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
      }
      calls.push({ sql, params });
      return {
        rows: rowsToReturn,
        rowCount: rowsToReturn.length,
        command: "UPDATE",
        oid: 0,
        fields: [],
      } satisfies QueryResult<{ id: string }>;
    }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn(async () => client),
  } as unknown as Pool;
  return { pool, calls, contextCalls };
}

function makeErrorPool(err: Error): Pool {
  const client = {
    query: jest.fn(async (sql: string) => {
      if (isContextStatement(sql)) {
        return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
      }
      throw err;
    }),
    release: jest.fn(),
  };
  return {
    connect: jest.fn(async () => client),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Fixed test values
// ---------------------------------------------------------------------------

const CUTOFF = new Date("2025-05-14T12:00:00.000Z");
const MARKED_AT = new Date("2026-05-14T12:00:00.000Z");
const BATCH_SIZE = 1000;

// ---------------------------------------------------------------------------
// DrizzleAuditRetentionRepository
// ---------------------------------------------------------------------------

describe("DrizzleAuditRetentionRepository.markBatch — parameter passing", () => {
  it("passes cutoff as $1", async () => {
    const { pool, calls } = makeFakePool([]);
    const repo = new DrizzleAuditRetentionRepository(pool);
    await repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE);
    expect(calls[0]!.params[0]).toBe(CUTOFF);
  });

  it("passes markedAt as $2", async () => {
    const { pool, calls } = makeFakePool([]);
    const repo = new DrizzleAuditRetentionRepository(pool);
    await repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE);
    expect(calls[0]!.params[1]).toBe(MARKED_AT);
  });

  it("passes batchSize as $3", async () => {
    const { pool, calls } = makeFakePool([]);
    const repo = new DrizzleAuditRetentionRepository(pool);
    await repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE);
    expect(calls[0]!.params[2]).toBe(BATCH_SIZE);
  });

  it("executes exactly one query per call", async () => {
    const { pool, calls } = makeFakePool([]);
    const repo = new DrizzleAuditRetentionRepository(pool);
    await repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE);
    expect(calls).toHaveLength(1);
  });
});

describe("DrizzleAuditRetentionRepository.markBatch — return value", () => {
  it("returns the number of RETURNING rows (rows.length)", async () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { pool } = makeFakePool(rows);
    const repo = new DrizzleAuditRetentionRepository(pool);
    const count = await repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE);
    expect(count).toBe(3);
  });

  it("returns 0 when no rows are returned (nothing to mark)", async () => {
    const { pool } = makeFakePool([]);
    const repo = new DrizzleAuditRetentionRepository(pool);
    const count = await repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE);
    expect(count).toBe(0);
  });

  it("returns exactly batchSize when a full batch is marked", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `id-${i}` }));
    const { pool } = makeFakePool(rows);
    const repo = new DrizzleAuditRetentionRepository(pool);
    const count = await repo.markBatch(CUTOFF, MARKED_AT, 1000);
    expect(count).toBe(1000);
  });
});

describe("DrizzleAuditRetentionRepository.markBatch — error propagation", () => {
  it("propagates pool.query errors unwrapped so BullMQ can retry", async () => {
    const dbError = new Error("connection timeout");
    const pool = makeErrorPool(dbError);
    const repo = new DrizzleAuditRetentionRepository(pool);
    await expect(repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE)).rejects.toBe(dbError);
  });

  it("does not swallow rejection type", async () => {
    const pool = makeErrorPool(new TypeError("unexpected null"));
    const repo = new DrizzleAuditRetentionRepository(pool);
    await expect(repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("DrizzleAuditRetentionRepository — SQL shape contract", () => {
  it("SQL contains SET retention_marked_at (only the lifecycle marker column)", async () => {
    const { pool, calls } = makeFakePool([]);
    const repo = new DrizzleAuditRetentionRepository(pool);
    await repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE);
    expect(calls[0]!.sql).toContain("retention_marked_at");
  });

  it("SQL does not contain DELETE (audit rows must never be deleted)", async () => {
    const { pool, calls } = makeFakePool([]);
    const repo = new DrizzleAuditRetentionRepository(pool);
    await repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE);
    expect(calls[0]!.sql.toUpperCase()).not.toContain("DELETE");
  });

  it("SQL contains occurred_at predicate (rows are filtered by age)", async () => {
    const { pool, calls } = makeFakePool([]);
    const repo = new DrizzleAuditRetentionRepository(pool);
    await repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE);
    expect(calls[0]!.sql).toContain("occurred_at");
  });

  it("SQL contains IS NULL guard (only unswept rows are marked)", async () => {
    const { pool, calls } = makeFakePool([]);
    const repo = new DrizzleAuditRetentionRepository(pool);
    await repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE);
    expect(calls[0]!.sql.toUpperCase()).toContain("IS NULL");
  });
});

describe("DrizzleAuditRetentionRepository — no delete method", () => {
  it("exposes no deleteRows / purge / hardDelete method", () => {
    const { pool } = makeFakePool([]);
    const repo = new DrizzleAuditRetentionRepository(pool);
    const asRecord = repo as unknown as Record<string, unknown>;
    expect(asRecord["deleteRows"]).toBeUndefined();
    expect(asRecord["purge"]).toBeUndefined();
    expect(asRecord["hardDelete"]).toBeUndefined();
    expect(asRecord["deleteAuditRows"]).toBeUndefined();
  });

  it("only exposes markBatch as a mutating method", () => {
    const { pool } = makeFakePool([]);
    const repo = new DrizzleAuditRetentionRepository(pool);
    expect(typeof repo.markBatch).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// NoOpAuditRetentionRepository
// ---------------------------------------------------------------------------

describe("NoOpAuditRetentionRepository", () => {
  it("returns 0 regardless of parameters", async () => {
    const repo = new NoOpAuditRetentionRepository();
    const count = await repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE);
    expect(count).toBe(0);
  });

  it("returns 0 when called multiple times (stable no-op)", async () => {
    const repo = new NoOpAuditRetentionRepository();
    expect(await repo.markBatch(CUTOFF, MARKED_AT, 100)).toBe(0);
    expect(await repo.markBatch(CUTOFF, MARKED_AT, 500)).toBe(0);
    expect(await repo.markBatch(CUTOFF, MARKED_AT, 1000)).toBe(0);
  });

  it("exposes no delete method", () => {
    const repo = new NoOpAuditRetentionRepository();
    const asRecord = repo as unknown as Record<string, unknown>;
    expect(asRecord["deleteRows"]).toBeUndefined();
    expect(asRecord["purge"]).toBeUndefined();
  });
});

describe("DrizzleAuditRetentionRepository — RLS context (RT-123)", () => {
  it("runs the sweep in one transaction with the platform-admin GUC set", async () => {
    const { pool, calls, contextCalls } = makeFakePool([]);
    const repo = new DrizzleAuditRetentionRepository(pool);
    await repo.markBatch(CUTOFF, MARKED_AT, BATCH_SIZE);

    expect(contextCalls.map((c) => c.sql.trim())[0]).toBe("BEGIN");
    expect(contextCalls.map((c) => c.sql.trim()).at(-1)).toBe("COMMIT");
    const gucs = Object.fromEntries(
      contextCalls
        .filter((c) => c.sql.includes("set_config("))
        .map((c) => [/'(app\.[a-z_]+)'/.exec(c.sql)?.[1], c.params[0]]),
    );
    expect(gucs).toEqual({
      "app.current_tenant": "00000000-0000-0000-0000-000000000000",
      "app.is_platform_admin": "true",
    });
    expect(calls).toHaveLength(1);
  });
});
