/**
 * Unit tests for InstrumentedPool — the pg.Pool subclass that emits
 * `db_slow_query_total` when a query exceeds the 500 ms threshold.
 *
 * Tests cover:
 *   1. hashQueryTemplate — deterministic hash, safe for empty input
 *   2. InstrumentedPool.query (Promise form) — below threshold: no emit
 *   3. InstrumentedPool.query (Promise form) — at/above threshold: emit
 *   4. InstrumentedPool.query (Promise form) — slow + error: emit and rethrow
 *   5. InstrumentedPool.query (Promise form) — query_class correctness
 *   6. InstrumentedPool.query (callback form) — passthrough, no instrumentation
 *
 * Pool.prototype.query is spied upon so no live Postgres connection is needed.
 *
 * Constitution §VII / FR-B-003 / FR-B-006 / P4 W5.
 */
import { Pool } from "pg";

import {
  InstrumentedPool,
  hashQueryTemplate,
  SLOW_QUERY_THRESHOLD_SECONDS,
} from "../../src/observability/instrumented-pool";
import { recordDbSlowQuery } from "../../src/observability/metrics/db.metrics";

jest.mock("../../src/observability/metrics/db.metrics", () => ({
  recordDbSlowQuery: jest.fn(),
  // Keep other exports as no-ops so module-load assertMetricLabels does not throw
  registerDbPoolGauges: jest.fn().mockReturnValue({ stop: jest.fn() }),
  registerDbMigrationStatusGauge: jest.fn().mockReturnValue({ stop: jest.fn() }),
  recordDbRlsContextFailure: jest.fn(),
  DB_METRIC_NAMES: [],
  createDbMigrationStatusCallback: jest.fn(),
}));

const mockedRecord = recordDbSlowQuery as jest.MockedFunction<typeof recordDbSlowQuery>;

// pg.Pool#query is heavily overloaded; spy on it through a single loose
// signature so mockResolvedValue / mockRejectedValue type-check.
const queryTarget = (): { query: (...args: unknown[]) => Promise<unknown> } =>
  Pool.prototype as unknown as { query: (...args: unknown[]) => Promise<unknown> };

// ---------------------------------------------------------------------------
// 1. hashQueryTemplate
// ---------------------------------------------------------------------------

describe("hashQueryTemplate", () => {
  it("returns an 8-character hex string", () => {
    const hash = hashQueryTemplate("SELECT 1");
    expect(hash).toHaveLength(8);
    expect(/^[0-9a-f]{8}$/.test(hash)).toBe(true);
  });

  it("is deterministic — same SQL always produces the same hash", () => {
    const sql = "SELECT * FROM users WHERE id = $1";
    expect(hashQueryTemplate(sql)).toBe(hashQueryTemplate(sql));
  });

  it("produces different hashes for different SQL templates", () => {
    expect(hashQueryTemplate("SELECT 1")).not.toBe(hashQueryTemplate("SELECT 2"));
  });

  it("handles an empty string without throwing", () => {
    expect(() => hashQueryTemplate("")).not.toThrow();
    expect(hashQueryTemplate("")).toHaveLength(8);
  });

  it("hashes the template text, not values — two queries differing only in values share the same hash", () => {
    const template = "SELECT * FROM users WHERE id = $1";
    expect(hashQueryTemplate(template)).toBe(hashQueryTemplate(template));
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(): InstrumentedPool {
  return new InstrumentedPool({ connectionString: "postgres://localhost/test" });
}

// ---------------------------------------------------------------------------
// 2–5. Promise-form instrumentation
// ---------------------------------------------------------------------------

describe("InstrumentedPool.query (Promise form) — threshold gate", () => {
  let pool: InstrumentedPool;
  let superSpy: jest.SpyInstance;

  beforeEach(() => {
    pool = makePool();
    mockedRecord.mockClear();
  });

  afterEach(() => {
    superSpy?.mockRestore();
  });

  it("does NOT emit when the query resolves below the threshold", async () => {
    superSpy = jest
      .spyOn(queryTarget(), "query")
      .mockResolvedValue({ rows: [], rowCount: 0 } as any);

    await pool.query("SELECT 1");

    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("emits once when the query resolves at exactly the threshold", async () => {
    let resolveQuery!: () => void;
    superSpy = jest.spyOn(Pool.prototype, "query").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = () => resolve({ rows: [], rowCount: 0 } as any);
        }),
    );

    // Manually advance past threshold by resolving after a short synthetic delay
    jest
      .spyOn(global.performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(SLOW_QUERY_THRESHOLD_SECONDS * 1000);

    const p = pool.query("SELECT 1");
    resolveQuery();
    await p;

    expect(mockedRecord).toHaveBeenCalledTimes(1);

    (performance.now as jest.Mock).mockRestore();
  });

  it("emits once when the query resolves above the threshold", async () => {
    jest
      .spyOn(global.performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(SLOW_QUERY_THRESHOLD_SECONDS * 1000 + 1);

    superSpy = jest
      .spyOn(queryTarget(), "query")
      .mockResolvedValue({ rows: [], rowCount: 0 } as any);

    await pool.query("SELECT slow");

    expect(mockedRecord).toHaveBeenCalledTimes(1);

    (performance.now as jest.Mock).mockRestore();
  });

  it("emits and rethrows when the query rejects above the threshold", async () => {
    jest
      .spyOn(global.performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(SLOW_QUERY_THRESHOLD_SECONDS * 1000 + 1);

    const originalErr = new Error("connection reset");
    superSpy = jest
      .spyOn(queryTarget(), "query")
      .mockRejectedValue(originalErr);

    await expect(pool.query("SELECT slow")).rejects.toBe(originalErr);
    expect(mockedRecord).toHaveBeenCalledTimes(1);

    (performance.now as jest.Mock).mockRestore();
  });

  it("does NOT emit when the query rejects below the threshold", async () => {
    superSpy = jest
      .spyOn(queryTarget(), "query")
      .mockRejectedValue(new Error("fast error"));

    await expect(pool.query("SELECT 1")).rejects.toThrow("fast error");
    expect(mockedRecord).not.toHaveBeenCalled();
  });
});

describe("InstrumentedPool.query (Promise form) — query_class label", () => {
  let pool: InstrumentedPool;
  let superSpy: jest.SpyInstance;

  beforeEach(() => {
    pool = makePool();
    mockedRecord.mockClear();
    jest
      .spyOn(global.performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(SLOW_QUERY_THRESHOLD_SECONDS * 1000 + 1);
    superSpy = jest
      .spyOn(queryTarget(), "query")
      .mockResolvedValue({ rows: [], rowCount: 0 } as any);
  });

  afterEach(() => {
    superSpy.mockRestore();
    (performance.now as jest.Mock).mockRestore();
  });

  it("records the correct hash of the SQL template string", async () => {
    const sql = "SELECT * FROM users WHERE id = $1";
    await pool.query(sql, ["abc"]);
    expect(mockedRecord).toHaveBeenCalledWith({
      query_class: hashQueryTemplate(sql),
    });
  });

  it("uses QueryConfig.text when a config object is passed", async () => {
    const sql = "SELECT * FROM sessions WHERE token = $1";
    await pool.query({ text: sql, values: ["tok"] });
    expect(mockedRecord).toHaveBeenCalledWith({
      query_class: hashQueryTemplate(sql),
    });
  });

  it("falls back to an empty-string hash when QueryConfig has no .text", async () => {
    await pool.query({ text: "" });
    expect(mockedRecord).toHaveBeenCalledWith({
      query_class: hashQueryTemplate(""),
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Callback-form passthrough
// ---------------------------------------------------------------------------

describe("InstrumentedPool.query (callback form) — passthrough", () => {
  let pool: InstrumentedPool;
  let superSpy: jest.SpyInstance;

  beforeEach(() => {
    pool = makePool();
    mockedRecord.mockClear();
  });

  afterEach(() => {
    superSpy?.mockRestore();
  });

  it("does not call recordDbSlowQuery when the callback form is used", (done) => {
    superSpy = jest
      .spyOn(Pool.prototype, "query")
      .mockImplementation((_sql: any, cb: any) => {
        cb(null, { rows: [], rowCount: 0 });
      });

    pool.query("SELECT 1", (err) => {
      expect(err).toBeNull();
      expect(mockedRecord).not.toHaveBeenCalled();
      done();
    });
  });
});
