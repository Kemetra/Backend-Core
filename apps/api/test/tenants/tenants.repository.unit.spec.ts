/**
 * tenants.repository.unit.spec.ts
 *
 * Docker-free unit coverage for TenantsRepository (T304-B-api coverage lift).
 *
 * Strategy: hand-written fake for the Drizzle DB chain — same pattern as
 * invitations.repository.unit.spec.ts and stores.repository.unit.spec.ts.
 * Each public method is exercised with a fresh `makeFakeDb()` closure per
 * test (via `drizzle.mockImplementation` in beforeEach) so there is no
 * shared mutable state between cases.
 *
 * Chain shapes used by TenantsRepository:
 *
 *   1. select(p).from(t).innerJoin(t2,c).where(c)  -> Promise<Row[]>
 *      (listForUser — cross-tenant join, pool path)
 *   2. select().from(t).where(c)                   -> Promise<Row[]>
 *      (listAll with includeDeleted = false, findByIdAdmin, findById)
 *   3. select().from(t)                            -> Promise<Row[]>
 *      (listAll with includeDeleted = true — no where() call)
 *   4. select().from(t).where(c).limit(1)          -> Promise<Row[]>
 *      (findByIdAdmin, findById)
 *   5. insert(t).values(v).returning()             -> Promise<Row[]>
 *      (create)
 *   6. insert(t).values(v)                         -> awaitable void
 *      (seedDefaultRoles — no .returning())
 *   7. update(t).set(p).where(c).returning()       -> Promise<Row[]>
 *      (update)
 *   8. update(t).set(p).where(c)                   -> awaitable { rowCount }
 *      (softDelete)
 *
 * `from()` returns `fromResult`, which is:
 *   - Thenable → resolves to `_selectRows` (shape 3, direct-await path)
 *   - Has `.where()` → returns `whereResult` (shapes 2, 4, 7, 8)
 *   - Has `.innerJoin()` → returns itself (shape 1; keeps fake minimal)
 *
 * `whereResult` is thenable (shapes 2 and 8) and also has:
 *   - `.limit()` → Promise<Row[]>  (shapes 4)
 *   - `.returning()` → Promise<Row[]>  (shape 7)
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit mocks.
 * The fake DB resolves whatever rows are seeded in `_selectRows` /
 * `_insertRows` regardless of tenant context — RLS is a DB-layer guarantee
 * tested only with a real Postgres instance (Testcontainers integration spec).
 */

import { TenantsRepository, DEFAULT_TENANT_ROLES } from "../../src/tenants/tenants.repository";
import type { TenantRow } from "@data-pulse-2/db/schema";
import type { Pool, PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const TENANT_ID = "0193c000-0000-7000-8000-0000000000a1";
const TENANT_ID_2 = "0193c000-0000-7000-8000-0000000000a2";
const USER_ID = "0193c000-0000-7000-8000-000000000003";

// ---------------------------------------------------------------------------
// Module-level state — reset in beforeEach
// ---------------------------------------------------------------------------

let _selectRows: unknown[] = [];
let _insertRows: unknown[] = [];
let _updateRowCount: number | null = 1;
let _updateReturningRows: unknown[] = [];

// ---------------------------------------------------------------------------
// Fake Drizzle DB
// ---------------------------------------------------------------------------

function makeFakeDb() {
  let _chainMode: "select" | "update" = "select";

  // insertChain supports both:
  //   shape 5: insert(t).values(v).returning() -> Promise<Row[]>
  //   shape 6: insert(t).values(v)             -> awaitable void (thenable)
  const insertChain = {
    values: (_v: unknown) => insertChain,
    returning: () => Promise.resolve(_insertRows),
    then: (
      resolve: (v: undefined) => void,
      _reject?: (e: unknown) => void,
    ) => {
      return Promise.resolve(undefined).then(resolve, _reject);
    },
  };

  const whereResult = {
    // Shape 2 (select direct-await) or shape 8 (update direct-await / softDelete).
    then: (
      resolve: (v: unknown[] | { rowCount: number | null }) => void,
      _reject?: (e: unknown) => void,
    ) => {
      if (_chainMode === "update") {
        return Promise.resolve({ rowCount: _updateRowCount }).then(
          resolve as (v: { rowCount: number | null }) => void,
          _reject,
        );
      }
      return Promise.resolve(_selectRows).then(
        resolve as (v: unknown[]) => void,
        _reject,
      );
    },
    // Shape 4: select with .limit(1) after .where()
    limit: (_n: number) => Promise.resolve(_selectRows),
    // Shape 7: update with .returning() after .where()
    returning: () => Promise.resolve(_updateReturningRows),
  };

  // fromResult is thenable (shape 3), has .where() (shapes 2/4/7/8),
  // and has .innerJoin() that returns itself for a minimal join fake (shape 1).
  const fromResult: Record<string, unknown> = {
    // Shape 3: select().from(t) awaited directly — no .where() call
    then: (
      resolve: (v: unknown[]) => void,
      _reject?: (e: unknown) => void,
    ) => {
      return Promise.resolve(_selectRows).then(resolve, _reject);
    },
    where: () => whereResult,
    // innerJoin returns fromResult itself so the chain can be awaited or
    // continued with .where() (shape 1 — the join fake stays thin).
    innerJoin: () => fromResult,
  };

  const chain: Record<string, unknown> = {
    // insert chain (shapes 5 + 6)
    insert: () => insertChain,
    // select chain — sets mode to "select"
    select: (_fields?: unknown) => {
      _chainMode = "select";
      return chain;
    },
    from: () => fromResult,
    // update chain — sets mode to "update"
    update: () => {
      _chainMode = "update";
      return chain;
    },
    set: () => chain,
    // where on the chain itself (not used by this repo directly, but kept
    // for safety; actual where is on fromResult)
    where: () => whereResult,
  };

  return chain;
}

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => makeFakeDb()),
}));

// ---------------------------------------------------------------------------
// Row builder — shaped like TenantRow (all seven projection fields)
// ---------------------------------------------------------------------------

function makeTenantRow(overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id: TENANT_ID,
    slug: "acme",
    name: "Acme Corp",
    status: "active",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as TenantRow;
}

// ---------------------------------------------------------------------------
// Builder: construct TenantsRepository and fake connection objects
// ---------------------------------------------------------------------------

function buildRepo() {
  const repo = new TenantsRepository();
  const fakeClient = {} as PoolClient;
  const fakePool = {} as Pool;
  return { repo, fakeClient, fakePool };
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
// A. DEFAULT_TENANT_ROLES export — stability / order guard
// ===========================================================================

describe("DEFAULT_TENANT_ROLES", () => {
  it("A1: exports exactly 4 roles in stable order", () => {
    expect(DEFAULT_TENANT_ROLES).toHaveLength(4);
    expect(DEFAULT_TENANT_ROLES[0]!.code).toBe("owner");
    expect(DEFAULT_TENANT_ROLES[1]!.code).toBe("tenant_admin");
    expect(DEFAULT_TENANT_ROLES[2]!.code).toBe("store_manager");
    expect(DEFAULT_TENANT_ROLES[3]!.code).toBe("store_staff");
  });

  it("A2: every role has a non-empty name", () => {
    for (const role of DEFAULT_TENANT_ROLES) {
      expect(role.name.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// B. listForUser (pool path, innerJoin shape)
// ===========================================================================

describe("TenantsRepository.listForUser", () => {
  it("B1: returns empty array when no memberships / tenants found", async () => {
    _selectRows = [];
    const { repo, fakePool } = buildRepo();

    const result = await repo.listForUser(fakePool, USER_ID);

    expect(result).toEqual([]);
  });

  it("B2: returns mapped TenantRecord[] for multiple rows", async () => {
    const row1 = {
      id: TENANT_ID,
      slug: "acme",
      name: "Acme Corp",
      status: "active",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
      deletedAt: null,
    };
    const row2 = {
      id: TENANT_ID_2,
      slug: "beta",
      name: "Beta Inc",
      status: "suspended",
      createdAt: new Date("2024-02-01T00:00:00Z"),
      updatedAt: new Date("2024-02-01T00:00:00Z"),
      deletedAt: null,
    };
    _selectRows = [row1, row2];
    const { repo, fakePool } = buildRepo();

    const result = await repo.listForUser(fakePool, USER_ID);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(TENANT_ID);
    expect(result[0]!.slug).toBe("acme");
    expect(result[0]!.status).toBe("active");
    expect(result[1]!.id).toBe(TENANT_ID_2);
    expect(result[1]!.status).toBe("suspended");
  });

  it("B3: maps all TenantRecord fields correctly (single row)", async () => {
    const deletedAt = new Date("2024-06-01T00:00:00Z");
    const row = {
      id: TENANT_ID,
      slug: "test-slug",
      name: "Test Tenant",
      status: "active",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-03-01T00:00:00Z"),
      deletedAt,
    };
    _selectRows = [row];
    const { repo, fakePool } = buildRepo();

    const result = await repo.listForUser(fakePool, USER_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Test Tenant");
    expect(result[0]!.deletedAt).toEqual(deletedAt);
    expect(result[0]!.updatedAt).toEqual(row.updatedAt);
  });
});

// ===========================================================================
// C. listAll (pool path, includeDeleted branch)
// ===========================================================================

describe("TenantsRepository.listAll", () => {
  it("C1: returns empty array when no rows found (default: includeDeleted = false)", async () => {
    _selectRows = [];
    const { repo, fakePool } = buildRepo();

    const result = await repo.listAll(fakePool);

    expect(result).toEqual([]);
  });

  it("C2: returns mapped TenantRecord[] for multiple rows (where path exercised)", async () => {
    const row1 = makeTenantRow({ id: TENANT_ID, slug: "acme", name: "Acme" });
    const row2 = makeTenantRow({ id: TENANT_ID_2, slug: "beta", name: "Beta" });
    _selectRows = [row1, row2];
    const { repo, fakePool } = buildRepo();

    const result = await repo.listAll(fakePool);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(TENANT_ID);
    expect(result[1]!.id).toBe(TENANT_ID_2);
  });

  it("C3: includeDeleted = true — exercises direct from() await (no where path)", async () => {
    const deletedRow = makeTenantRow({
      deletedAt: new Date("2024-05-01T00:00:00Z"),
    });
    _selectRows = [makeTenantRow(), deletedRow];
    const { repo, fakePool } = buildRepo();

    const result = await repo.listAll(fakePool, { includeDeleted: true });

    expect(result).toHaveLength(2);
    expect(result[1]!.deletedAt).not.toBeNull();
  });

  it("C4: includeDeleted = false — returns only non-deleted rows per fake seed", async () => {
    const activeRow = makeTenantRow();
    _selectRows = [activeRow];
    const { repo, fakePool } = buildRepo();

    const result = await repo.listAll(fakePool, { includeDeleted: false });

    expect(result).toHaveLength(1);
    expect(result[0]!.deletedAt).toBeNull();
  });

  it("C5: maps all TenantRecord fields including status", async () => {
    const row = makeTenantRow({ status: "suspended" });
    _selectRows = [row];
    const { repo, fakePool } = buildRepo();

    const result = await repo.listAll(fakePool);

    expect(result[0]!.status).toBe("suspended");
    expect(result[0]!.createdAt).toEqual(row.createdAt);
    expect(result[0]!.updatedAt).toEqual(row.updatedAt);
  });
});

// ===========================================================================
// D. findByIdAdmin (pool path, limit(1))
// ===========================================================================

describe("TenantsRepository.findByIdAdmin", () => {
  it("D1: returns mapped TenantRecord when row found", async () => {
    const row = makeTenantRow();
    _selectRows = [row];
    const { repo, fakePool } = buildRepo();

    const result = await repo.findByIdAdmin(fakePool, TENANT_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(TENANT_ID);
    expect(result!.slug).toBe("acme");
    expect(result!.name).toBe("Acme Corp");
  });

  it("D2: returns null when DB returns empty array", async () => {
    _selectRows = [];
    const { repo, fakePool } = buildRepo();

    const result = await repo.findByIdAdmin(fakePool, TENANT_ID);

    expect(result).toBeNull();
  });

  it("D3: returns soft-deleted row (admin path — deletedAt is preserved)", async () => {
    const deletedAt = new Date("2024-04-01T00:00:00Z");
    const row = makeTenantRow({ deletedAt });
    _selectRows = [row];
    const { repo, fakePool } = buildRepo();

    const result = await repo.findByIdAdmin(fakePool, TENANT_ID);

    expect(result).not.toBeNull();
    expect(result!.deletedAt).toEqual(deletedAt);
  });
});

// ===========================================================================
// E. findById (PoolClient path, RLS-enforced context)
// ===========================================================================

describe("TenantsRepository.findById", () => {
  it("E1: returns mapped TenantRecord when row found", async () => {
    const row = makeTenantRow();
    _selectRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findById(fakeClient, TENANT_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(TENANT_ID);
    expect(result!.name).toBe("Acme Corp");
  });

  it("E2: returns null when DB returns empty array (row not found or cross-tenant)", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findById(fakeClient, TENANT_ID);

    expect(result).toBeNull();
  });

  it("E3: all TenantRecord fields are mapped correctly", async () => {
    const createdAt = new Date("2024-01-15T08:00:00Z");
    const updatedAt = new Date("2024-03-10T12:00:00Z");
    const row = makeTenantRow({ createdAt, updatedAt, status: "suspended" });
    _selectRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findById(fakeClient, TENANT_ID);

    expect(result!.status).toBe("suspended");
    expect(result!.createdAt).toEqual(createdAt);
    expect(result!.updatedAt).toEqual(updatedAt);
    expect(result!.deletedAt).toBeNull();
  });
});

// ===========================================================================
// F. create (PoolClient path, insert returning)
// ===========================================================================

describe("TenantsRepository.create", () => {
  it("F1: returns mapped TenantRecord on successful insert", async () => {
    const row = makeTenantRow();
    _insertRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.create(fakeClient, {
      id: TENANT_ID,
      slug: "acme",
      name: "Acme Corp",
    });

    expect(result.id).toBe(TENANT_ID);
    expect(result.slug).toBe("acme");
    expect(result.name).toBe("Acme Corp");
    expect(result.status).toBe("active");
  });

  it("F2: throws with correct message when insert returns empty array", async () => {
    _insertRows = [];
    const { repo, fakeClient } = buildRepo();

    await expect(
      repo.create(fakeClient, {
        id: TENANT_ID,
        slug: "acme",
        name: "Acme Corp",
      }),
    ).rejects.toThrow("TenantsRepository.create: insert returned no row");
  });

  it("F3: returned record has all TenantRecord fields populated", async () => {
    const createdAt = new Date("2024-06-01T00:00:00Z");
    const updatedAt = new Date("2024-06-01T00:00:00Z");
    const row = makeTenantRow({ createdAt, updatedAt });
    _insertRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.create(fakeClient, {
      id: TENANT_ID,
      slug: "acme",
      name: "Acme Corp",
    });

    expect(result.createdAt).toEqual(createdAt);
    expect(result.updatedAt).toEqual(updatedAt);
    expect(result.deletedAt).toBeNull();
  });
});

// ===========================================================================
// G. seedDefaultRoles (PoolClient path, insert void)
// ===========================================================================

describe("TenantsRepository.seedDefaultRoles", () => {
  it("G1: resolves to undefined (inserts all 4 default roles)", async () => {
    const { repo, fakeClient } = buildRepo();

    await expect(repo.seedDefaultRoles(fakeClient, TENANT_ID)).resolves.toBeUndefined();
  });

  it("G2: resolves without throwing even when called multiple times (idempotent-like at unit level)", async () => {
    const { repo, fakeClient } = buildRepo();

    await expect(repo.seedDefaultRoles(fakeClient, TENANT_ID)).resolves.toBeUndefined();
    await expect(repo.seedDefaultRoles(fakeClient, TENANT_ID)).resolves.toBeUndefined();
  });
});

// ===========================================================================
// H. update (PoolClient path, update returning)
// ===========================================================================

describe("TenantsRepository.update", () => {
  it("H1: returns mapped TenantRecord when update returns a row (name patch)", async () => {
    const updated = makeTenantRow({ name: "New Name" });
    _updateReturningRows = [updated];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, TENANT_ID, { name: "New Name" });

    expect(result).not.toBeNull();
    expect(result!.id).toBe(TENANT_ID);
    expect(result!.name).toBe("New Name");
  });

  it("H2: returns null when update returns empty array (row missing or deleted)", async () => {
    _updateReturningRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, TENANT_ID, { name: "X" });

    expect(result).toBeNull();
  });

  it("H3: status patch — result reflects the updated status", async () => {
    const updated = makeTenantRow({ status: "suspended" });
    _updateReturningRows = [updated];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, TENANT_ID, {
      status: "suspended",
    });

    expect(result!.status).toBe("suspended");
  });

  it("H4: both name and status patched together", async () => {
    const updated = makeTenantRow({ name: "Renamed", status: "active" });
    _updateReturningRows = [updated];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, TENANT_ID, {
      name: "Renamed",
      status: "active",
    });

    expect(result!.name).toBe("Renamed");
    expect(result!.status).toBe("active");
  });

  it("H5: empty patch (no name, no status) — still returns row (only updatedAt is set)", async () => {
    const updated = makeTenantRow();
    _updateReturningRows = [updated];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, TENANT_ID, {});

    expect(result).not.toBeNull();
    expect(result!.id).toBe(TENANT_ID);
  });
});

// ===========================================================================
// I. softDelete (PoolClient path, update rowCount)
// ===========================================================================

describe("TenantsRepository.softDelete", () => {
  it("I1: rowCount = 1 — returns true (row was soft-deleted)", async () => {
    _updateRowCount = 1;
    const { repo, fakeClient } = buildRepo();

    const result = await repo.softDelete(fakeClient, TENANT_ID);

    expect(result).toBe(true);
  });

  it("I2: rowCount = 0 — returns false (already deleted or not found)", async () => {
    _updateRowCount = 0;
    const { repo, fakeClient } = buildRepo();

    const result = await repo.softDelete(fakeClient, TENANT_ID);

    expect(result).toBe(false);
  });

  it("I3: rowCount = null — returns false (covers the ?? 0 branch)", async () => {
    _updateRowCount = null;
    const { repo, fakeClient } = buildRepo();

    const result = await repo.softDelete(fakeClient, TENANT_ID);

    expect(result).toBe(false);
  });
});
