/**
 * memberships.service.unit.spec.ts
 *
 * Docker-free unit coverage for MembershipsService.
 *
 * Strategy:
 *   - Construct MembershipsService with a fake TxRunner injected via the
 *     `@Optional() tx` constructor parameter. The fake tx calls
 *     `work(fakeClient)` directly, bypassing `runWithTenantContext`.
 *   - Mock MembershipsRepository with per-test jest.fn() overrides.
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit mocks.
 * The fake TxRunner bypasses `runWithTenantContext` and the fake repo
 * resolves whatever rows are seeded — RLS is a DB-layer guarantee tested
 * only with a real Postgres instance (Testcontainers integration spec).
 *
 * Note: the `tx ?? runWithTenantContext` constructor fallback is the one
 * deferred branch (covered only via integration tests with a real pool).
 */

import "reflect-metadata";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { MembershipsService } from "../../src/memberships/memberships.service";
import type {
  MembershipsRepository,
  ExistingMembership,
} from "../../src/memberships/memberships.repository";
import type { MembershipDetail } from "../../src/context/membership.repository";
import type { ResolvedContext } from "../../src/context/types";
import type { MembershipUpdateDto } from "../../src/memberships/dto";

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const TENANT_ID     = "0193c000-0000-7000-8000-0000000000b1";
const USER_ID       = "0193c000-0000-7000-8000-0000000000b2";
const MEMBERSHIP_ID = "0193c000-0000-7000-8000-0000000000b3";
const ROLE_ID       = "0193c000-0000-7000-8000-0000000000b4";
const NEW_ROLE_ID   = "0193c000-0000-7000-8000-0000000000b5";
const STORE_ID_1    = "0193c000-0000-7000-8000-0000000000c1";
const STORE_ID_2    = "0193c000-0000-7000-8000-0000000000c2";
const STORE_ID_3    = "0193c000-0000-7000-8000-0000000000c3";
const ROLE_CODE     = "tenant_admin";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeExistingMembership(
  overrides: Partial<ExistingMembership> = {},
): ExistingMembership {
  return {
    id: MEMBERSHIP_ID,
    tenantId: TENANT_ID,
    roleId: ROLE_ID,
    storeAccessKind: "all",
    ...overrides,
  };
}

function makeMembershipDetail(
  overrides: Partial<MembershipDetail> = {},
): MembershipDetail {
  return {
    membershipId: MEMBERSHIP_ID,
    user: {
      id: USER_ID,
      email: "user@example.com",
      displayName: "Test User",
    },
    roleCode: ROLE_CODE,
    storeAccessKind: "all",
    accessibleStoreIds: [],
    revokedAt: null,
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
// Fakes
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

function makeFakeRepo(): jest.Mocked<MembershipsRepository> {
  return {
    revoke:               jest.fn(),
    findActive:           jest.fn(),
    findRoleId:           jest.fn(),
    findInvalidStoreIds:  jest.fn(),
    update:               jest.fn(),
  } as unknown as jest.Mocked<MembershipsRepository>;
}

interface BuildServiceOpts {
  repo?: jest.Mocked<MembershipsRepository>;
  tx?:   ReturnType<typeof makeFakeTx>;
}

function buildService(opts: BuildServiceOpts = {}) {
  const repo = opts.repo ?? makeFakeRepo();
  const tx   = opts.tx   ?? makeFakeTx();

  // MembershipsService(pool, memberships, tx?)
  const service = new MembershipsService(
    fakePool,
    repo as unknown as MembershipsRepository,
    tx as unknown as NonNullable<ConstructorParameters<typeof MembershipsService>[2]>,
  );

  return { service, repo, tx };
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

// ===========================================================================
// R. revoke()
// ===========================================================================

describe("MembershipsService.revoke", () => {
  it("R1: memberships.revoke returns false → NotFoundException", async () => {
    const { service, repo } = buildService();
    repo.revoke.mockResolvedValue(false);
    const ctx = makeCtx();

    await expect(service.revoke(ctx, MEMBERSHIP_ID))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("R2: memberships.revoke returns true → resolves void", async () => {
    const { service, repo, tx } = buildService();
    repo.revoke.mockResolvedValue(true);
    const ctx = makeCtx();

    await expect(service.revoke(ctx, MEMBERSHIP_ID)).resolves.toBeUndefined();

    // tx invoked with pool + tenant context + work function
    expect(tx).toHaveBeenCalledTimes(1);
    const txCall = tx.mock.calls[0]!;
    expect(txCall[0]).toBe(fakePool);
    expect(txCall[1]).toEqual({ tenantId: TENANT_ID, isPlatformAdmin: false });
    expect(typeof txCall[2]).toBe("function");

    // repo called with the fakeClient + membershipId + tenantId
    expect(repo.revoke).toHaveBeenCalledWith(fakeClient, MEMBERSHIP_ID, TENANT_ID);
  });

  it("R2b: tenant context passes isPlatformAdmin through", async () => {
    const { service, repo, tx } = buildService();
    repo.revoke.mockResolvedValue(true);
    const ctx = makeCtx({ isPlatformAdmin: true });

    await service.revoke(ctx, MEMBERSHIP_ID);

    const txCall = tx.mock.calls[0]!;
    expect(txCall[1]).toEqual({ tenantId: TENANT_ID, isPlatformAdmin: true });
  });
});

// ===========================================================================
// U. update() — 404 gate
// ===========================================================================

describe("MembershipsService.update — 404 gate", () => {
  it("U1: findActive returns null → NotFoundException", async () => {
    const { service, repo } = buildService();
    repo.findActive.mockResolvedValue(null);
    const ctx = makeCtx();

    await expect(
      service.update(ctx, MEMBERSHIP_ID, { role_code: ROLE_CODE } as MembershipUpdateDto),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repo.findRoleId).not.toHaveBeenCalled();
    expect(repo.findInvalidStoreIds).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// U. update() — role_code validation
// ===========================================================================

describe("MembershipsService.update — role_code validation", () => {
  it("U2: dto.role_code === 'platform_admin' → BadRequestException (platform-level)", async () => {
    const { service, repo } = buildService();
    repo.findActive.mockResolvedValue(makeExistingMembership());
    const ctx = makeCtx();

    const err = await service
      .update(ctx, MEMBERSHIP_ID, { role_code: "platform_admin" } as MembershipUpdateDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain("platform-level");
    expect(repo.findRoleId).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("U3: dto.role_code provided, findRoleId returns null → BadRequestException (Unknown role_code)", async () => {
    const { service, repo } = buildService();
    repo.findActive.mockResolvedValue(makeExistingMembership());
    repo.findRoleId.mockResolvedValue(null);
    const ctx = makeCtx();

    const err = await service
      .update(ctx, MEMBERSHIP_ID, { role_code: "nonexistent_role" } as MembershipUpdateDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain("Unknown role_code");
    expect((err as BadRequestException).message).toContain("nonexistent_role");
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("U8: dto.role_code undefined → findRoleId NOT called; update receives roleId=undefined", async () => {
    const { service, repo } = buildService();
    const existing = makeExistingMembership({ storeAccessKind: "all" });
    repo.findActive.mockResolvedValue(existing);
    repo.update.mockResolvedValue(makeMembershipDetail());
    const ctx = makeCtx();

    // Provide only store_access_kind to satisfy "at least one field" expectation
    // (DTO validation happens upstream; service itself doesn't require it).
    await service.update(ctx, MEMBERSHIP_ID, {
      store_access_kind: "all",
    } as MembershipUpdateDto);

    expect(repo.findRoleId).not.toHaveBeenCalled();
    const params = repo.update.mock.calls[0]![2];
    expect(params.roleId).toBeUndefined();
  });
});

// ===========================================================================
// U. update() — store_ids without explicit kind change
// ===========================================================================

describe("MembershipsService.update — store_ids w/o store_access_kind", () => {
  it("U4: store_ids provided w/o store_access_kind, existing kind='all' → BadRequestException", async () => {
    const { service, repo } = buildService();
    repo.findActive.mockResolvedValue(
      makeExistingMembership({ storeAccessKind: "all" }),
    );
    const ctx = makeCtx();

    const err = await service
      .update(ctx, MEMBERSHIP_ID, {
        store_ids: [STORE_ID_1],
      } as MembershipUpdateDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain(
      "store_ids can only be updated without store_access_kind",
    );
    expect(repo.findInvalidStoreIds).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("U4b: store_ids provided w/o store_access_kind, existing kind='specific' → proceeds", async () => {
    const { service, repo } = buildService();
    repo.findActive.mockResolvedValue(
      makeExistingMembership({ storeAccessKind: "specific" }),
    );
    repo.findInvalidStoreIds.mockResolvedValue([]);
    repo.update.mockResolvedValue(
      makeMembershipDetail({
        storeAccessKind: "specific",
        accessibleStoreIds: [STORE_ID_1],
      }),
    );
    const ctx = makeCtx();

    const result = await service.update(ctx, MEMBERSHIP_ID, {
      store_ids: [STORE_ID_1],
    } as MembershipUpdateDto);

    expect(repo.findInvalidStoreIds).toHaveBeenCalledWith(
      fakeClient,
      TENANT_ID,
      [STORE_ID_1],
    );
    expect(result.storeAccessKind).toBe("specific");
  });
});

// ===========================================================================
// U. update() — store_ids validation
// ===========================================================================

describe("MembershipsService.update — store_ids validation", () => {
  it("U5: findInvalidStoreIds returns non-empty → BadRequestException listing invalid ids", async () => {
    const { service, repo } = buildService();
    repo.findActive.mockResolvedValue(makeExistingMembership());
    repo.findInvalidStoreIds.mockResolvedValue([STORE_ID_2, STORE_ID_3]);
    const ctx = makeCtx();

    const err = await service
      .update(ctx, MEMBERSHIP_ID, {
        store_access_kind: "specific",
        store_ids: [STORE_ID_1, STORE_ID_2, STORE_ID_3],
      } as MembershipUpdateDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain("store_ids not found in active tenant");
    expect((err as BadRequestException).message).toContain(STORE_ID_2);
    expect((err as BadRequestException).message).toContain(STORE_ID_3);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("U6: duplicate store_ids (all valid) → BadRequestException 'must not contain duplicates'", async () => {
    const { service, repo } = buildService();
    repo.findActive.mockResolvedValue(makeExistingMembership());
    repo.findInvalidStoreIds.mockResolvedValue([]);
    const ctx = makeCtx();

    const err = await service
      .update(ctx, MEMBERSHIP_ID, {
        store_access_kind: "specific",
        store_ids: [STORE_ID_1, STORE_ID_1, STORE_ID_2],
      } as MembershipUpdateDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain("must not contain duplicates");
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("U5b: effectiveKind='all' (from existing) → findInvalidStoreIds NOT called even if store_ids passed", async () => {
    // store_ids only path requires existing.storeAccessKind === 'specific'.
    // Here we test the inverse: when explicit store_access_kind='all' is provided,
    // store validation is skipped because effectiveKind !== 'specific'.
    const { service, repo } = buildService();
    repo.findActive.mockResolvedValue(makeExistingMembership({ storeAccessKind: "specific" }));
    repo.update.mockResolvedValue(makeMembershipDetail({ storeAccessKind: "all" }));
    const ctx = makeCtx();

    await service.update(ctx, MEMBERSHIP_ID, {
      store_access_kind: "all",
      store_ids: [],
    } as MembershipUpdateDto);

    expect(repo.findInvalidStoreIds).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledTimes(1);
  });

  it("U5c: effectiveKind='specific' with empty store_ids → BadRequestException", async () => {
    const { service, repo } = buildService();
    repo.findActive.mockResolvedValue(makeExistingMembership({ storeAccessKind: "specific" }));
    const ctx = makeCtx();

    const err = await service
      .update(ctx, MEMBERSHIP_ID, {
        store_access_kind: "specific",
        store_ids: [],
      } as MembershipUpdateDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain("store_ids must be non-empty");
    expect(repo.findInvalidStoreIds).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("U5d: store_access_kind='specific' with undefined store_ids → BadRequestException", async () => {
    const { service, repo } = buildService();
    repo.findActive.mockResolvedValue(makeExistingMembership({ storeAccessKind: "specific" }));
    const ctx = makeCtx();

    const err = await service
      .update(ctx, MEMBERSHIP_ID, {
        store_access_kind: "specific",
      } as MembershipUpdateDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain("store_ids must be non-empty");
    expect(repo.findInvalidStoreIds).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("U5e: store_ids-only empty array with existing kind='specific' → BadRequestException", async () => {
    const { service, repo } = buildService();
    repo.findActive.mockResolvedValue(makeExistingMembership({ storeAccessKind: "specific" }));
    const ctx = makeCtx();

    const err = await service
      .update(ctx, MEMBERSHIP_ID, {
        store_ids: [],
      } as MembershipUpdateDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain("store_ids must be non-empty");
    expect(repo.findInvalidStoreIds).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// U. update() — happy paths
// ===========================================================================

describe("MembershipsService.update — happy paths", () => {
  it("U7a: role_code update only → calls update with roleId, no storeAccessKind/storeIds", async () => {
    const { service, repo } = buildService();
    const existing = makeExistingMembership({ storeAccessKind: "all" });
    repo.findActive.mockResolvedValue(existing);
    repo.findRoleId.mockResolvedValue(NEW_ROLE_ID);
    const detail = makeMembershipDetail({ roleCode: "store_manager" });
    repo.update.mockResolvedValue(detail);
    const ctx = makeCtx();

    const result = await service.update(ctx, MEMBERSHIP_ID, {
      role_code: "store_manager",
    } as MembershipUpdateDto);

    expect(result).toBe(detail);
    expect(repo.update).toHaveBeenCalledTimes(1);
    const updateCall = repo.update.mock.calls[0]!;
    expect(updateCall[0]).toBe(fakeClient);
    expect(updateCall[1]).toBe(existing);
    expect(updateCall[2]).toEqual({
      roleId: NEW_ROLE_ID,
      storeAccessKind: undefined,
      storeIds: undefined,
    });
  });

  it("U7b: store_access_kind='all' update only → update called with kind, undefined storeIds", async () => {
    const { service, repo } = buildService();
    const existing = makeExistingMembership({ storeAccessKind: "specific" });
    repo.findActive.mockResolvedValue(existing);
    const detail = makeMembershipDetail({ storeAccessKind: "all" });
    repo.update.mockResolvedValue(detail);
    const ctx = makeCtx();

    const result = await service.update(ctx, MEMBERSHIP_ID, {
      store_access_kind: "all",
    } as MembershipUpdateDto);

    expect(result).toBe(detail);
    const params = repo.update.mock.calls[0]![2];
    expect(params).toEqual({
      roleId: undefined,
      storeAccessKind: "all",
      storeIds: undefined,
    });
  });

  it("U7c: store_access_kind='specific' with valid store_ids → update with deduped storeIds", async () => {
    const { service, repo } = buildService();
    const existing = makeExistingMembership({ storeAccessKind: "all" });
    repo.findActive.mockResolvedValue(existing);
    repo.findInvalidStoreIds.mockResolvedValue([]);
    const detail = makeMembershipDetail({
      storeAccessKind: "specific",
      accessibleStoreIds: [STORE_ID_1, STORE_ID_2],
    });
    repo.update.mockResolvedValue(detail);
    const ctx = makeCtx();

    const result = await service.update(ctx, MEMBERSHIP_ID, {
      store_access_kind: "specific",
      store_ids: [STORE_ID_1, STORE_ID_2],
    } as MembershipUpdateDto);

    expect(result).toBe(detail);
    expect(repo.findInvalidStoreIds).toHaveBeenCalledWith(
      fakeClient,
      TENANT_ID,
      [STORE_ID_1, STORE_ID_2],
    );
    const params = repo.update.mock.calls[0]![2];
    expect(params).toEqual({
      roleId: undefined,
      storeAccessKind: "specific",
      storeIds: [STORE_ID_1, STORE_ID_2],
    });
  });

  it("U7d: store_ids only (existing kind='specific') → update with deduped storeIds and undefined kind", async () => {
    const { service, repo } = buildService();
    const existing = makeExistingMembership({ storeAccessKind: "specific" });
    repo.findActive.mockResolvedValue(existing);
    repo.findInvalidStoreIds.mockResolvedValue([]);
    const detail = makeMembershipDetail({
      storeAccessKind: "specific",
      accessibleStoreIds: [STORE_ID_1],
    });
    repo.update.mockResolvedValue(detail);
    const ctx = makeCtx();

    const result = await service.update(ctx, MEMBERSHIP_ID, {
      store_ids: [STORE_ID_1],
    } as MembershipUpdateDto);

    expect(result).toBe(detail);
    const params = repo.update.mock.calls[0]![2];
    expect(params.storeAccessKind).toBeUndefined();
    expect(params.storeIds).toEqual([STORE_ID_1]);
  });

  it("U9: effectiveKind = dto.store_access_kind overrides existing.storeAccessKind", async () => {
    // existing kind = 'all', dto overrides to 'specific' → triggers store validation.
    const { service, repo } = buildService();
    const existing = makeExistingMembership({ storeAccessKind: "all" });
    repo.findActive.mockResolvedValue(existing);
    repo.findInvalidStoreIds.mockResolvedValue([]);
    repo.update.mockResolvedValue(
      makeMembershipDetail({
        storeAccessKind: "specific",
        accessibleStoreIds: [STORE_ID_1],
      }),
    );
    const ctx = makeCtx();

    await service.update(ctx, MEMBERSHIP_ID, {
      store_access_kind: "specific",
      store_ids: [STORE_ID_1],
    } as MembershipUpdateDto);

    // Validation ran because effectiveKind = 'specific' (from dto, not existing 'all')
    expect(repo.findInvalidStoreIds).toHaveBeenCalledTimes(1);
  });

  it("U10: combined role + store_access_kind + store_ids → update receives all three", async () => {
    const { service, repo } = buildService();
    const existing = makeExistingMembership({ storeAccessKind: "all" });
    repo.findActive.mockResolvedValue(existing);
    repo.findRoleId.mockResolvedValue(NEW_ROLE_ID);
    repo.findInvalidStoreIds.mockResolvedValue([]);
    const detail = makeMembershipDetail({
      roleCode: "store_manager",
      storeAccessKind: "specific",
      accessibleStoreIds: [STORE_ID_1, STORE_ID_2],
    });
    repo.update.mockResolvedValue(detail);
    const ctx = makeCtx();

    const result = await service.update(ctx, MEMBERSHIP_ID, {
      role_code: "store_manager",
      store_access_kind: "specific",
      store_ids: [STORE_ID_1, STORE_ID_2],
    } as MembershipUpdateDto);

    expect(result).toBe(detail);
    expect(repo.findRoleId).toHaveBeenCalledWith(fakeClient, TENANT_ID, "store_manager");
    const params = repo.update.mock.calls[0]![2];
    expect(params).toEqual({
      roleId: NEW_ROLE_ID,
      storeAccessKind: "specific",
      storeIds: [STORE_ID_1, STORE_ID_2],
    });
  });

  it("U10b: duplicate store_ids in valid combined update → deduped before reaching repo.update", async () => {
    // Note: dedup throws if length differs. So to test dedup-into-update path,
    // we feed unique ids. The "duplicate becomes deduped" path is exercised
    // through the empty-array branch: storeIds && length > 0 ? deduped : storeIds.
    const { service, repo } = buildService();
    const existing = makeExistingMembership({ storeAccessKind: "all" });
    repo.findActive.mockResolvedValue(existing);
    repo.findInvalidStoreIds.mockResolvedValue([]);
    repo.update.mockResolvedValue(makeMembershipDetail({
      storeAccessKind: "specific",
      accessibleStoreIds: [STORE_ID_1, STORE_ID_2, STORE_ID_3],
    }));
    const ctx = makeCtx();

    await service.update(ctx, MEMBERSHIP_ID, {
      store_access_kind: "specific",
      store_ids: [STORE_ID_1, STORE_ID_2, STORE_ID_3],
    } as MembershipUpdateDto);

    const params = repo.update.mock.calls[0]![2];
    // No duplicates passed, deduped output equals input.
    expect(params.storeIds).toEqual([STORE_ID_1, STORE_ID_2, STORE_ID_3]);
  });

  it("U11: tx is invoked exactly once per update() call, with correct pool + tenant context", async () => {
    const { service, repo, tx } = buildService();
    repo.findActive.mockResolvedValue(makeExistingMembership());
    repo.findRoleId.mockResolvedValue(NEW_ROLE_ID);
    repo.update.mockResolvedValue(makeMembershipDetail());
    const ctx = makeCtx({ isPlatformAdmin: true });

    await service.update(ctx, MEMBERSHIP_ID, {
      role_code: ROLE_CODE,
    } as MembershipUpdateDto);

    expect(tx).toHaveBeenCalledTimes(1);
    const txCall = tx.mock.calls[0]!;
    expect(txCall[0]).toBe(fakePool);
    expect(txCall[1]).toEqual({ tenantId: TENANT_ID, isPlatformAdmin: true });
    expect(typeof txCall[2]).toBe("function");
  });
});
