/**
 * T134 — StoresService unit spec.
 *
 * Pure-unit coverage for the orchestration / data-policy logic — no
 * Postgres, no Testcontainers. Cross-tenant isolation, RLS, and code-
 * uniqueness are exercised end-to-end in the companion
 * `stores.controller.spec.ts` Testcontainers integration spec.
 *
 * Authorization (role gating for POST/PATCH/DELETE) is owned by
 * `RolesGuard` and covered in `roles.guard.spec.ts`. The tests below
 * pin only what `StoresService` itself decides:
 *
 *   - list  → proxies through `runWithTenantContext`
 *   - create → 23505 on `stores_tenant_code_uidx` → ConflictException;
 *              non-conflict errors re-raised verbatim
 *   - read  → membership store-access policy for kind='specific';
 *              null repo → 404; platform admin / kind='all' / token
 *              skip the access check
 *   - update → null repo → 404 (race with concurrent delete)
 *   - softDelete → existsInTenant → 404 if invisible; otherwise repo
 *                  softDelete called
 *
 * Style: hand-rolled `*Like` fakes, mirroring the established repo
 * idiom from `tenants.service.spec.ts`.
 */
import {
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { TenantContext } from "@data-pulse-2/db";
import type { MembershipRepository } from "../../src/context/membership.repository";
import type {
  ResolvedContext,
} from "../../src/context/types";
import type {
  StoreRecord,
  StoresRepository,
} from "../../src/stores/stores.repository";
import { StoresService } from "../../src/stores/stores.service";

/**
 * Passthrough runner — fabricates a fake `PoolClient` and invokes the
 * work fn. The repository fakes ignore the client, so the orchestration
 * logic is exercised without a real Postgres pool.
 */
const passthroughTx = jest.fn(
  async <T>(
    _pool: Pool,
    _ctx: TenantContext,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> => work({} as PoolClient),
);

// --- IDs --------------------------------------------------------------

const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000000b2";
const STORE_ID = "0a000000-0000-7000-8000-0000000000c3";
const MEMBERSHIP_ID = "0a000000-0000-7000-8000-0000000000d4";

// --- Fakes ------------------------------------------------------------

class FakeStoresRepository {
  listInTenantResult: StoreRecord[] = [];
  findByIdResult: StoreRecord | null = null;
  createResult: StoreRecord | null = null;
  updateResult: StoreRecord | null = null;
  softDeleteResult = true;
  existsInTenantResult = true;

  listInTenantCalls = 0;
  findByIdCalls: Array<{ storeId: string }> = [];
  createCalls: Array<{
    id: string;
    tenantId: string;
    code: string;
    name: string;
  }> = [];
  updateCalls: Array<{
    storeId: string;
    next: { name?: string; isActive?: boolean };
  }> = [];
  softDeleteCalls: Array<{ storeId: string }> = [];
  existsInTenantCalls: Array<{ storeId: string }> = [];

  async listInTenant(_client: PoolClient): Promise<StoreRecord[]> {
    this.listInTenantCalls += 1;
    return this.listInTenantResult;
  }
  async findById(
    _client: PoolClient,
    storeId: string,
  ): Promise<StoreRecord | null> {
    this.findByIdCalls.push({ storeId });
    return this.findByIdResult;
  }
  async create(
    _client: PoolClient,
    input: {
      id: string;
      tenantId: string;
      code: string;
      name: string;
    },
  ): Promise<StoreRecord> {
    this.createCalls.push(input);
    if (!this.createResult) {
      throw new Error("FakeStoresRepository.create: createResult not set");
    }
    return this.createResult;
  }
  async update(
    _client: PoolClient,
    storeId: string,
    next: { name?: string; isActive?: boolean },
  ): Promise<StoreRecord | null> {
    this.updateCalls.push({ storeId, next });
    return this.updateResult;
  }
  async softDelete(
    _client: PoolClient,
    storeId: string,
  ): Promise<boolean> {
    this.softDeleteCalls.push({ storeId });
    return this.softDeleteResult;
  }
  async existsInTenant(
    _client: PoolClient,
    storeId: string,
  ): Promise<boolean> {
    this.existsInTenantCalls.push({ storeId });
    return this.existsInTenantResult;
  }
}

class FakeMembershipRepository {
  membership: { membershipId: string; storeAccessKind: "all" | "specific" } | null =
    null;
  canAccess = true;
  findActiveMembershipCalls: Array<{ userId: string; tenantId: string }> = [];
  canAccessStoreCalls: Array<{
    membershipId: string;
    tenantId: string;
    storeId: string;
    kind: "all" | "specific";
  }> = [];

  async findActiveMembership(
    userId: string,
    tenantId: string,
  ): Promise<
    | { membershipId: string; storeAccessKind: "all" | "specific" }
    | null
  > {
    this.findActiveMembershipCalls.push({ userId, tenantId });
    return this.membership;
  }
  async canAccessStore(
    membershipId: string,
    tenantId: string,
    storeId: string,
    kind: "all" | "specific",
  ): Promise<boolean> {
    this.canAccessStoreCalls.push({ membershipId, tenantId, storeId, kind });
    return this.canAccess;
  }
}

// --- Helpers ----------------------------------------------------------

function store(overrides: Partial<StoreRecord> = {}): StoreRecord {
  return {
    id: STORE_ID,
    tenantId: TENANT_ID,
    code: "BR-01",
    name: "Branch 01",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

const SESSION_CTX: ResolvedContext = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
};

const ADMIN_SESSION_CTX: ResolvedContext = {
  ...SESSION_CTX,
  isPlatformAdmin: true,
};

const TOKEN_CTX: ResolvedContext = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  storeId: null,
  isPlatformAdmin: false,
  source: "token",
};

// --- Wiring -----------------------------------------------------------

let repo: FakeStoresRepository;
let memberships: FakeMembershipRepository;
let service: StoresService;
const fakePool = {} as Pool;

beforeEach(() => {
  passthroughTx.mockClear();
  repo = new FakeStoresRepository();
  memberships = new FakeMembershipRepository();
  service = new StoresService(
    fakePool,
    repo as unknown as StoresRepository,
    memberships as unknown as MembershipRepository,
    passthroughTx,
  );
});

// --- list -------------------------------------------------------------

describe("StoresService.list", () => {
  it("proxies repo.listInTenant inside runWithTenantContext", async () => {
    repo.listInTenantResult = [store(), store({ id: "x" })];
    const out = await service.list(SESSION_CTX);
    expect(out).toHaveLength(2);
    expect(repo.listInTenantCalls).toBe(1);
    expect(passthroughTx).toHaveBeenCalledTimes(1);
    const [, ctx] = passthroughTx.mock.calls[0]!;
    expect(ctx).toEqual({
      tenantId: TENANT_ID,
      isPlatformAdmin: false,
    });
  });

  it("RT-142: a platform admin still runs as the selected tenant (no RLS admin branch)", async () => {
    repo.listInTenantResult = [];
    await service.list(ADMIN_SESSION_CTX);
    const [, ctx] = passthroughTx.mock.calls[0]!;
    expect(ctx).toEqual({ tenantId: ADMIN_SESSION_CTX.tenantId, isPlatformAdmin: false });
  });
});

// --- create -----------------------------------------------------------

describe("StoresService.create", () => {
  it("inserts with a freshly-minted id and the active tenant id", async () => {
    repo.createResult = store({ code: "BR-NEW", name: "New" });
    const out = await service.create(SESSION_CTX, {
      code: "BR-NEW",
      name: "New",
    });
    expect(out.code).toBe("BR-NEW");
    expect(repo.createCalls).toHaveLength(1);
    const call = repo.createCalls[0]!;
    expect(call.tenantId).toBe(TENANT_ID);
    expect(call.code).toBe("BR-NEW");
    expect(call.name).toBe("New");
    // id should be a UUID-ish minted by the service, not user-supplied.
    expect(typeof call.id).toBe("string");
    expect(call.id.length).toBeGreaterThan(0);
  });

  it("maps a 23505 on stores_tenant_code_uidx to ConflictException (409)", async () => {
    repo.create = async () => {
      const err = new Error(
        'duplicate key value violates unique constraint "stores_tenant_code_uidx"',
      ) as Error & { code: string; constraint: string };
      err.code = "23505";
      err.constraint = "stores_tenant_code_uidx";
      throw err;
    };
    await expect(
      service.create(SESSION_CTX, { code: "BR-01", name: "Dup" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("re-raises non-conflict errors verbatim", async () => {
    repo.create = async () => {
      throw new Error("transport blew up");
    };
    await expect(
      service.create(SESSION_CTX, { code: "BR-01", name: "X" }),
    ).rejects.toThrow("transport blew up");
  });

  it("throws 404 defensively when ctx.tenantId is null (TenantContextGuard misfire)", async () => {
    const noTenantCtx: ResolvedContext = { ...SESSION_CTX, tenantId: null };
    await expect(
      service.create(noTenantCtx, { code: "BR-NULL", name: "X" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.createCalls).toHaveLength(0);
  });
});

// --- read -------------------------------------------------------------

describe("StoresService.read", () => {
  it("session + kind='all' member: skips canAccessStore, returns row", async () => {
    memberships.membership = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    repo.findByIdResult = store();
    const out = await service.read(SESSION_CTX, STORE_ID);
    expect(out.id).toBe(STORE_ID);
    expect(memberships.findActiveMembershipCalls).toEqual([
      { userId: USER_ID, tenantId: TENANT_ID },
    ]);
    expect(memberships.canAccessStoreCalls).toEqual([
      {
        membershipId: MEMBERSHIP_ID,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        kind: "all",
      },
    ]);
    expect(repo.findByIdCalls).toEqual([{ storeId: STORE_ID }]);
  });

  it("session + kind='specific' member with access: returns row", async () => {
    memberships.membership = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "specific",
    };
    memberships.canAccess = true;
    repo.findByIdResult = store();
    const out = await service.read(SESSION_CTX, STORE_ID);
    expect(out.id).toBe(STORE_ID);
    expect(memberships.canAccessStoreCalls[0]?.kind).toBe("specific");
  });

  it("session + kind='specific' member without access: 404 (no findById call)", async () => {
    memberships.membership = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "specific",
    };
    memberships.canAccess = false;
    await expect(
      service.read(SESSION_CTX, STORE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.findByIdCalls).toHaveLength(0);
  });

  it("session with no active membership: 404 (defensive — guard should have rejected)", async () => {
    memberships.membership = null;
    await expect(
      service.read(SESSION_CTX, STORE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.findByIdCalls).toHaveLength(0);
  });

  it("platform admin session: skips membership lookup entirely", async () => {
    repo.findByIdResult = store();
    const out = await service.read(ADMIN_SESSION_CTX, STORE_ID);
    expect(out.id).toBe(STORE_ID);
    expect(memberships.findActiveMembershipCalls).toEqual([]);
    expect(memberships.canAccessStoreCalls).toEqual([]);
  });

  it("token principal: skips membership lookup, relies on RLS", async () => {
    repo.findByIdResult = store();
    const out = await service.read(TOKEN_CTX, STORE_ID);
    expect(out.id).toBe(STORE_ID);
    expect(memberships.findActiveMembershipCalls).toEqual([]);
  });

  it("repo returns null (cross-tenant under RLS or never-existed): 404", async () => {
    memberships.membership = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    repo.findByIdResult = null;
    await expect(
      service.read(SESSION_CTX, STORE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 defensively when ctx.tenantId is null", async () => {
    const noTenantCtx: ResolvedContext = { ...SESSION_CTX, tenantId: null };
    await expect(
      service.read(noTenantCtx, STORE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// --- update -----------------------------------------------------------

describe("StoresService.update", () => {
  it("happy path: returns updated row", async () => {
    repo.updateResult = store({ name: "Renamed" });
    const out = await service.update(SESSION_CTX, STORE_ID, {
      name: "Renamed",
    });
    expect(out.name).toBe("Renamed");
    expect(repo.updateCalls).toEqual([
      { storeId: STORE_ID, next: { name: "Renamed", isActive: undefined } },
    ]);
  });

  it("translates is_active (snake) to isActive (camel) for the repo", async () => {
    repo.updateResult = store({ isActive: false });
    await service.update(SESSION_CTX, STORE_ID, { is_active: false });
    expect(repo.updateCalls[0]?.next).toEqual({
      name: undefined,
      isActive: false,
    });
  });

  it("repo returns null (cross-tenant or concurrent delete): 404", async () => {
    repo.updateResult = null;
    await expect(
      service.update(SESSION_CTX, STORE_ID, { name: "X" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// --- softDelete -------------------------------------------------------

describe("StoresService.softDelete", () => {
  it("happy path: probes existence then calls repo.softDelete", async () => {
    repo.existsInTenantResult = true;
    await expect(
      service.softDelete(SESSION_CTX, STORE_ID),
    ).resolves.toBeUndefined();
    expect(repo.existsInTenantCalls).toEqual([{ storeId: STORE_ID }]);
    expect(repo.softDeleteCalls).toEqual([{ storeId: STORE_ID }]);
  });

  it("invisible store (cross-tenant or already-deleted): 404, no softDelete", async () => {
    repo.existsInTenantResult = false;
    await expect(
      service.softDelete(SESSION_CTX, STORE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.softDeleteCalls).toHaveLength(0);
  });
});
