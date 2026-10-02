/**
 * MembershipsService — unit spec (no Postgres, no Testcontainers, no network).
 *
 * Pattern: hand-written fake MembershipsRepository + injectable TenantTxRunner
 * (passthrough), mirroring the InvitationsService unit-spec style.
 *
 * Coverage targets
 * ----------------
 * revoke()
 *   - memberships.revoke() returns false → NotFoundException
 *   - memberships.revoke() returns true  → resolves (void)
 *
 * update()
 *   - findActive() → null                                          → NotFoundException
 *   - dto.role_code === 'platform_admin'                           → BadRequestException
 *   - unknown role_code (findRoleId → null)                        → BadRequestException
 *   - store_ids without store_access_kind + existing kind ≠ 'specific' → BadRequestException
 *   - invalid store_ids (findInvalidStoreIds non-empty)            → BadRequestException
 *   - duplicate store_ids                                          → BadRequestException
 *   - happy path: role update only                                 → MembershipDetail
 *   - happy path: store_access_kind update only                    → MembershipDetail
 *   - happy path: store_ids only (existing kind = 'specific')      → MembershipDetail
 */
import "reflect-metadata";

import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { TenantContext } from "@data-pulse-2/db";

import { MembershipsService } from "../../src/memberships/memberships.service";
import type { MembershipsRepository } from "../../src/memberships/memberships.repository";
import type { ExistingMembership, UpdateParams } from "../../src/memberships/memberships.repository";
import type { MembershipDetail } from "../../src/context/membership.repository";
import type { ResolvedContext } from "../../src/context/types";

// ---------------------------------------------------------------------------
// Fixed UUIDs
// ---------------------------------------------------------------------------

const TENANT_ID       = "0b000000-0000-7000-8000-000000000001";
const USER_ID         = "0b000000-0000-7000-8000-000000000002";
const MEMBERSHIP_ID   = "0b000000-0000-7000-8000-000000000003";
const ROLE_ID         = "0b000000-0000-7000-8000-000000000004";
const STORE_ID_A      = "0b000000-0000-7000-8000-000000000005";
const STORE_ID_B      = "0b000000-0000-7000-8000-000000000006";

const BASE_CTX: ResolvedContext = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
};

// ---------------------------------------------------------------------------
// Fake Pool / PoolClient — never called; tx runner is intercepted
// ---------------------------------------------------------------------------

const FAKE_POOL = {} as Pool;
const FAKE_CLIENT = { query: jest.fn() } as unknown as PoolClient;

// ---------------------------------------------------------------------------
// Fake MembershipsRepository
// ---------------------------------------------------------------------------

class FakeMembershipsRepository {
  revokeResult            = true;
  findActiveResult: ExistingMembership | null = {
    id:              MEMBERSHIP_ID,
    tenantId:        TENANT_ID,
    roleId:          ROLE_ID,
    storeAccessKind: "all",
  };
  findRoleIdResult: string | null = ROLE_ID;
  findInvalidStoreIdsResult: string[] = [];
  updateResult: MembershipDetail = {
    membershipId:       MEMBERSHIP_ID,
    user:               { id: USER_ID, email: "user@example.com", displayName: null },
    roleCode:           "tenant_admin",
    storeAccessKind:    "all",
    accessibleStoreIds: [],
    revokedAt:          null,
  };
  updateCallParams: UpdateParams | null = null;

  async revoke(
    _client: PoolClient,
    _membershipId: string,
    _tenantId: string,
  ): Promise<boolean> {
    return this.revokeResult;
  }

  async findActive(
    _client: PoolClient,
    _membershipId: string,
    _tenantId: string,
  ): Promise<ExistingMembership | null> {
    return this.findActiveResult;
  }

  async findRoleId(
    _client: PoolClient,
    _tenantId: string,
    _code: string,
  ): Promise<string | null> {
    return this.findRoleIdResult;
  }

  async findInvalidStoreIds(
    _client: PoolClient,
    _tenantId: string,
    _ids: string[],
  ): Promise<string[]> {
    return this.findInvalidStoreIdsResult;
  }

  async update(
    _client: PoolClient,
    _existing: ExistingMembership,
    params: UpdateParams,
  ): Promise<MembershipDetail> {
    this.updateCallParams = params;
    return this.updateResult;
  }
}

// ---------------------------------------------------------------------------
// TenantTxRunner — passthrough; hands fakeClient into `work`
// ---------------------------------------------------------------------------

function makeTxRunner(client: PoolClient = FAKE_CLIENT) {
  return jest.fn(
    async <T>(
      _pool: Pool,
      _ctx: TenantContext,
      work: (c: PoolClient) => Promise<T>,
    ): Promise<T> => work(client),
  );
}

// ---------------------------------------------------------------------------
// Helper: build a MembershipsService with fake deps
// ---------------------------------------------------------------------------

function makeService(
  repo: FakeMembershipsRepository,
  tx = makeTxRunner(),
): MembershipsService {
  return new MembershipsService(
    FAKE_POOL,
    repo as unknown as MembershipsRepository,
    tx as unknown as NonNullable<ConstructorParameters<typeof MembershipsService>[2]>,
  );
}

// ---------------------------------------------------------------------------
// revoke()
// ---------------------------------------------------------------------------

describe("MembershipsService.revoke()", () => {
  let repo: FakeMembershipsRepository;

  beforeEach(() => {
    repo = new FakeMembershipsRepository();
  });

  it("throws NotFoundException when memberships.revoke() returns false", async () => {
    repo.revokeResult = false;
    const svc = makeService(repo);
    await expect(svc.revoke(BASE_CTX, MEMBERSHIP_ID)).rejects.toThrow(NotFoundException);
  });

  it("resolves without error when memberships.revoke() returns true", async () => {
    repo.revokeResult = true;
    const svc = makeService(repo);
    await expect(svc.revoke(BASE_CTX, MEMBERSHIP_ID)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

describe("MembershipsService.update()", () => {
  let repo: FakeMembershipsRepository;

  beforeEach(() => {
    repo = new FakeMembershipsRepository();
  });

  // ── 404 gate ─────────────────────────────────────────────────────────────

  it("throws NotFoundException when findActive() returns null", async () => {
    repo.findActiveResult = null;
    const svc = makeService(repo);
    await expect(
      svc.update(BASE_CTX, MEMBERSHIP_ID, { role_code: "tenant_admin" }),
    ).rejects.toThrow(NotFoundException);
  });

  // ── role validation ───────────────────────────────────────────────────────

  it("throws BadRequestException when role_code is 'platform_admin'", async () => {
    const svc = makeService(repo);
    await expect(
      svc.update(BASE_CTX, MEMBERSHIP_ID, { role_code: "platform_admin" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when role_code is unknown (findRoleId → null)", async () => {
    repo.findRoleIdResult = null;
    const svc = makeService(repo);
    await expect(
      svc.update(BASE_CTX, MEMBERSHIP_ID, { role_code: "ghost_role" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("BadRequestException for platform_admin contains a descriptive message", async () => {
    const svc = makeService(repo);
    let caught: BadRequestException | undefined;
    try {
      await svc.update(BASE_CTX, MEMBERSHIP_ID, { role_code: "platform_admin" });
    } catch (e) {
      caught = e as BadRequestException;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught?.message).toMatch(/platform.admin/i);
  });

  // ── store_ids without explicit kind change ────────────────────────────────

  it("throws BadRequestException when store_ids provided without store_access_kind while existing kind is 'all'", async () => {
    repo.findActiveResult = { ...repo.findActiveResult!, storeAccessKind: "all" };
    const svc = makeService(repo);
    await expect(
      svc.update(BASE_CTX, MEMBERSHIP_ID, { store_ids: [STORE_ID_A] }),
    ).rejects.toThrow(BadRequestException);
  });

  // ── invalid store_ids ─────────────────────────────────────────────────────

  it("throws BadRequestException when findInvalidStoreIds returns non-empty list", async () => {
    repo.findInvalidStoreIdsResult = [STORE_ID_A];
    const svc = makeService(repo);
    await expect(
      svc.update(BASE_CTX, MEMBERSHIP_ID, {
        store_access_kind: "specific",
        store_ids: [STORE_ID_A],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("BadRequestException for invalid store_ids includes the invalid ID", async () => {
    repo.findInvalidStoreIdsResult = [STORE_ID_A];
    const svc = makeService(repo);
    let caught: BadRequestException | undefined;
    try {
      await svc.update(BASE_CTX, MEMBERSHIP_ID, {
        store_access_kind: "specific",
        store_ids: [STORE_ID_A],
      });
    } catch (e) {
      caught = e as BadRequestException;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught?.message).toContain(STORE_ID_A);
  });

  // ── duplicate store_ids ───────────────────────────────────────────────────

  it("throws BadRequestException when store_ids contains duplicates", async () => {
    // findInvalidStoreIds returns [] (both IDs are valid), but duplicates are present
    repo.findInvalidStoreIdsResult = [];
    const svc = makeService(repo);
    await expect(
      svc.update(BASE_CTX, MEMBERSHIP_ID, {
        store_access_kind: "specific",
        store_ids: [STORE_ID_A, STORE_ID_A],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // ── happy paths ───────────────────────────────────────────────────────────

  it("happy path: role update only — resolves with MembershipDetail from repository", async () => {
    const expected: MembershipDetail = { ...repo.updateResult, roleCode: "store_manager" };
    repo.updateResult = expected;
    const svc = makeService(repo);
    const result = await svc.update(BASE_CTX, MEMBERSHIP_ID, { role_code: "store_manager" });
    expect(result).toBe(expected);
    expect(repo.updateCallParams?.roleId).toBe(ROLE_ID);
    expect(repo.updateCallParams?.storeAccessKind).toBeUndefined();
  });

  it("happy path: store_access_kind='all' update — resolves and passes kind to repository", async () => {
    const expected: MembershipDetail = { ...repo.updateResult, storeAccessKind: "all" };
    repo.updateResult = expected;
    repo.findActiveResult = { ...repo.findActiveResult!, storeAccessKind: "specific" };
    const svc = makeService(repo);
    const result = await svc.update(BASE_CTX, MEMBERSHIP_ID, { store_access_kind: "all" });
    expect(result).toBe(expected);
    expect(repo.updateCallParams?.storeAccessKind).toBe("all");
    expect(repo.updateCallParams?.roleId).toBeUndefined();
  });

  it("happy path: store_ids only when existing kind is 'specific' — resolves and passes ids to repository", async () => {
    repo.findActiveResult = { ...repo.findActiveResult!, storeAccessKind: "specific" };
    const expected: MembershipDetail = {
      ...repo.updateResult,
      storeAccessKind: "specific",
      accessibleStoreIds: [STORE_ID_B],
    };
    repo.updateResult = expected;
    const svc = makeService(repo);
    const result = await svc.update(BASE_CTX, MEMBERSHIP_ID, { store_ids: [STORE_ID_B] });
    expect(result).toBe(expected);
    expect(repo.updateCallParams?.storeIds).toEqual([STORE_ID_B]);
  });

  it("happy path: store_access_kind='specific' with valid store_ids — passes deduplicated ids through", async () => {
    repo.findInvalidStoreIdsResult = [];
    const svc = makeService(repo);
    await svc.update(BASE_CTX, MEMBERSHIP_ID, {
      store_access_kind: "specific",
      store_ids: [STORE_ID_A, STORE_ID_B],
    });
    // Both distinct IDs passed; no duplicate error thrown
    expect(repo.updateCallParams?.storeIds).toEqual([STORE_ID_A, STORE_ID_B]);
  });
});
