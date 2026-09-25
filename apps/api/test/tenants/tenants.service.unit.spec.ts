/**
 * tenants.service.unit.spec.ts
 *
 * Docker-free unit coverage for TenantsService (api coverage lift).
 *
 * Strategy:
 *   - Construct TenantsService with a fake TxRunner injected via the
 *     `@Optional() tx` constructor parameter. The fake tx calls
 *     `work(fakeClient)` directly, bypassing `runWithTenantContext`.
 *   - Mock TenantsRepository and MembershipRepository with per-test
 *     jest.fn() overrides.
 *   - Mock `@data-pulse-2/shared` (newId) for determinism.
 *
 * EXPLICIT EXCLUSIONS / DEFERRED BRANCHES:
 *   - The `tx ?? runWithTenantContext` constructor fallback (when no tx
 *     is injected) is not exercised here; it requires a real pool. The
 *     Testcontainers integration spec covers that path.
 *   - RLS enforcement is a DB-layer guarantee — the fake tx bypasses
 *     `runWithTenantContext`, so the GUC ctx values are asserted only
 *     for their wiring (passed to tx), not enforced at the SQL level.
 */

import "reflect-metadata";
import {
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE any imports that exercise them
// ---------------------------------------------------------------------------

jest.mock("@data-pulse-2/shared", () => ({
  newId: jest.fn(),
  assertMetricLabels: jest.fn(),
  getMeter: jest.fn(() => ({
    createCounter: jest.fn(() => ({ add: jest.fn() })),
    createHistogram: jest.fn(() => ({ record: jest.fn() })),
    createObservableGauge: jest.fn(() => ({ addCallback: jest.fn(), removeCallback: jest.fn() })),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { TenantsService } from "../../src/tenants/tenants.service";
import type {
  TenantRecord,
  TenantsRepository,
} from "../../src/tenants/tenants.repository";
import type {
  MembershipDetail,
  MembershipRepository,
} from "../../src/context/membership.repository";
import type { Principal } from "../../src/auth/auth.guard";
import type { TenantContext } from "@data-pulse-2/db";

import { newId } from "@data-pulse-2/shared";

const mockNewId = newId as jest.MockedFunction<typeof newId>;

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const TENANT_ID = "0193c000-0000-7000-8000-0000000000a1";
const OTHER_TENANT_ID = "0193c000-0000-7000-8000-0000000000a2";
const USER_ID = "0193c000-0000-7000-8000-0000000000b1";
const SESSION_ID = "0193c000-0000-7000-8000-0000000000c1";
const TOKEN_ID_TENANT = "0193c000-0000-7000-8000-0000000000d1";
const TOKEN_ID_PLATFORM = "0193c000-0000-7000-8000-0000000000d2";
const TOKEN_ID_NULL_USER = "0193c000-0000-7000-8000-0000000000d3";
const MEMBERSHIP_ID_1 = "0193c000-0000-7000-8000-0000000000e1";

// ---------------------------------------------------------------------------
// Principal fixtures
// ---------------------------------------------------------------------------

const sessionPrincipal: Principal = {
  kind: "session",
  sessionId: SESSION_ID,
  userId: USER_ID,
};

const tokenPrincipalTenant: Principal = {
  kind: "token",
  tokenId: TOKEN_ID_TENANT,
  tenantId: TENANT_ID,
  userId: USER_ID,
  storeId: null,
  scope: "dashboard_api",
};

const tokenPlatformAdmin: Principal = {
  kind: "token",
  tokenId: TOKEN_ID_PLATFORM,
  tenantId: null,
  userId: null,
  storeId: null,
  scope: "dashboard_api",
};

const tokenPrincipalNullUserId: Principal = {
  kind: "token",
  tokenId: TOKEN_ID_NULL_USER,
  tenantId: TENANT_ID,
  userId: null,
  storeId: null,
  scope: "dashboard_api",
};

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function makeTenantRecord(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: TENANT_ID,
    slug: "acme",
    name: "Acme Inc.",
    status: "active",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

function makeMembershipDetail(
  overrides: Partial<MembershipDetail> = {},
): MembershipDetail {
  return {
    membershipId: MEMBERSHIP_ID_1,
    user: {
      id: USER_ID,
      email: "alice@example.com",
      displayName: "Alice",
    },
    roleCode: "tenant_admin",
    storeAccessKind: "all",
    accessibleStoreIds: [],
    revokedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake repositories
// ---------------------------------------------------------------------------

function makeFakeTenantsRepo(): jest.Mocked<TenantsRepository> {
  return {
    listForUser: jest.fn(),
    listAll: jest.fn(),
    findByIdAdmin: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    seedDefaultRoles: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<TenantsRepository>;
}

function makeFakeMembershipsRepo(): jest.Mocked<MembershipRepository> {
  return {
    isPlatformAdmin: jest.fn(),
    findActiveMembership: jest.fn(),
    canAccessStore: jest.fn(),
    listForUser: jest.fn(),
    findTenantSummary: jest.fn(),
    findStoreSummary: jest.fn(),
    listForTenant: jest.fn(),
    findRoleCodeForUserInTenant: jest.fn(),
    findUserSummary: jest.fn(),
  } as unknown as jest.Mocked<MembershipRepository>;
}

// ---------------------------------------------------------------------------
// TxRunner fake — synchronously calls work(fakeClient)
// ---------------------------------------------------------------------------

const fakeClient = {} as PoolClient;
const fakePool = {} as Pool;

function makeFakeTx() {
  return jest.fn(
    async <T>(
      _pool: Pool,
      _ctx: TenantContext,
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => work(fakeClient),
  );
}

// ---------------------------------------------------------------------------
// Helper: build service with defaults
// ---------------------------------------------------------------------------

interface BuildServiceOpts {
  tenantsRepo?: jest.Mocked<TenantsRepository>;
  membershipsRepo?: jest.Mocked<MembershipRepository>;
  tx?: ReturnType<typeof makeFakeTx>;
}

function buildService(opts: BuildServiceOpts = {}) {
  const tenantsRepo = opts.tenantsRepo ?? makeFakeTenantsRepo();
  const membershipsRepo = opts.membershipsRepo ?? makeFakeMembershipsRepo();
  const tx = opts.tx ?? makeFakeTx();

  const service = new TenantsService(
    fakePool,
    tenantsRepo as unknown as TenantsRepository,
    membershipsRepo as unknown as MembershipRepository,
    tx,
  );

  return { service, tenantsRepo, membershipsRepo, tx };
}

// ---------------------------------------------------------------------------
// Reset shared state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockNewId.mockReturnValue(TENANT_ID);
});

// ===========================================================================
// LI. list() — actor-driven data-path selection
// ===========================================================================

describe("TenantsService.list", () => {
  it("LI1: platform-scoped token (tenantId=null) → listAll(pool); memberships.isPlatformAdmin NOT called", async () => {
    const { service, tenantsRepo, membershipsRepo, tx } = buildService();
    const rows = [makeTenantRecord({ id: TENANT_ID }), makeTenantRecord({ id: OTHER_TENANT_ID })];
    tenantsRepo.listAll.mockResolvedValue(rows);

    const result = await service.list(tokenPlatformAdmin);

    expect(result).toBe(rows);
    expect(tenantsRepo.listAll).toHaveBeenCalledWith(fakeClient);
    expect(tenantsRepo.listForUser).not.toHaveBeenCalled();
    expect(membershipsRepo.isPlatformAdmin).not.toHaveBeenCalled();
    expect(tx).toHaveBeenCalledWith(fakePool, { tenantId: null, isPlatformAdmin: true }, expect.any(Function));
  });

  it("LI2: session principal + memberships.isPlatformAdmin=true → listAll(pool)", async () => {
    const { service, tenantsRepo, membershipsRepo, tx } = buildService();
    membershipsRepo.isPlatformAdmin.mockResolvedValue(true);
    const rows = [makeTenantRecord({ id: TENANT_ID })];
    tenantsRepo.listAll.mockResolvedValue(rows);

    const result = await service.list(sessionPrincipal);

    expect(result).toBe(rows);
    expect(membershipsRepo.isPlatformAdmin).toHaveBeenCalledWith(USER_ID);
    expect(tenantsRepo.listAll).toHaveBeenCalledWith(fakeClient);
    expect(tenantsRepo.listForUser).not.toHaveBeenCalled();
    expect(tx).toHaveBeenCalledWith(fakePool, { tenantId: null, isPlatformAdmin: true }, expect.any(Function));
  });

  it("LI3: session principal + memberships.isPlatformAdmin=false → listForUser(pool, userId)", async () => {
    const { service, tenantsRepo, membershipsRepo, tx } = buildService();
    membershipsRepo.isPlatformAdmin.mockResolvedValue(false);
    const rows = [makeTenantRecord({ id: TENANT_ID })];
    tenantsRepo.listForUser.mockResolvedValue(rows);

    const result = await service.list(sessionPrincipal);

    expect(result).toBe(rows);
    expect(tenantsRepo.listForUser).toHaveBeenCalledWith(fakeClient, USER_ID);
    expect(tenantsRepo.listAll).not.toHaveBeenCalled();
    expect(tx).toHaveBeenCalledWith(fakePool, { tenantId: null, isPlatformAdmin: true }, expect.any(Function));
  });

  it("LI4: token principal with tenantId set + isPlatformAdmin=false + userId set → listForUser", async () => {
    const { service, tenantsRepo, membershipsRepo } = buildService();
    membershipsRepo.isPlatformAdmin.mockResolvedValue(false);
    const rows = [makeTenantRecord({ id: TENANT_ID })];
    tenantsRepo.listForUser.mockResolvedValue(rows);

    const result = await service.list(tokenPrincipalTenant);

    expect(result).toBe(rows);
    expect(membershipsRepo.isPlatformAdmin).toHaveBeenCalledWith(USER_ID);
    expect(tenantsRepo.listForUser).toHaveBeenCalledWith(fakeClient, USER_ID);
    expect(tenantsRepo.listAll).not.toHaveBeenCalled();
  });

  it("LI5: token with userId=null + tenantId set → returns [] (no repo call)", async () => {
    const { service, tenantsRepo, membershipsRepo } = buildService();

    const result = await service.list(tokenPrincipalNullUserId);

    expect(result).toEqual([]);
    expect(tenantsRepo.listAll).not.toHaveBeenCalled();
    expect(tenantsRepo.listForUser).not.toHaveBeenCalled();
    // isPlatformAdmin short-circuits on !userId; memberships.isPlatformAdmin never called
    expect(membershipsRepo.isPlatformAdmin).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// CR. create() — happy + slug-conflict + non-conflict + null branches
// ===========================================================================

describe("TenantsService.create", () => {
  it("CR1: happy path → tenants.create + seedDefaultRoles called in tx; returns row", async () => {
    const { service, tenantsRepo, tx } = buildService();
    const row = makeTenantRecord({ slug: "newslug", name: "New Inc." });
    tenantsRepo.create.mockResolvedValue(row);
    tenantsRepo.seedDefaultRoles.mockResolvedValue(undefined);

    const result = await service.create(sessionPrincipal, {
      slug: "newslug",
      name: "New Inc.",
    });

    expect(result).toBe(row);
    expect(tx).toHaveBeenCalledTimes(1);
    // ctx is the second arg of tx
    const txCall = tx.mock.calls[0]!;
    expect(txCall[0]).toBe(fakePool);
    expect(txCall[1]).toEqual({ tenantId: TENANT_ID, isPlatformAdmin: true });
    expect(tenantsRepo.create).toHaveBeenCalledWith(fakeClient, {
      id: TENANT_ID,
      slug: "newslug",
      name: "New Inc.",
    });
    expect(tenantsRepo.seedDefaultRoles).toHaveBeenCalledWith(fakeClient, TENANT_ID);
    const createOrder = tenantsRepo.create.mock.invocationCallOrder[0]!;
    const seedOrder = tenantsRepo.seedDefaultRoles.mock.invocationCallOrder[0]!;
    expect(seedOrder).toBeGreaterThan(createOrder);
  });

  it("CR2: tenants.create throws {code:'23505',constraint:'tenants_slug_active_uidx'} → ConflictException", async () => {
    const { service, tenantsRepo } = buildService();
    tenantsRepo.create.mockRejectedValue({
      code: "23505",
      constraint: "tenants_slug_active_uidx",
      message: "duplicate key",
    });

    await expect(
      service.create(sessionPrincipal, { slug: "dup", name: "Dup" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("CR3: drizzle-wrapped {cause:{code:'23505',constraint:'tenants_slug_active_uidx'}} → ConflictException", async () => {
    const { service, tenantsRepo } = buildService();
    tenantsRepo.create.mockRejectedValue({
      message: "DrizzleQueryError",
      cause: {
        code: "23505",
        constraint: "tenants_slug_active_uidx",
      },
    });

    await expect(
      service.create(sessionPrincipal, { slug: "dup", name: "Dup" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("CR4: non-conflict error → rethrown as-is", async () => {
    const { service, tenantsRepo } = buildService();
    const originalError = new Error("random DB error");
    tenantsRepo.create.mockRejectedValue(originalError);

    await expect(
      service.create(sessionPrincipal, { slug: "x", name: "X" }),
    ).rejects.toBe(originalError);
  });

  it("CR5: tenants.create throws null → rethrown null (covers null branch in isUniqueViolation)", async () => {
    const { service, tenantsRepo } = buildService();
    tenantsRepo.create.mockRejectedValue(null);

    const err = await service
      .create(sessionPrincipal, { slug: "x", name: "X" })
      .catch((e: unknown) => e);

    expect(err).toBeNull();
  });

  it("CR6: {code:'23505', message:'...tenants_slug_active_uidx...'} without constraint field → ConflictException", async () => {
    const { service, tenantsRepo } = buildService();
    tenantsRepo.create.mockRejectedValue({
      code: "23505",
      message:
        "duplicate key value violates unique constraint \"tenants_slug_active_uidx\"",
    });

    await expect(
      service.create(sessionPrincipal, { slug: "dup", name: "Dup" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("CR7: {code:'23505', constraint:'other_constraint'} → rethrown as-is", async () => {
    const { service, tenantsRepo } = buildService();
    const originalError = {
      code: "23505",
      constraint: "other_unique_constraint",
      message: "unrelated unique violation",
    };
    tenantsRepo.create.mockRejectedValue(originalError);

    const err = await service
      .create(sessionPrincipal, { slug: "x", name: "X" })
      .catch((e: unknown) => e);

    expect(err).toBe(originalError);
    expect(err).not.toBeInstanceOf(ConflictException);
  });
});

// ===========================================================================
// RE. read() — admin path / user path / not-found branches
// ===========================================================================

describe("TenantsService.read", () => {
  it("RE1: platform-admin token → findByIdAdmin(pool, tenantId); tx NOT invoked", async () => {
    const { service, tenantsRepo, membershipsRepo, tx } = buildService();
    const row = makeTenantRecord({ id: TENANT_ID });
    tenantsRepo.findByIdAdmin.mockResolvedValue(row);

    const result = await service.read(tokenPlatformAdmin, TENANT_ID);

    expect(result).toBe(row);
    expect(tenantsRepo.findByIdAdmin).toHaveBeenCalledWith(fakeClient, TENANT_ID);
    expect(tenantsRepo.findById).not.toHaveBeenCalled();
    expect(membershipsRepo.findRoleCodeForUserInTenant).not.toHaveBeenCalled();
    expect(tx).toHaveBeenCalledWith(fakePool, { tenantId: TENANT_ID, isPlatformAdmin: true }, expect.any(Function));
  });

  it("RE2: platform-admin token + findByIdAdmin returns null → NotFoundException", async () => {
    const { service, tenantsRepo } = buildService();
    tenantsRepo.findByIdAdmin.mockResolvedValue(null);

    await expect(
      service.read(tokenPlatformAdmin, TENANT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("RE3: session user (non-admin) with role → tx invoked, findById returns row", async () => {
    const { service, tenantsRepo, membershipsRepo, tx } = buildService();
    membershipsRepo.isPlatformAdmin.mockResolvedValue(false);
    membershipsRepo.findRoleCodeForUserInTenant.mockResolvedValue("tenant_admin");
    const row = makeTenantRecord({ id: TENANT_ID });
    tenantsRepo.findById.mockResolvedValue(row);

    const result = await service.read(sessionPrincipal, TENANT_ID);

    expect(result).toBe(row);
    expect(membershipsRepo.findRoleCodeForUserInTenant).toHaveBeenCalledWith(
      USER_ID,
      TENANT_ID,
      fakeClient,
    );
    expect(tx).toHaveBeenCalledTimes(2);
    const txCall = tx.mock.calls[0]!;
    expect(txCall[1]).toEqual({ tenantId: TENANT_ID, isPlatformAdmin: false });
    expect(tenantsRepo.findById).toHaveBeenCalledWith(fakeClient, TENANT_ID);
    expect(tenantsRepo.findByIdAdmin).not.toHaveBeenCalled();
  });

  it("RE4: session user with role but findById returns null → NotFoundException (inside tx)", async () => {
    const { service, tenantsRepo, membershipsRepo } = buildService();
    membershipsRepo.isPlatformAdmin.mockResolvedValue(false);
    membershipsRepo.findRoleCodeForUserInTenant.mockResolvedValue("tenant_admin");
    tenantsRepo.findById.mockResolvedValue(null);

    await expect(
      service.read(sessionPrincipal, TENANT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("RE5: session user, findRoleCodeForUserInTenant returns null → NotFoundException", async () => {
    const { service, tenantsRepo, membershipsRepo, tx } = buildService();
    membershipsRepo.isPlatformAdmin.mockResolvedValue(false);
    membershipsRepo.findRoleCodeForUserInTenant.mockResolvedValue(null);

    await expect(
      service.read(sessionPrincipal, TENANT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(tx).toHaveBeenCalledTimes(1);
    expect(tenantsRepo.findById).not.toHaveBeenCalled();
  });

  it("RE6: token with userId=null + tenantId set → NotFoundException (no membership lookup)", async () => {
    const { service, tenantsRepo, membershipsRepo, tx } = buildService();

    await expect(
      service.read(tokenPrincipalNullUserId, TENANT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(membershipsRepo.isPlatformAdmin).not.toHaveBeenCalled();
    expect(membershipsRepo.findRoleCodeForUserInTenant).not.toHaveBeenCalled();
    expect(tenantsRepo.findById).not.toHaveBeenCalled();
    expect(tenantsRepo.findByIdAdmin).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// UP. update() — admin vs non-admin context + null-row 404
// ===========================================================================

describe("TenantsService.update", () => {
  it("UP1: admin context → tx ctx isPlatformAdmin=true; returns row", async () => {
    const { service, tenantsRepo, membershipsRepo, tx } = buildService();
    membershipsRepo.isPlatformAdmin.mockResolvedValue(true);
    const row = makeTenantRecord({ id: TENANT_ID, name: "Renamed" });
    tenantsRepo.update.mockResolvedValue(row);

    const result = await service.update(sessionPrincipal, TENANT_ID, {
      name: "Renamed",
    });

    expect(result).toBe(row);
    const txCall = tx.mock.calls[0]!;
    expect(txCall[1]).toEqual({ tenantId: TENANT_ID, isPlatformAdmin: true });
    expect(tenantsRepo.update).toHaveBeenCalledWith(fakeClient, TENANT_ID, {
      name: "Renamed",
    });
  });

  it("UP2: non-admin context → tx ctx isPlatformAdmin=false", async () => {
    const { service, tenantsRepo, membershipsRepo, tx } = buildService();
    membershipsRepo.isPlatformAdmin.mockResolvedValue(false);
    const row = makeTenantRecord({ id: TENANT_ID });
    tenantsRepo.update.mockResolvedValue(row);

    const result = await service.update(sessionPrincipal, TENANT_ID, {
      status: "suspended",
    });

    expect(result).toBe(row);
    const txCall = tx.mock.calls[0]!;
    expect(txCall[1]).toEqual({ tenantId: TENANT_ID, isPlatformAdmin: false });
    expect(tenantsRepo.update).toHaveBeenCalledWith(fakeClient, TENANT_ID, {
      status: "suspended",
    });
  });

  it("UP3: tenants.update returns null → NotFoundException", async () => {
    const { service, tenantsRepo, membershipsRepo } = buildService();
    membershipsRepo.isPlatformAdmin.mockResolvedValue(true);
    tenantsRepo.update.mockResolvedValue(null);

    await expect(
      service.update(sessionPrincipal, TENANT_ID, { name: "X" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ===========================================================================
// SD. softDelete() — happy path
// ===========================================================================

describe("TenantsService.softDelete", () => {
  it("SD1: tx ctx isPlatformAdmin=true; tenants.softDelete(client, tenantId) called", async () => {
    const { service, tenantsRepo, tx } = buildService();
    tenantsRepo.softDelete.mockResolvedValue(undefined as unknown as boolean);

    await service.softDelete(sessionPrincipal, TENANT_ID);

    expect(tx).toHaveBeenCalledTimes(1);
    const txCall = tx.mock.calls[0]!;
    expect(txCall[0]).toBe(fakePool);
    expect(txCall[1]).toEqual({ tenantId: TENANT_ID, isPlatformAdmin: true });
    expect(tenantsRepo.softDelete).toHaveBeenCalledWith(fakeClient, TENANT_ID);
  });
});

// ===========================================================================
// LM. listMembers() — admin vs non-admin context
// ===========================================================================

describe("TenantsService.listMembers", () => {
  it("LM1: admin context → tx ctx isPlatformAdmin=true; memberships.listForTenant(client, tenantId) called", async () => {
    const { service, membershipsRepo, tx } = buildService();
    membershipsRepo.isPlatformAdmin.mockResolvedValue(true);
    const details = [makeMembershipDetail()];
    membershipsRepo.listForTenant.mockResolvedValue(details);

    const result = await service.listMembers(sessionPrincipal, TENANT_ID);

    expect(result).toBe(details);
    const txCall = tx.mock.calls[0]!;
    expect(txCall[1]).toEqual({ tenantId: TENANT_ID, isPlatformAdmin: true });
    expect(membershipsRepo.listForTenant).toHaveBeenCalledWith(
      fakeClient,
      TENANT_ID,
    );
  });

  it("LM2: non-admin context → tx ctx isPlatformAdmin=false", async () => {
    const { service, membershipsRepo, tx } = buildService();
    membershipsRepo.isPlatformAdmin.mockResolvedValue(false);
    const details = [makeMembershipDetail({ roleCode: "store_manager" })];
    membershipsRepo.listForTenant.mockResolvedValue(details);

    const result = await service.listMembers(sessionPrincipal, TENANT_ID);

    expect(result).toBe(details);
    const txCall = tx.mock.calls[0]!;
    expect(txCall[1]).toEqual({ tenantId: TENANT_ID, isPlatformAdmin: false });
    expect(membershipsRepo.listForTenant).toHaveBeenCalledWith(
      fakeClient,
      TENANT_ID,
    );
  });

  it("LM3: platform-scoped token (tenantId=null) → tx ctx isPlatformAdmin=true (short-circuit, no memberships call)", async () => {
    const { service, membershipsRepo, tx } = buildService();
    const details = [makeMembershipDetail()];
    membershipsRepo.listForTenant.mockResolvedValue(details);

    const result = await service.listMembers(tokenPlatformAdmin, TENANT_ID);

    expect(result).toBe(details);
    expect(membershipsRepo.isPlatformAdmin).not.toHaveBeenCalled();
    const txCall = tx.mock.calls[0]!;
    expect(txCall[1]).toEqual({ tenantId: TENANT_ID, isPlatformAdmin: true });
  });
});

// ===========================================================================
// CO. constructor — tx fallback when no runner injected
// ===========================================================================

describe("TenantsService constructor — tx fallback", () => {
  it("CO1: omitting tx still constructs the service (real runWithTenantContext bound; not invoked here)", () => {
    const tenantsRepo = makeFakeTenantsRepo();
    const membershipsRepo = makeFakeMembershipsRepo();
    const service = new TenantsService(
      fakePool,
      tenantsRepo as unknown as TenantsRepository,
      membershipsRepo as unknown as MembershipRepository,
      // intentionally no tx arg — exercises the `tx ?? runWithTenantContext` fallback
    );
    expect(service).toBeInstanceOf(TenantsService);
  });
});
