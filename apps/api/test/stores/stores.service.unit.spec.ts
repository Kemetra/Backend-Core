/**
 * stores.service.unit.spec.ts
 *
 * Docker-free unit coverage for StoresService.
 *
 * Strategy:
 *   - Construct StoresService with a fake TxRunner injected via the
 *     `@Optional() tx` constructor parameter. The fake tx calls
 *     `work(fakeClient)` directly, bypassing `runWithTenantContext`.
 *   - Mock StoresRepository and MembershipRepository with per-test
 *     jest.fn() overrides.
 *   - Mock `@data-pulse-2/shared` (newId) for determinism.
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit mocks.
 * The fake TxRunner bypasses `runWithTenantContext` and the fake repository
 * resolves whatever rows are stubbed — RLS is a DB-layer guarantee tested
 * only with a real Postgres instance (Testcontainers integration spec).
 *
 * The `tx ?? runWithTenantContext` constructor fallback (when `tx` is
 * omitted) is intentionally deferred — exercising it requires a real
 * Postgres pool, which is out of scope for unit coverage. All tests
 * supply the fake tx runner explicitly.
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
  // RT-125: real queue names (read at module load by queue producers).
  QUEUE_NAMES: jest.requireActual("@data-pulse-2/shared").QUEUE_NAMES,
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

import { StoresService } from "../../src/stores/stores.service";
import type {
  StoreRecord,
  StoresRepository,
} from "../../src/stores/stores.repository";
import type {
  ActiveMembership,
  MembershipRepository,
} from "../../src/context/membership.repository";
import type { ResolvedContext } from "../../src/context/types";

import { newId } from "@data-pulse-2/shared";

const mockNewId = newId as jest.MockedFunction<typeof newId>;

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const USER_ID       = "0193c000-0000-7000-8000-0000000000a1";
const TENANT_ID     = "0193c000-0000-7000-8000-0000000000b2";
const STORE_ID      = "0193c000-0000-7000-8000-0000000000c3";
const MEMBERSHIP_ID = "0193c000-0000-7000-8000-0000000000d4";

const NOW = new Date("2026-01-01T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeStoreRecord(overrides: Partial<StoreRecord> = {}): StoreRecord {
  return {
    id: STORE_ID,
    tenantId: TENANT_ID,
    code: "MAIN",
    name: "Main Store",
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeActiveMembership(
  overrides: Partial<ActiveMembership> = {},
): ActiveMembership {
  return {
    membershipId: MEMBERSHIP_ID,
    storeAccessKind: "all",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake repositories — jest.fn() fields, overridden per-test
// ---------------------------------------------------------------------------

function makeFakeStoresRepo(): jest.Mocked<StoresRepository> {
  return {
    listInTenant:    jest.fn(),
    findById:        jest.fn(),
    create:          jest.fn(),
    update:          jest.fn(),
    softDelete:      jest.fn(),
    existsInTenant:  jest.fn(),
  } as unknown as jest.Mocked<StoresRepository>;
}

function makeFakeMembershipsRepo(): jest.Mocked<MembershipRepository> {
  return {
    isPlatformAdmin:             jest.fn(),
    findActiveMembership:        jest.fn(),
    canAccessStore:              jest.fn(),
    listForUser:                 jest.fn(),
    findRoleCodeForUserInTenant: jest.fn(),
    findTenantSummary:           jest.fn(),
    findStoreSummary:            jest.fn(),
    findUserSummary:             jest.fn(),
    listForTenant:               jest.fn(),
  } as unknown as jest.Mocked<MembershipRepository>;
}

// ---------------------------------------------------------------------------
// TxRunner fake — synchronously calls work(fakeClient)
// ---------------------------------------------------------------------------

const fakeClient = {} as PoolClient;
const fakePool   = {} as Pool;

function makeFakeTx() {
  return jest.fn(
    async <T>(
      _pool: Pool,
      _ctx: unknown,
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => work(fakeClient),
  );
}

// ---------------------------------------------------------------------------
// Helper: build service with defaults
// ---------------------------------------------------------------------------

interface BuildServiceOpts {
  storesRepo?:      jest.Mocked<StoresRepository>;
  membershipsRepo?: jest.Mocked<MembershipRepository>;
  tx?:              ReturnType<typeof makeFakeTx>;
}

function buildService(opts: BuildServiceOpts = {}) {
  const storesRepo      = opts.storesRepo      ?? makeFakeStoresRepo();
  const membershipsRepo = opts.membershipsRepo ?? makeFakeMembershipsRepo();
  const tx              = opts.tx              ?? makeFakeTx();

  const service = new StoresService(
    fakePool,
    storesRepo as unknown as StoresRepository,
    membershipsRepo as unknown as MembershipRepository,
    tx as unknown as NonNullable<ConstructorParameters<typeof StoresService>[3]>,
  );

  return { service, storesRepo, membershipsRepo, tx };
}

// ---------------------------------------------------------------------------
// Reset shared state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockNewId.mockReturnValue(STORE_ID);
});

// ===========================================================================
// CTOR. constructor fallback — `tx ?? runWithTenantContext`
// ===========================================================================

describe("StoresService constructor", () => {
  it("CTOR1: omitting tx falls back to runWithTenantContext (constructor branch only)", () => {
    // Construct WITHOUT a tx — exercises the right-hand branch of
    // `tx ?? runWithTenantContext`. We do NOT invoke any service method
    // here; calling one would require a real Postgres pool. This test
    // pins the construction path so the nullish-coalesce branch is
    // exercised at least once.
    const storesRepo      = makeFakeStoresRepo();
    const membershipsRepo = makeFakeMembershipsRepo();

    const service = new StoresService(
      fakePool,
      storesRepo as unknown as StoresRepository,
      membershipsRepo as unknown as MembershipRepository,
    );

    expect(service).toBeInstanceOf(StoresService);
  });
});

// ===========================================================================
// L. list()
// ===========================================================================

describe("StoresService.list", () => {
  it("L1: calls tx with pool + tenantCtx and proxies to stores.listInTenant", async () => {
    const { service, storesRepo, tx } = buildService();
    const rows = [makeStoreRecord(), makeStoreRecord({ id: "other-id" })];
    storesRepo.listInTenant.mockResolvedValue(rows);
    const ctx = makeCtx();

    const result = await service.list(ctx);

    expect(result).toBe(rows);
    expect(storesRepo.listInTenant).toHaveBeenCalledTimes(1);
    expect(storesRepo.listInTenant).toHaveBeenCalledWith(fakeClient);
    expect(tx).toHaveBeenCalledTimes(1);
    // tx invoked with pool, tenantCtx, work fn
    const txCall = tx.mock.calls[0]!;
    expect(txCall[0]).toBe(fakePool);
    expect(txCall[1]).toEqual({
      tenantId: TENANT_ID,
      isPlatformAdmin: false,
    });
    expect(typeof txCall[2]).toBe("function");
  });
});

// ===========================================================================
// CR. create()
// ===========================================================================

describe("StoresService.create", () => {
  it("CR1: ctx.tenantId === null → NotFoundException (defensive guard before tx)", async () => {
    const { service, storesRepo, tx } = buildService();
    const ctx = makeCtx({ tenantId: null });

    await expect(
      service.create(ctx, { code: "MAIN", name: "Main" }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(tx).not.toHaveBeenCalled();
    expect(storesRepo.create).not.toHaveBeenCalled();
  });

  it("CR2: happy path — stores.create called with minted id + tenantCtx forwarded", async () => {
    const { service, storesRepo, tx } = buildService();
    const row = makeStoreRecord();
    storesRepo.create.mockResolvedValue(row);
    const ctx = makeCtx();

    const result = await service.create(ctx, { code: "MAIN", name: "Main Store" });

    expect(result).toBe(row);
    expect(mockNewId).toHaveBeenCalledTimes(1);
    expect(storesRepo.create).toHaveBeenCalledTimes(1);
    expect(storesRepo.create).toHaveBeenCalledWith(fakeClient, {
      id: STORE_ID,
      tenantId: TENANT_ID,
      code: "MAIN",
      name: "Main Store",
    });
    // tx invoked with the resolved tenant context
    expect(tx.mock.calls[0]![1]).toEqual({
      tenantId: TENANT_ID,
      isPlatformAdmin: false,
    });
  });

  it("CR3: stores.create throws direct {code:'23505',constraint:'stores_tenant_code_uidx'} → ConflictException", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.create.mockRejectedValue({
      code: "23505",
      constraint: "stores_tenant_code_uidx",
      message: "duplicate key",
    });
    const ctx = makeCtx();

    await expect(
      service.create(ctx, { code: "DUP", name: "Dup" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("CR4: stores.create throws drizzle-wrapped {cause:{code:'23505',constraint:'stores_tenant_code_uidx'}} → ConflictException", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.create.mockRejectedValue({
      message: "DrizzleQueryError",
      cause: {
        code: "23505",
        constraint: "stores_tenant_code_uidx",
      },
    });
    const ctx = makeCtx();

    await expect(
      service.create(ctx, { code: "DUP", name: "Dup" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("CR5: stores.create throws {code:'23505',constraint:'other_constraint'} → rethrown as-is", async () => {
    const { service, storesRepo } = buildService();
    const originalError = {
      code: "23505",
      constraint: "other_unique_constraint",
      message: "duplicate on something else",
    };
    storesRepo.create.mockRejectedValue(originalError);
    const ctx = makeCtx();

    const err = await service
      .create(ctx, { code: "X", name: "X" })
      .catch((e: unknown) => e);

    expect(err).toBe(originalError);
    expect(err).not.toBeInstanceOf(ConflictException);
  });

  it("CR6: stores.create throws {code:'23505',message:'...stores_tenant_code_uidx...'} → ConflictException (message-substring path)", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.create.mockRejectedValue({
      code: "23505",
      message:
        "duplicate key value violates unique constraint \"stores_tenant_code_uidx\"",
    });
    const ctx = makeCtx();

    await expect(
      service.create(ctx, { code: "DUP", name: "Dup" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("CR7: stores.create throws non-23505 random Error → rethrown verbatim", async () => {
    const { service, storesRepo } = buildService();
    const randomError = new Error("connection reset");
    storesRepo.create.mockRejectedValue(randomError);
    const ctx = makeCtx();

    await expect(
      service.create(ctx, { code: "MAIN", name: "Main" }),
    ).rejects.toBe(randomError);
  });

  it("CR8: stores.create throws null → rethrown (covers null branch in isUniqueViolation)", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.create.mockRejectedValue(null);
    const ctx = makeCtx();

    const err = await service
      .create(ctx, { code: "MAIN", name: "Main" })
      .catch((e: unknown) => e);

    expect(err).toBeNull();
  });
});

// ===========================================================================
// RE. read()
// ===========================================================================

describe("StoresService.read", () => {
  it("RE1: ctx.tenantId === null → NotFoundException (before tx)", async () => {
    const { service, storesRepo, membershipsRepo, tx } = buildService();
    const ctx = makeCtx({ tenantId: null });

    await expect(service.read(ctx, STORE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(tx).not.toHaveBeenCalled();
    expect(storesRepo.findById).not.toHaveBeenCalled();
    expect(membershipsRepo.findActiveMembership).not.toHaveBeenCalled();
  });

  it("RE2: session caller, findActiveMembership returns null → NotFoundException", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    membershipsRepo.findActiveMembership.mockResolvedValue(null);
    const ctx = makeCtx();

    await expect(service.read(ctx, STORE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(membershipsRepo.findActiveMembership).toHaveBeenCalledWith(
      USER_ID,
      TENANT_ID,
      fakeClient,
    );
    expect(membershipsRepo.canAccessStore).not.toHaveBeenCalled();
    expect(storesRepo.findById).not.toHaveBeenCalled();
  });

  it("RE3: session caller, canAccessStore returns false → NotFoundException", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    membershipsRepo.findActiveMembership.mockResolvedValue(
      makeActiveMembership({ storeAccessKind: "specific" }),
    );
    membershipsRepo.canAccessStore.mockResolvedValue(false);
    const ctx = makeCtx();

    await expect(service.read(ctx, STORE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(membershipsRepo.canAccessStore).toHaveBeenCalledWith(
      MEMBERSHIP_ID,
      TENANT_ID,
      STORE_ID,
      "specific",
      fakeClient,
    );
    expect(storesRepo.findById).not.toHaveBeenCalled();
  });

  it("RE4: session caller, canAccessStore true, stores.findById returns null → NotFoundException", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    membershipsRepo.findActiveMembership.mockResolvedValue(makeActiveMembership());
    membershipsRepo.canAccessStore.mockResolvedValue(true);
    storesRepo.findById.mockResolvedValue(null);
    const ctx = makeCtx();

    await expect(service.read(ctx, STORE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(storesRepo.findById).toHaveBeenCalledWith(fakeClient, STORE_ID);
  });

  it("RE5: session caller, all checks pass → returns store record", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    const row = makeStoreRecord();
    membershipsRepo.findActiveMembership.mockResolvedValue(makeActiveMembership());
    membershipsRepo.canAccessStore.mockResolvedValue(true);
    storesRepo.findById.mockResolvedValue(row);
    const ctx = makeCtx();

    const result = await service.read(ctx, STORE_ID);

    expect(result).toBe(row);
    expect(membershipsRepo.findActiveMembership).toHaveBeenCalledTimes(1);
    expect(membershipsRepo.canAccessStore).toHaveBeenCalledTimes(1);
  });

  it("RE6: platform admin session — skips stage 1, findById called directly", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    const row = makeStoreRecord();
    storesRepo.findById.mockResolvedValue(row);
    const ctx = makeCtx({ isPlatformAdmin: true });

    const result = await service.read(ctx, STORE_ID);

    expect(result).toBe(row);
    expect(membershipsRepo.findActiveMembership).not.toHaveBeenCalled();
    expect(membershipsRepo.canAccessStore).not.toHaveBeenCalled();
    expect(storesRepo.findById).toHaveBeenCalledWith(fakeClient, STORE_ID);
  });

  it("RE7: token caller (source='token') — skips stage 1, findById called directly", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    const row = makeStoreRecord();
    storesRepo.findById.mockResolvedValue(row);
    const ctx = makeCtx({ source: "token" });

    const result = await service.read(ctx, STORE_ID);

    expect(result).toBe(row);
    expect(membershipsRepo.findActiveMembership).not.toHaveBeenCalled();
    expect(storesRepo.findById).toHaveBeenCalledWith(fakeClient, STORE_ID);
  });

  it("RE8: session caller with userId=null — skips stage 1 (ctx.userId falsy), goes to stage 2", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    const row = makeStoreRecord();
    storesRepo.findById.mockResolvedValue(row);
    const ctx = makeCtx({ userId: null });

    const result = await service.read(ctx, STORE_ID);

    expect(result).toBe(row);
    expect(membershipsRepo.findActiveMembership).not.toHaveBeenCalled();
    expect(storesRepo.findById).toHaveBeenCalledWith(fakeClient, STORE_ID);
  });
});

// ===========================================================================
// UP. update()
// ===========================================================================

describe("StoresService.update", () => {
  it("UP1: stores.update returns null → NotFoundException", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.update.mockResolvedValue(null);
    const ctx = makeCtx();

    await expect(
      service.update(ctx, STORE_ID, { name: "Renamed" }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(storesRepo.update).toHaveBeenCalledWith(fakeClient, STORE_ID, {
      name: "Renamed",
      isActive: undefined,
    });
  });

  it("UP2: happy path — returns updated record; is_active mapped to isActive", async () => {
    const { service, storesRepo } = buildService();
    const row = makeStoreRecord({ name: "Renamed", isActive: false });
    storesRepo.update.mockResolvedValue(row);
    const ctx = makeCtx();

    const result = await service.update(ctx, STORE_ID, {
      name: "Renamed",
      is_active: false,
    });

    expect(result).toBe(row);
    expect(storesRepo.update).toHaveBeenCalledWith(fakeClient, STORE_ID, {
      name: "Renamed",
      isActive: false,
    });
  });
});

// ===========================================================================
// SD. softDelete()
// ===========================================================================

describe("StoresService.softDelete", () => {
  it("SD1: stores.existsInTenant returns false → NotFoundException; softDelete NOT called", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.existsInTenant.mockResolvedValue(false);
    const ctx = makeCtx();

    await expect(service.softDelete(ctx, STORE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(storesRepo.existsInTenant).toHaveBeenCalledWith(fakeClient, STORE_ID);
    expect(storesRepo.softDelete).not.toHaveBeenCalled();
  });

  it("SD2: happy path — softDelete called after existence check; resolves void", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.existsInTenant.mockResolvedValue(true);
    storesRepo.softDelete.mockResolvedValue(true);
    const ctx = makeCtx();

    const result = await service.softDelete(ctx, STORE_ID);

    expect(result).toBeUndefined();
    expect(storesRepo.existsInTenant).toHaveBeenCalledWith(fakeClient, STORE_ID);
    expect(storesRepo.softDelete).toHaveBeenCalledWith(fakeClient, STORE_ID);

    // existsInTenant ran before softDelete
    const existsOrder = storesRepo.existsInTenant.mock.invocationCallOrder[0]!;
    const softDeleteOrder = storesRepo.softDelete.mock.invocationCallOrder[0]!;
    expect(existsOrder).toBeLessThan(softDeleteOrder);
  });
});
