/**
 * Docker-free unit tests for `runWithTenantContext` and `readTenantContext`.
 *
 * Covers: input validation, happy-path lifecycle, GUC param encoding,
 * error/rollback path, swallowed-rollback-error path, return-value
 * propagation, client release in all paths, and readTenantContext
 * null-coalesce branches.
 *
 * NOT covered here (deferred to the integration suite in tenant-context.spec.ts):
 *   - Actual GUC persistence and leak prevention — requires real Postgres
 *     transaction semantics.
 *   - RLS row isolation — unit mocks cannot substitute for PostgreSQL RLS.
 *   - Concurrent safety (`pg_sleep` overlap).
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit tests.
 */
import type { Pool, PoolClient } from "pg";
import {
  readTenantContext,
  runWithTenantContext,
} from "../../src/middleware/tenant-context";

const TENANT_A = "0a000000-0000-7000-8000-00000000a001";

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeClient(overrides: Partial<{ queryImpl: jest.Mock; releaseImpl: jest.Mock }> = {}) {
  const query = overrides.queryImpl ?? jest.fn().mockResolvedValue({ rows: [] });
  const release = overrides.releaseImpl ?? jest.fn();
  const client = { query, release } as unknown as PoolClient;
  return { client, query, release };
}

function makePool(client: PoolClient) {
  return {
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// TC-U1 through TC-U8 — input validation (throws before pool.connect())
// ---------------------------------------------------------------------------

describe("runWithTenantContext — input validation", () => {
  const { client } = makeClient();
  const pool = makePool(client);

  it("TC-U1: rejects invalid tenantId string before pool.connect()", async () => {
    await expect(
      runWithTenantContext(pool, { tenantId: "not-a-uuid", isPlatformAdmin: false }, async () => undefined),
    ).rejects.toThrow(/UUID/i);
    expect((pool.connect as jest.Mock)).not.toHaveBeenCalled();
  });

  it("TC-U2: rejects empty string tenantId before pool.connect()", async () => {
    await expect(
      runWithTenantContext(pool, { tenantId: "", isPlatformAdmin: false }, async () => undefined),
    ).rejects.toThrow(/UUID/i);
    expect((pool.connect as jest.Mock)).not.toHaveBeenCalled();
  });

  it("TC-U3: rejects non-string tenantId (number) before pool.connect()", async () => {
    await expect(
      runWithTenantContext(
        pool,
        // @ts-expect-error — testing the runtime guard
        { tenantId: 42, isPlatformAdmin: false },
        async () => undefined,
      ),
    ).rejects.toThrow(/UUID/i);
    expect((pool.connect as jest.Mock)).not.toHaveBeenCalled();
  });

  it("TC-U4: accepts tenantId null (skips UUID check)", async () => {
    const { client: c } = makeClient();
    const p = makePool(c);
    await expect(
      runWithTenantContext(p, { tenantId: null, isPlatformAdmin: true }, async () => undefined),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["TC-U5: accepts valid UUID tenantId", { tenantId: TENANT_A, isPlatformAdmin: false }],
    ["TC-U7: accepts isPlatformAdmin true", { tenantId: TENANT_A, isPlatformAdmin: true }],
    ["TC-U8: accepts isPlatformAdmin false", { tenantId: TENANT_A, isPlatformAdmin: false }],
  ])("%s", async (_label, ctx) => {
    const { client: c } = makeClient();
    const p = makePool(c);
    await expect(runWithTenantContext(p, ctx, async () => undefined)).resolves.toBeUndefined();
  });

  it("TC-U6: rejects non-boolean isPlatformAdmin before pool.connect()", async () => {
    await expect(
      runWithTenantContext(
        pool,
        // @ts-expect-error — testing the runtime guard
        { tenantId: TENANT_A, isPlatformAdmin: "yes" },
        async () => undefined,
      ),
    ).rejects.toThrow(/boolean/i);
    expect((pool.connect as jest.Mock)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TC-U9 — happy path lifecycle
// ---------------------------------------------------------------------------

describe("runWithTenantContext — happy path lifecycle", () => {
  it("TC-U9: begins transaction, sets context GUCs, runs work, commits, releases client", async () => {
    const { client, query, release } = makeClient();
    const pool = makePool(client);
    const work = jest.fn().mockResolvedValue("result");

    await runWithTenantContext(pool, { tenantId: TENANT_A, isPlatformAdmin: false }, work);

    // Transaction lifecycle — BEGIN is first, COMMIT is last query call
    expect(query.mock.calls[0][0]).toBe("BEGIN");
    const lastCall = query.mock.calls[query.mock.calls.length - 1];
    expect(lastCall[0]).toBe("COMMIT");

    // work was called with the client
    expect(work).toHaveBeenCalledWith(client);

    // release always fires
    expect(release).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TC-U10 through TC-U12 — GUC param encoding
// ---------------------------------------------------------------------------

describe("runWithTenantContext — GUC param encoding", () => {
  it("TC-U10: tenantId null maps to NIL UUID GUC param (not empty string)", async () => {
    const { client, query } = makeClient();
    const pool = makePool(client);

    await runWithTenantContext(pool, { tenantId: null, isPlatformAdmin: false }, async () => undefined);

    // Find the set_config call for app.current_tenant and check its param value.
    // NIL UUID is required so the RLS ::uuid cast succeeds; empty string throws
    // "invalid input syntax for type uuid: ''" before the OR branch fires.
    const tenantCall = query.mock.calls.find(
      (args: unknown[]) => typeof args[0] === "string" && (args[0] as string).includes("app.current_tenant"),
    );
    expect(tenantCall).toBeDefined();
    expect(tenantCall![1]).toEqual(["00000000-0000-0000-0000-000000000000"]);
  });

  it("TC-U11: isPlatformAdmin true maps to literal string 'true'", async () => {
    const { client, query } = makeClient();
    const pool = makePool(client);

    await runWithTenantContext(pool, { tenantId: TENANT_A, isPlatformAdmin: true }, async () => undefined);

    const adminCall = query.mock.calls.find(
      (args: unknown[]) => typeof args[0] === "string" && (args[0] as string).includes("app.is_platform_admin"),
    );
    expect(adminCall).toBeDefined();
    expect(adminCall![1]).toEqual(["true"]);
  });

  it("TC-U12: isPlatformAdmin false maps to literal string 'false'", async () => {
    const { client, query } = makeClient();
    const pool = makePool(client);

    await runWithTenantContext(pool, { tenantId: TENANT_A, isPlatformAdmin: false }, async () => undefined);

    const adminCall = query.mock.calls.find(
      (args: unknown[]) => typeof args[0] === "string" && (args[0] as string).includes("app.is_platform_admin"),
    );
    expect(adminCall).toBeDefined();
    expect(adminCall![1]).toEqual(["false"]);
  });
});

// ---------------------------------------------------------------------------
// TC-U13 through TC-U14 — error and rollback paths
// ---------------------------------------------------------------------------

describe("runWithTenantContext — error path", () => {
  it("TC-U13: work error triggers rollback, rethrows original error, releases client", async () => {
    const workError = new Error("work-failed");
    const { client, query, release } = makeClient();
    const pool = makePool(client);
    const work = jest.fn().mockRejectedValue(workError);

    await expect(
      runWithTenantContext(pool, { tenantId: TENANT_A, isPlatformAdmin: false }, work),
    ).rejects.toThrow("work-failed");

    const rollbackCall = query.mock.calls.find(
      (args: unknown[]) => args[0] === "ROLLBACK",
    );
    expect(rollbackCall).toBeDefined();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("TC-U14: rollback error is swallowed and original work error is rethrown", async () => {
    const workError = new Error("original-error");
    const rollbackError = new Error("rollback-failed");

    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql === "ROLLBACK") return Promise.reject(rollbackError);
      return Promise.resolve({ rows: [] });
    });
    const release = jest.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = makePool(client);
    const work = jest.fn().mockRejectedValue(workError);

    await expect(
      runWithTenantContext(pool, { tenantId: TENANT_A, isPlatformAdmin: false }, work),
    ).rejects.toThrow("original-error");

    expect(release).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TC-U15 — return value propagation
// ---------------------------------------------------------------------------

describe("runWithTenantContext — return value", () => {
  it("TC-U15: work return value propagates to caller", async () => {
    const { client } = makeClient();
    const pool = makePool(client);

    const result = await runWithTenantContext(
      pool,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async () => ({ answer: 42 }),
    );

    expect(result).toEqual({ answer: 42 });
  });
});

// ---------------------------------------------------------------------------
// TC-U16 through TC-U17 — client release in all paths (verified above; explicit)
// ---------------------------------------------------------------------------

describe("runWithTenantContext — client always released", () => {
  it("TC-U16: release called on happy path", async () => {
    const { client, release } = makeClient();
    const pool = makePool(client);

    await runWithTenantContext(pool, { tenantId: TENANT_A, isPlatformAdmin: false }, async () => undefined);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("TC-U17: release called even when work throws", async () => {
    const { client, release } = makeClient();
    const pool = makePool(client);

    await expect(
      runWithTenantContext(
        pool,
        { tenantId: TENANT_A, isPlatformAdmin: false },
        async () => { throw new Error("boom"); },
      ),
    ).rejects.toThrow("boom");

    expect(release).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TC-U18 through TC-U20 — readTenantContext
// ---------------------------------------------------------------------------

describe("readTenantContext — return value mapping", () => {
  it("TC-U18: returns nulls when row fields are null", async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ current_tenant: null, is_platform_admin: null }],
    });
    const client = { query } as unknown as PoolClient;

    const result = await readTenantContext(client);

    expect(result).toEqual({ currentTenant: null, isPlatformAdmin: null });
  });

  it("TC-U19: maps row values to camelCase fields", async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ current_tenant: TENANT_A, is_platform_admin: "true" }],
    });
    const client = { query } as unknown as PoolClient;

    const result = await readTenantContext(client);

    expect(result).toEqual({ currentTenant: TENANT_A, isPlatformAdmin: "true" });
  });

  it("TC-U20: returns nulls when rows array is empty", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as PoolClient;

    const result = await readTenantContext(client);

    expect(result).toEqual({ currentTenant: null, isPlatformAdmin: null });
  });
});
