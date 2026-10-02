/**
 * stores.repository.unit.spec.ts
 *
 * Docker-free unit coverage for StoresRepository (T304-B-api coverage lift).
 *
 * Strategy: hand-written fake for the Drizzle DB chain. Each public method is
 * exercised with a fresh `makeFakeDb()` closure per test so there is no shared
 * mutable state leaking between cases.
 *
 * The Testcontainers integration spec covers:
 *   - Real RLS cross-tenant isolation via runWithTenantContext
 *   - Real clock / now() semantics for deleted_at / updated_at
 *   - FK constraints (tenant_id)
 *   - Partial unique index stores_tenant_code_uidx (23505 → 409)
 * None of those are duplicated here.
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit mocks.
 * The fake DB resolves whatever rows are seeded in `_selectRows` /
 * `_insertRows` regardless of tenant context — RLS is a DB-layer guarantee
 * tested only with a real Postgres instance.
 */

import { StoresRepository } from "../../src/stores/stores.repository";
import type { StoreRow } from "@data-pulse-2/db/schema";
import type { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const STORE_ID = "0193c000-0000-7000-8000-000000000001";
const TENANT_ID = "0193c000-0000-7000-8000-0000000000a1";
const STORE_ID_2 = "0193c000-0000-7000-8000-000000000002";

// ---------------------------------------------------------------------------
// Module-level state — reset in beforeEach
// ---------------------------------------------------------------------------

let _selectRows: StoreRow[] = [];
let _insertRows: StoreRow[] = [];
let _updateRowCount: number | null = 1;
let _updateReturningRows: StoreRow[] = [];

// ---------------------------------------------------------------------------
// Fake Drizzle DB
// ---------------------------------------------------------------------------
//
// StoresRepository uses five chain shapes:
//
//   1. select().from(t).where(c)           -> Promise<StoreRow[]>   (listInTenant)
//   2. select(p).from(t).where(c).limit(1) -> Promise<StoreRow[]>   (existsInTenant / findById)
//   3. insert(t).values(v).returning()     -> Promise<StoreRow[]>   (create)
//   4. update(t).set(p).where(c).returning()-> Promise<StoreRow[]>  (update)
//   5. update(t).set(p).where(c)           -> awaitable { rowCount } (softDelete)
//
// Shape 1 vs 5 (both await .where() directly) are disambiguated by _chainMode
// captured in the closure — "select" resolves to _selectRows, "update"
// resolves to { rowCount: _updateRowCount }.
//
// Shape 4 vs 5 (both start with update) are disambiguated by whether
// .returning() is called after .where().

function makeFakeDb() {
  let _chainMode: "select" | "update" = "select";

  const insertChain = {
    values: (_v: unknown) => insertChain,
    returning: () => Promise.resolve(_insertRows),
  };

  const whereResult = {
    // Shape 1 (listInTenant, awaited directly as select) or
    // Shape 5 (softDelete, awaited directly as update).
    then: (
      resolve: (v: StoreRow[] | { rowCount: number | null }) => void,
      _reject?: (e: unknown) => void,
    ) => {
      if (_chainMode === "update") {
        return Promise.resolve({ rowCount: _updateRowCount }).then(
          resolve as (v: { rowCount: number | null }) => void,
          _reject,
        );
      }
      return Promise.resolve(_selectRows).then(
        resolve as (v: StoreRow[]) => void,
        _reject,
      );
    },
    // Shape 4: update with RETURNING
    returning: () => Promise.resolve(_updateReturningRows),
    // Shape 2: select with .limit(1) after .where()
    limit: (_n: number) => Promise.resolve(_selectRows),
  };

  const chain: Record<string, unknown> = {
    // insert chain
    insert: () => insertChain,
    // select chain — sets mode to "select"
    select: (_fields?: unknown) => {
      _chainMode = "select";
      return chain;
    },
    from: () => chain,
    // update chain — sets mode to "update"
    update: () => {
      _chainMode = "update";
      return chain;
    },
    set: () => chain,
    // shared where (used by select and update)
    where: () => whereResult,
  };

  return chain;
}

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => makeFakeDb()),
}));

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------

function makeStoreRow(overrides: Partial<StoreRow> = {}): StoreRow {
  return {
    id: STORE_ID,
    tenantId: TENANT_ID,
    code: "MAIN",
    name: "Main Store",
    isActive: true,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as StoreRow;
}

// ---------------------------------------------------------------------------
// Builder: construct StoresRepository and fake PoolClient
// ---------------------------------------------------------------------------

function buildRepo() {
  const repo = new StoresRepository();
  const fakeClient = {} as PoolClient;
  return { repo, fakeClient };
}

// ---------------------------------------------------------------------------
// Reset shared DB state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _selectRows = [];
  _insertRows = [];
  _updateRowCount = 1;
  _updateReturningRows = [];

  const { drizzle } = jest.requireMock("drizzle-orm/node-postgres") as {
    drizzle: jest.Mock;
  };
  drizzle.mockImplementation(() => makeFakeDb());
});

// ===========================================================================
// A. listInTenant
// ===========================================================================

describe("StoresRepository.listInTenant", () => {
  it("A1: returns empty array when no rows found", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.listInTenant(fakeClient);

    expect(result).toEqual([]);
  });

  it("A2: returns mapped StoreRecord array for multiple rows", async () => {
    const row1 = makeStoreRow({ id: STORE_ID, code: "MAIN", name: "Main" });
    const row2 = makeStoreRow({ id: STORE_ID_2, code: "BRANCH", name: "Branch" });
    _selectRows = [row1, row2];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.listInTenant(fakeClient);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(STORE_ID);
    expect(result[0]!.tenantId).toBe(TENANT_ID);
    expect(result[0]!.code).toBe("MAIN");
    expect(result[0]!.name).toBe("Main");
    expect(result[0]!.isActive).toBe(true);
    expect(result[0]!.deletedAt).toBeNull();
    expect(result[1]!.id).toBe(STORE_ID_2);
    expect(result[1]!.code).toBe("BRANCH");
  });

  it("A3: single row — maps all StoreRecord fields correctly", async () => {
    const deletedAt = new Date("2024-06-01T00:00:00Z");
    const row = makeStoreRow({ isActive: false, deletedAt });
    _selectRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.listInTenant(fakeClient);

    expect(result).toHaveLength(1);
    expect(result[0]!.isActive).toBe(false);
    expect(result[0]!.deletedAt).toEqual(deletedAt);
    expect(result[0]!.createdAt).toEqual(row.createdAt);
    expect(result[0]!.updatedAt).toEqual(row.updatedAt);
  });
});

// ===========================================================================
// B. findById
// ===========================================================================

describe("StoresRepository.findById", () => {
  it("B4: returns mapped StoreRecord when row found", async () => {
    const row = makeStoreRow();
    _selectRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findById(fakeClient, STORE_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(STORE_ID);
    expect(result!.tenantId).toBe(TENANT_ID);
    expect(result!.code).toBe("MAIN");
    expect(result!.name).toBe("Main Store");
  });

  it("B5: returns null when DB returns empty array", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findById(fakeClient, STORE_ID);

    expect(result).toBeNull();
  });
});

// ===========================================================================
// C. create
// ===========================================================================

describe("StoresRepository.create", () => {
  it("C6: returns mapped StoreRecord on successful insert", async () => {
    const row = makeStoreRow();
    _insertRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.create(fakeClient, {
      id: STORE_ID,
      tenantId: TENANT_ID,
      code: "MAIN",
      name: "Main Store",
    });

    expect(result.id).toBe(STORE_ID);
    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.code).toBe("MAIN");
    expect(result.name).toBe("Main Store");
    expect(result.isActive).toBe(true);
  });

  it("C7: throws with correct message when insert returns empty array", async () => {
    _insertRows = [];
    const { repo, fakeClient } = buildRepo();

    await expect(
      repo.create(fakeClient, {
        id: STORE_ID,
        tenantId: TENANT_ID,
        code: "MAIN",
        name: "Main Store",
      }),
    ).rejects.toThrow("StoresRepository.create: insert returned no row");
  });

  it("C8: result has correct shape — all StoreRecord fields present", async () => {
    const createdAt = new Date("2024-03-15T10:00:00Z");
    const updatedAt = new Date("2024-03-15T10:00:00Z");
    const row = makeStoreRow({ createdAt, updatedAt });
    _insertRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.create(fakeClient, {
      id: STORE_ID,
      tenantId: TENANT_ID,
      code: "MAIN",
      name: "Main Store",
    });

    expect(result.createdAt).toEqual(createdAt);
    expect(result.updatedAt).toEqual(updatedAt);
    expect(result.deletedAt).toBeNull();
  });
});

// ===========================================================================
// D. update
// ===========================================================================

describe("StoresRepository.update", () => {
  it("D9: returns mapped StoreRecord when update returns a row", async () => {
    const updated = makeStoreRow({ name: "Updated Name" });
    _updateReturningRows = [updated];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, STORE_ID, { name: "Updated Name" });

    expect(result).not.toBeNull();
    expect(result!.id).toBe(STORE_ID);
    expect(result!.name).toBe("Updated Name");
  });

  it("D10: returns null when update returns empty array (row missing or deleted)", async () => {
    _updateReturningRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, STORE_ID, { name: "X" });

    expect(result).toBeNull();
  });

  it("D11: name patch — result reflects the new name", async () => {
    const updated = makeStoreRow({ name: "New Name" });
    _updateReturningRows = [updated];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, STORE_ID, { name: "New Name" });

    expect(result!.name).toBe("New Name");
  });

  it("D12: isActive patch — result reflects the updated flag", async () => {
    const updated = makeStoreRow({ isActive: false });
    _updateReturningRows = [updated];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, STORE_ID, { isActive: false });

    expect(result!.isActive).toBe(false);
  });
});

// ===========================================================================
// E. softDelete
// ===========================================================================

describe("StoresRepository.softDelete", () => {
  it("E13: rowCount = 1 — returns true (row was mutated)", async () => {
    _updateRowCount = 1;
    const { repo, fakeClient } = buildRepo();

    const result = await repo.softDelete(fakeClient, STORE_ID);

    expect(result).toBe(true);
  });

  it("E14: rowCount = 0 — returns false (already deleted or not found)", async () => {
    _updateRowCount = 0;
    const { repo, fakeClient } = buildRepo();

    const result = await repo.softDelete(fakeClient, STORE_ID);

    expect(result).toBe(false);
  });

  it("E15: rowCount = null — returns false (covers the ?? 0 branch)", async () => {
    _updateRowCount = null;
    const { repo, fakeClient } = buildRepo();

    const result = await repo.softDelete(fakeClient, STORE_ID);

    expect(result).toBe(false);
  });
});

// ===========================================================================
// F. existsInTenant
// ===========================================================================

describe("StoresRepository.existsInTenant", () => {
  it("F16: returns true when DB returns at least one row", async () => {
    _selectRows = [makeStoreRow()];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.existsInTenant(fakeClient, STORE_ID);

    expect(result).toBe(true);
  });

  it("F17: returns false when DB returns empty array", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.existsInTenant(fakeClient, STORE_ID);

    expect(result).toBe(false);
  });
});
