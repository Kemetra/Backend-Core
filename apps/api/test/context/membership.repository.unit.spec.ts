/**
 * membership.repository.unit.spec.ts
 *
 * Docker-free unit coverage for MembershipRepository (T304-B-api coverage lift).
 *
 * Strategy: hand-written fake for the Drizzle DB chain — same pattern as
 * memberships.repository.unit.spec.ts. A closure-local _chainMode drives
 * whether `whereResult.then` resolves as a select-row-array or a rowCount
 * object. Sequential SELECTs within one method invocation pop results from
 * `_selectRowsQueue` in order; a fallback `_selectRows` handles single-select
 * methods.
 *
 * Chain shapes used by MembershipRepository:
 *
 *   1. select().from().where().limit(1)                  -> Promise<Row[]>
 *      (isPlatformAdmin, findActiveMembership, findTenantSummary,
 *       findStoreSummary, findUserSummary, canAccessStore step-1 + step-2)
 *   2. select().from().innerJoin().where().limit(1)       -> Promise<Row[]>
 *      (findRoleCodeForUserInTenant)
 *   3. select().from().innerJoin().innerJoin().where()    -> Promise<Row[]> (direct-await)
 *      (listForUser base query, listForTenant base query)
 *   4. select().from().innerJoin().where()               -> Promise<Row[]> (direct-await)
 *      (listForUser N+1 grant query, listForTenant N+1 grant query)
 *
 * The fake DB resolves whatever rows are seeded — it does NOT assert on SQL
 * structure (column names, table references, WHERE clause shapes).
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit mocks.
 * The fake DB resolves whatever rows are seeded regardless of tenant context —
 * RLS is a DB-layer guarantee tested only with a real Postgres instance
 * (Testcontainers integration spec).
 */

import "reflect-metadata";

// ---------------------------------------------------------------------------
// Module-level state — reset in beforeEach
// ---------------------------------------------------------------------------

let _selectRowsQueue: unknown[][] = [];
let _selectRows: unknown[] = [];

// ---------------------------------------------------------------------------
// Fake Drizzle DB factory
// ---------------------------------------------------------------------------

function makeFakeDb() {
  let _chainMode: "select" = "select";

  /**
   * whereResult is:
   *   - Thenable → resolves to next rows from queue (or _selectRows fallback)
   *   - Has .limit(n) → same pop logic (for shapes 1 and 2)
   */
  const whereResult = {
    then: (
      resolve: (v: unknown[]) => void,
      _reject?: (e: unknown) => void,
    ) => {
      void _chainMode; // consumed only for select in this repo
      const rows =
        _selectRowsQueue.length > 0 ? _selectRowsQueue.shift()! : _selectRows;
      return Promise.resolve(rows).then(resolve, _reject);
    },
    limit: (_n: number) => {
      const rows =
        _selectRowsQueue.length > 0 ? _selectRowsQueue.shift()! : _selectRows;
      return Promise.resolve(rows);
    },
  };

  const chain: Record<string, unknown> = {
    select: (_fields?: unknown) => {
      _chainMode = "select";
      return chain;
    },
    from: () => chain,
    // innerJoin returns chain so chains of any depth work:
    // .innerJoin().innerJoin().where() or .innerJoin().where() both reach whereResult
    innerJoin: () => chain,
    where: () => whereResult,
  };

  return chain;
}

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => makeFakeDb()),
}));

import { MembershipRepository } from "../../src/context/membership.repository";
import type { StoreAccessKind } from "@data-pulse-2/db/schema";
import type { Pool, PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const USER_ID = "0193c000-0000-7000-8000-000000000001";
const TENANT_ID = "0193c000-0000-7000-8000-0000000000a1";
const TENANT_ID_2 = "0193c000-0000-7000-8000-0000000000a2";
const MEMBERSHIP_ID = "0193c000-0000-7000-8000-000000000002";
const MEMBERSHIP_ID_2 = "0193c000-0000-7000-8000-000000000003";
const STORE_ID_1 = "0193c000-0000-7000-8000-000000000010";
const STORE_ID_2 = "0193c000-0000-7000-8000-000000000011";

// ---------------------------------------------------------------------------
// Builder: construct MembershipRepository and fake connection objects
// ---------------------------------------------------------------------------

function buildRepo() {
  const fakePool = {} as Pool;
  const fakeClient = {} as PoolClient;
  const repo = new MembershipRepository(fakePool);
  return { repo, fakePool, fakeClient };
}

// ---------------------------------------------------------------------------
// Reset shared DB state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _selectRows = [];
  _selectRowsQueue = [];

  const { drizzle } = jest.requireMock("drizzle-orm/node-postgres") as {
    drizzle: jest.Mock;
  };
  drizzle.mockImplementation(() => makeFakeDb());
});

// ===========================================================================
// A. isPlatformAdmin
// ===========================================================================

describe("MembershipRepository.isPlatformAdmin", () => {
  it("A1: returns true when user row has isPlatformAdmin=true", async () => {
    _selectRows = [{ isPlatformAdmin: true }];
    const { repo } = buildRepo();

    const result = await repo.isPlatformAdmin(USER_ID);

    expect(result).toBe(true);
  });

  it("A2: returns false when user row has isPlatformAdmin=false", async () => {
    _selectRows = [{ isPlatformAdmin: false }];
    const { repo } = buildRepo();

    const result = await repo.isPlatformAdmin(USER_ID);

    expect(result).toBe(false);
  });

  it("A3: returns false when no row found (user missing or soft-deleted)", async () => {
    _selectRows = [];
    const { repo } = buildRepo();

    const result = await repo.isPlatformAdmin(USER_ID);

    expect(result).toBe(false);
  });
});

// ===========================================================================
// B. findActiveMembership
// ===========================================================================

describe("MembershipRepository.findActiveMembership", () => {
  it("B1: returns ActiveMembership when row found — storeAccessKind='all' (pool path)", async () => {
    _selectRows = [
      { membershipId: MEMBERSHIP_ID, storeAccessKind: "all" as StoreAccessKind },
    ];
    const { repo } = buildRepo();

    const result = await repo.findActiveMembership(USER_ID, TENANT_ID);

    expect(result).not.toBeNull();
    expect(result!.membershipId).toBe(MEMBERSHIP_ID);
    expect(result!.storeAccessKind).toBe("all");
  });

  it("B2: returns ActiveMembership with storeAccessKind='specific' (pool path)", async () => {
    _selectRows = [
      { membershipId: MEMBERSHIP_ID, storeAccessKind: "specific" as StoreAccessKind },
    ];
    const { repo } = buildRepo();

    const result = await repo.findActiveMembership(USER_ID, TENANT_ID);

    expect(result!.storeAccessKind).toBe("specific");
  });

  it("B3: returns null when no active membership found (pool path)", async () => {
    _selectRows = [];
    const { repo } = buildRepo();

    const result = await repo.findActiveMembership(USER_ID, TENANT_ID);

    expect(result).toBeNull();
  });

  it("B4: returns ActiveMembership when client is provided (client path — drizzle(client) branch)", async () => {
    _selectRows = [
      { membershipId: MEMBERSHIP_ID, storeAccessKind: "all" as StoreAccessKind },
    ];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findActiveMembership(USER_ID, TENANT_ID, fakeClient);

    expect(result).not.toBeNull();
    expect(result!.membershipId).toBe(MEMBERSHIP_ID);
  });

  it("B5: returns null via client path when no row", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findActiveMembership(USER_ID, TENANT_ID, fakeClient);

    expect(result).toBeNull();
  });
});

// ===========================================================================
// C. canAccessStore
// ===========================================================================

describe("MembershipRepository.canAccessStore", () => {
  it("C1: returns false when store row not found (step-1 miss, pool path)", async () => {
    // step-1 SELECT returns nothing
    _selectRowsQueue = [[]];
    const { repo } = buildRepo();

    const result = await repo.canAccessStore(MEMBERSHIP_ID, TENANT_ID, STORE_ID_1, "all");

    expect(result).toBe(false);
  });

  it("C2: returns true when store found and kind='all' (no step-2 SELECT)", async () => {
    // step-1 SELECT finds the store; kind='all' short-circuits
    _selectRowsQueue = [[{ id: STORE_ID_1 }]];
    const { repo } = buildRepo();

    const result = await repo.canAccessStore(MEMBERSHIP_ID, TENANT_ID, STORE_ID_1, "all");

    expect(result).toBe(true);
  });

  it("C3: returns false when store found, kind='specific', but no grant row (step-2 miss)", async () => {
    // step-1 finds store; step-2 finds no grant
    _selectRowsQueue = [[{ id: STORE_ID_1 }], []];
    const { repo } = buildRepo();

    const result = await repo.canAccessStore(MEMBERSHIP_ID, TENANT_ID, STORE_ID_1, "specific");

    expect(result).toBe(false);
  });

  it("C4: returns true when store found, kind='specific', and grant row exists (step-2 hit)", async () => {
    // step-1 finds store; step-2 finds a grant
    _selectRowsQueue = [[{ id: STORE_ID_1 }], [{ membershipId: MEMBERSHIP_ID }]];
    const { repo } = buildRepo();

    const result = await repo.canAccessStore(MEMBERSHIP_ID, TENANT_ID, STORE_ID_1, "specific");

    expect(result).toBe(true);
  });

  it("C5: client path — returns true when store found and kind='all'", async () => {
    _selectRowsQueue = [[{ id: STORE_ID_1 }]];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.canAccessStore(
      MEMBERSHIP_ID,
      TENANT_ID,
      STORE_ID_1,
      "all",
      fakeClient,
    );

    expect(result).toBe(true);
  });
});

// ===========================================================================
// D. listForUser
// ===========================================================================

describe("MembershipRepository.listForUser", () => {
  it("D1: returns empty array when no active memberships found (pool path)", async () => {
    // base query returns empty → no N+1 loop iterations
    _selectRowsQueue = [[]];
    const { repo } = buildRepo();

    const result = await repo.listForUser(USER_ID);

    expect(result).toEqual([]);
  });

  it("D2: returns MembershipSummary[] for kind='all' memberships (no N+1 grant fetch)", async () => {
    _selectRowsQueue = [
      // base rows — two 'all' memberships
      [
        {
          membershipId: MEMBERSHIP_ID,
          tenantId: TENANT_ID,
          tenantName: "Acme Corp",
          roleCode: "tenant_admin",
          storeAccessKind: "all",
        },
        {
          membershipId: MEMBERSHIP_ID_2,
          tenantId: TENANT_ID_2,
          tenantName: "Beta Inc",
          roleCode: "owner",
          storeAccessKind: "all",
        },
      ],
      // No grant selects because both are 'all'
    ];
    const { repo } = buildRepo();

    const result = await repo.listForUser(USER_ID);

    expect(result).toHaveLength(2);
    expect(result[0]!.tenantId).toBe(TENANT_ID);
    expect(result[0]!.tenantName).toBe("Acme Corp");
    expect(result[0]!.roleCode).toBe("tenant_admin");
    expect(result[0]!.storeAccessKind).toBe("all");
    expect(result[0]!.accessibleStoreIds).toEqual([]);
    expect(result[1]!.tenantId).toBe(TENANT_ID_2);
    expect(result[1]!.storeAccessKind).toBe("all");
    expect(result[1]!.accessibleStoreIds).toEqual([]);
  });

  it("D3: returns MembershipSummary with populated accessibleStoreIds for kind='specific'", async () => {
    _selectRowsQueue = [
      // base rows — one 'specific' membership
      [
        {
          membershipId: MEMBERSHIP_ID,
          tenantId: TENANT_ID,
          tenantName: "Acme Corp",
          roleCode: "store_manager",
          storeAccessKind: "specific",
        },
      ],
      // N+1 grant select for the 'specific' row
      [{ storeId: STORE_ID_1 }, { storeId: STORE_ID_2 }],
    ];
    const { repo } = buildRepo();

    const result = await repo.listForUser(USER_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.storeAccessKind).toBe("specific");
    expect(result[0]!.accessibleStoreIds).toEqual([STORE_ID_1, STORE_ID_2]);
  });

  it("D4: mixed kinds — grant select fires only for 'specific' rows (N+1 scoped correctly)", async () => {
    _selectRowsQueue = [
      // base rows — first 'all', second 'specific'
      [
        {
          membershipId: MEMBERSHIP_ID,
          tenantId: TENANT_ID,
          tenantName: "Acme Corp",
          roleCode: "tenant_admin",
          storeAccessKind: "all",
        },
        {
          membershipId: MEMBERSHIP_ID_2,
          tenantId: TENANT_ID_2,
          tenantName: "Beta Inc",
          roleCode: "store_manager",
          storeAccessKind: "specific",
        },
      ],
      // N+1 grant select fires only for MEMBERSHIP_ID_2 (the 'specific' one)
      [{ storeId: STORE_ID_1 }],
    ];
    const { repo } = buildRepo();

    const result = await repo.listForUser(USER_ID);

    expect(result).toHaveLength(2);
    // 'all' row — no grant query, empty accessibleStoreIds
    expect(result[0]!.storeAccessKind).toBe("all");
    expect(result[0]!.accessibleStoreIds).toEqual([]);
    // 'specific' row — grant query ran, one store
    expect(result[1]!.storeAccessKind).toBe("specific");
    expect(result[1]!.accessibleStoreIds).toEqual([STORE_ID_1]);
  });

  it("D5: client path — returns correct summaries when client passed", async () => {
    _selectRowsQueue = [
      [
        {
          membershipId: MEMBERSHIP_ID,
          tenantId: TENANT_ID,
          tenantName: "Acme Corp",
          roleCode: "owner",
          storeAccessKind: "all",
        },
      ],
    ];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.listForUser(USER_ID, fakeClient);

    expect(result).toHaveLength(1);
    expect(result[0]!.roleCode).toBe("owner");
  });
});

// ===========================================================================
// E. findTenantSummary
// ===========================================================================

describe("MembershipRepository.findTenantSummary", () => {
  it("E1: returns TenantSummary when tenant found (pool path)", async () => {
    _selectRows = [{ id: TENANT_ID, slug: "acme", name: "Acme Corp" }];
    const { repo } = buildRepo();

    const result = await repo.findTenantSummary(TENANT_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(TENANT_ID);
    expect(result!.slug).toBe("acme");
    expect(result!.name).toBe("Acme Corp");
  });

  it("E2: returns null when tenant not found or soft-deleted (pool path)", async () => {
    _selectRows = [];
    const { repo } = buildRepo();

    const result = await repo.findTenantSummary(TENANT_ID);

    expect(result).toBeNull();
  });

  it("E3: client path — returns TenantSummary when row found", async () => {
    _selectRows = [{ id: TENANT_ID, slug: "beta", name: "Beta Inc" }];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findTenantSummary(TENANT_ID, fakeClient);

    expect(result!.slug).toBe("beta");
  });

  it("E4: client path — returns null when no row found", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findTenantSummary(TENANT_ID, fakeClient);

    expect(result).toBeNull();
  });
});

// ===========================================================================
// F. findStoreSummary
// ===========================================================================

describe("MembershipRepository.findStoreSummary", () => {
  it("F1: returns StoreSummary when store found (pool path)", async () => {
    _selectRows = [{ id: STORE_ID_1, code: "S01", name: "Main Store" }];
    const { repo } = buildRepo();

    const result = await repo.findStoreSummary(STORE_ID_1, TENANT_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(STORE_ID_1);
    expect(result!.code).toBe("S01");
    expect(result!.name).toBe("Main Store");
  });

  it("F2: returns null when store not found or soft-deleted (pool path)", async () => {
    _selectRows = [];
    const { repo } = buildRepo();

    const result = await repo.findStoreSummary(STORE_ID_1, TENANT_ID);

    expect(result).toBeNull();
  });

  it("F3: client path — returns StoreSummary when row found", async () => {
    _selectRows = [{ id: STORE_ID_2, code: "S02", name: "Branch" }];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findStoreSummary(STORE_ID_2, TENANT_ID, fakeClient);

    expect(result!.code).toBe("S02");
  });

  it("F4: client path — returns null when no row", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findStoreSummary(STORE_ID_1, TENANT_ID, fakeClient);

    expect(result).toBeNull();
  });
});

// ===========================================================================
// G. listForTenant
// ===========================================================================

describe("MembershipRepository.listForTenant", () => {
  it("G1: returns empty array when no memberships in tenant", async () => {
    _selectRowsQueue = [[]];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.listForTenant(fakeClient, TENANT_ID);

    expect(result).toEqual([]);
  });

  it("G2: returns MembershipDetail[] for kind='all' membership (no N+1 grant fetch)", async () => {
    _selectRowsQueue = [
      [
        {
          membershipId: MEMBERSHIP_ID,
          userId: USER_ID,
          userEmail: "alice@example.com",
          userDisplayName: "Alice",
          roleCode: "tenant_admin",
          storeAccessKind: "all",
          revokedAt: null,
        },
      ],
    ];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.listForTenant(fakeClient, TENANT_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.membershipId).toBe(MEMBERSHIP_ID);
    expect(result[0]!.user.id).toBe(USER_ID);
    expect(result[0]!.user.email).toBe("alice@example.com");
    expect(result[0]!.user.displayName).toBe("Alice");
    expect(result[0]!.roleCode).toBe("tenant_admin");
    expect(result[0]!.storeAccessKind).toBe("all");
    expect(result[0]!.accessibleStoreIds).toEqual([]);
    expect(result[0]!.revokedAt).toBeNull();
  });

  it("G3: returns MembershipDetail with populated accessibleStoreIds for kind='specific'", async () => {
    _selectRowsQueue = [
      [
        {
          membershipId: MEMBERSHIP_ID,
          userId: USER_ID,
          userEmail: "bob@example.com",
          userDisplayName: "Bob",
          roleCode: "store_manager",
          storeAccessKind: "specific",
          revokedAt: null,
        },
      ],
      // N+1 grant select
      [{ storeId: STORE_ID_1 }, { storeId: STORE_ID_2 }],
    ];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.listForTenant(fakeClient, TENANT_ID);

    expect(result[0]!.storeAccessKind).toBe("specific");
    expect(result[0]!.accessibleStoreIds).toEqual([STORE_ID_1, STORE_ID_2]);
  });

  it("G4: userDisplayName null fallback — displayName maps to null (not undefined)", async () => {
    _selectRowsQueue = [
      [
        {
          membershipId: MEMBERSHIP_ID,
          userId: USER_ID,
          userEmail: "anon@example.com",
          userDisplayName: null,
          roleCode: "store_staff",
          storeAccessKind: "all",
          revokedAt: null,
        },
      ],
    ];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.listForTenant(fakeClient, TENANT_ID);

    expect(result[0]!.user.displayName).toBeNull();
  });

  it("G5: revokedAt non-null — preserved in MembershipDetail", async () => {
    const revokedAt = new Date("2024-12-01T00:00:00Z");
    _selectRowsQueue = [
      [
        {
          membershipId: MEMBERSHIP_ID,
          userId: USER_ID,
          userEmail: "revoked@example.com",
          userDisplayName: "Revoked User",
          roleCode: "store_staff",
          storeAccessKind: "all",
          revokedAt,
        },
      ],
    ];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.listForTenant(fakeClient, TENANT_ID);

    expect(result[0]!.revokedAt).toEqual(revokedAt);
  });

  it("G6: mixed kinds — grant select fires only for 'specific' rows", async () => {
    _selectRowsQueue = [
      [
        {
          membershipId: MEMBERSHIP_ID,
          userId: USER_ID,
          userEmail: "alice@example.com",
          userDisplayName: "Alice",
          roleCode: "tenant_admin",
          storeAccessKind: "all",
          revokedAt: null,
        },
        {
          membershipId: MEMBERSHIP_ID_2,
          userId: USER_ID,
          userEmail: "alice@example.com",
          userDisplayName: "Alice",
          roleCode: "store_manager",
          storeAccessKind: "specific",
          revokedAt: null,
        },
      ],
      // N+1 grant select for MEMBERSHIP_ID_2 only
      [{ storeId: STORE_ID_1 }],
    ];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.listForTenant(fakeClient, TENANT_ID);

    expect(result).toHaveLength(2);
    expect(result[0]!.storeAccessKind).toBe("all");
    expect(result[0]!.accessibleStoreIds).toEqual([]);
    expect(result[1]!.storeAccessKind).toBe("specific");
    expect(result[1]!.accessibleStoreIds).toEqual([STORE_ID_1]);
  });
});

// ===========================================================================
// H. findRoleCodeForUserInTenant
// ===========================================================================

describe("MembershipRepository.findRoleCodeForUserInTenant", () => {
  it("H1: returns role code string when active membership with role found (pool path)", async () => {
    _selectRows = [{ code: "tenant_admin" }];
    const { repo } = buildRepo();

    const result = await repo.findRoleCodeForUserInTenant(USER_ID, TENANT_ID);

    expect(result).toBe("tenant_admin");
  });

  it("H2: returns null when no active membership found (pool path)", async () => {
    _selectRows = [];
    const { repo } = buildRepo();

    const result = await repo.findRoleCodeForUserInTenant(USER_ID, TENANT_ID);

    expect(result).toBeNull();
  });

  it("H3: client path — returns role code when found", async () => {
    _selectRows = [{ code: "owner" }];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findRoleCodeForUserInTenant(USER_ID, TENANT_ID, fakeClient);

    expect(result).toBe("owner");
  });

  it("H4: client path — returns null when no row", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findRoleCodeForUserInTenant(USER_ID, TENANT_ID, fakeClient);

    expect(result).toBeNull();
  });
});

// ===========================================================================
// I. findUserSummary
// ===========================================================================

describe("MembershipRepository.findUserSummary", () => {
  it("I1: returns full user summary when user found", async () => {
    _selectRows = [
      {
        id: USER_ID,
        email: "alice@example.com",
        displayName: "Alice",
        isPlatformAdmin: false,
      },
    ];
    const { repo } = buildRepo();

    const result = await repo.findUserSummary(USER_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(USER_ID);
    expect(result!.email).toBe("alice@example.com");
    expect(result!.displayName).toBe("Alice");
    expect(result!.isPlatformAdmin).toBe(false);
  });

  it("I2: returns user summary with isPlatformAdmin=true for platform admin users", async () => {
    _selectRows = [
      {
        id: USER_ID,
        email: "admin@example.com",
        displayName: "Admin",
        isPlatformAdmin: true,
      },
    ];
    const { repo } = buildRepo();

    const result = await repo.findUserSummary(USER_ID);

    expect(result!.isPlatformAdmin).toBe(true);
  });

  it("I3: returns user summary with displayName=null (optional field)", async () => {
    _selectRows = [
      {
        id: USER_ID,
        email: "noname@example.com",
        displayName: null,
        isPlatformAdmin: false,
      },
    ];
    const { repo } = buildRepo();

    const result = await repo.findUserSummary(USER_ID);

    expect(result!.displayName).toBeNull();
  });

  it("I4: returns null when user not found or soft-deleted", async () => {
    _selectRows = [];
    const { repo } = buildRepo();

    const result = await repo.findUserSummary(USER_ID);

    expect(result).toBeNull();
  });
});
