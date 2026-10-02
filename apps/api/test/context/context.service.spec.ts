/**
 * T152 — ContextService spec.
 *
 * Pure unit-level. Collaborators (`SessionRepository`,
 * `MembershipRepository`) are faked at the class boundary; no
 * Postgres, no real Pool, no Testcontainers.
 *
 * Coverage matches the approved test plan, mapped to FRs:
 *   - getActiveContext: first-login state (null tenant)
 *   - getActiveContext: full payload with active tenant + store
 *   - getActiveContext: active_role_code from membership
 *   - switchTenant: valid membership → updates session, clears store
 *   - switchTenant: no active membership → 404 (FR-ISO-4)
 *   - switchTenant: platform admin without membership → success (FR-TEN-6)
 *   - switchTenant: tenant doesn't exist (platform admin) → 404
 *   - switchTenant: token principal → 400
 *   - switchStore: no active tenant → 409
 *   - switchStore: cross-tenant store → 404 (FR-ISO-4)
 *   - switchStore: kind='specific' no grant → 404
 *   - switchStore: kind='all' valid → success
 *   - switchStore: token principal → 400
 *   - clearStore: idempotent
 *   - clearStore: tenant unchanged
 *   - tenant switch auto-clears active store (T157 prereq)
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { SessionRow, StoreAccessKind } from "@data-pulse-2/db/schema";
import type { Principal } from "../../src/auth/auth.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import type {
  MembershipRepository,
  MembershipSummary,
  StoreSummary,
  TenantSummary,
} from "../../src/context/membership.repository";
import { ContextService } from "../../src/context/context.service";

// --- IDs --------------------------------------------------------------

const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const SESSION_ID = "0a000000-0000-7000-8000-0000000ses01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000ten01";
const TENANT_ID_OTHER = "0a000000-0000-7000-8000-0000000ten02";
const STORE_ID = "0a000000-0000-7000-8000-0000000sto01";
const TOKEN_ID = "0a000000-0000-7000-8000-0000000tok01";
const MEMBERSHIP_ID = "0a000000-0000-7000-8000-0000000mem01";

// --- Fakes ------------------------------------------------------------

class FakeSessionRepository {
  rows: SessionRow[] = [];
  updates: Array<{
    id: string;
    activeTenantId: string | null;
    activeStoreId: string | null;
  }> = [];
  /** When set, `updateActiveContext` returns null (revoked / missing). */
  updateReturnsNull = false;

  async findActiveById(id: string): Promise<SessionRow | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async updateActiveContext(
    id: string,
    next: { activeTenantId: string | null; activeStoreId: string | null },
  ): Promise<SessionRow | null> {
    this.updates.push({ id, ...next });
    if (this.updateReturnsNull) return null;
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    const updated: SessionRow = {
      ...this.rows[idx]!,
      activeTenantId: next.activeTenantId,
      activeStoreId: next.activeStoreId,
    };
    this.rows[idx] = updated;
    return updated;
  }
}

class FakeMembershipRepository {
  isPlatformAdminResult = false;
  membershipResult:
    | { membershipId: string; storeAccessKind: StoreAccessKind }
    | null = null;
  canAccessStoreResult = true;
  listForUserResult: readonly MembershipSummary[] = [];
  tenantSummaryById = new Map<string, TenantSummary>();
  storeSummaryById = new Map<string, StoreSummary>();
  userSummary: {
    id: string;
    email: string;
    displayName: string | null;
    isPlatformAdmin: boolean;
  } | null = null;

  isPlatformAdminCalls: string[] = [];
  findActiveMembershipCalls: Array<{ userId: string; tenantId: string }> = [];
  canAccessStoreCalls: Array<{
    membershipId: string;
    tenantId: string;
    storeId: string;
    kind: StoreAccessKind;
  }> = [];

  async isPlatformAdmin(userId: string): Promise<boolean> {
    this.isPlatformAdminCalls.push(userId);
    return this.isPlatformAdminResult;
  }
  async findActiveMembership(
    userId: string,
    tenantId: string,
  ): Promise<{ membershipId: string; storeAccessKind: StoreAccessKind } | null> {
    this.findActiveMembershipCalls.push({ userId, tenantId });
    return this.membershipResult;
  }
  async canAccessStore(
    membershipId: string,
    tenantId: string,
    storeId: string,
    kind: StoreAccessKind,
  ): Promise<boolean> {
    this.canAccessStoreCalls.push({ membershipId, tenantId, storeId, kind });
    return this.canAccessStoreResult;
  }
  async listForUser(_userId: string): Promise<readonly MembershipSummary[]> {
    return this.listForUserResult;
  }
  async findTenantSummary(tenantId: string): Promise<TenantSummary | null> {
    return this.tenantSummaryById.get(tenantId) ?? null;
  }
  async findStoreSummary(storeId: string, _tenantId: string): Promise<StoreSummary | null> {
    return this.storeSummaryById.get(storeId) ?? null;
  }
  async findUserSummary(_userId: string): Promise<
    | {
        id: string;
        email: string;
        displayName: string | null;
        isPlatformAdmin: boolean;
      }
    | null
  > {
    return this.userSummary;
  }
}

// --- Helpers ----------------------------------------------------------

function activeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    activeTenantId: null,
    activeStoreId: null,
    issuedAt: new Date(),
    lastSeenAt: new Date(),
    absoluteExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: null,
    userAgent: null,
    ipAtIssue: null,
    ...overrides,
  } as SessionRow;
}

const SESSION_PRINCIPAL: Principal = {
  kind: "session",
  sessionId: SESSION_ID,
  userId: USER_ID,
};

const TOKEN_PRINCIPAL: Principal = {
  kind: "token",
  tokenId: TOKEN_ID,
  tenantId: TENANT_ID,
  userId: USER_ID,
  storeId: null,
  scope: "dashboard_api",
};

const PLATFORM_TOKEN: Principal = {
  kind: "token",
  tokenId: TOKEN_ID,
  tenantId: null,
  userId: null,
  storeId: null,
  scope: "dashboard_api",
};

// --- Wiring -----------------------------------------------------------

let sessions: FakeSessionRepository;
let memberships: FakeMembershipRepository;
let service: ContextService;

beforeEach(() => {
  sessions = new FakeSessionRepository();
  memberships = new FakeMembershipRepository();
  service = new ContextService(
    sessions as unknown as SessionRepository,
    memberships as unknown as MembershipRepository,
  );

  // Sensible defaults: a happy-path user with one membership.
  memberships.userSummary = {
    id: USER_ID,
    email: "alice@example.com",
    displayName: "Alice",
    isPlatformAdmin: false,
  };
  memberships.listForUserResult = [
    {
      tenantId: TENANT_ID,
      tenantName: "Acme",
      roleCode: "tenant_admin",
      storeAccessKind: "all" as const,
      accessibleStoreIds: [],
    },
  ];
  memberships.tenantSummaryById.set(TENANT_ID, {
    id: TENANT_ID,
    slug: "acme",
    name: "Acme",
  });
  memberships.tenantSummaryById.set(TENANT_ID_OTHER, {
    id: TENANT_ID_OTHER,
    slug: "globex",
    name: "Globex",
  });
  memberships.storeSummaryById.set(STORE_ID, {
    id: STORE_ID,
    code: "S01",
    name: "Main",
  });
});

// --- getActiveContext -------------------------------------------------

describe("ContextService.getActiveContext", () => {
  it("returns null active tenant/store/role for first-login state", async () => {
    sessions.rows.push(activeSession({ activeTenantId: null, activeStoreId: null }));
    const out = await service.getActiveContext(SESSION_PRINCIPAL);
    expect(out.active_tenant).toBeNull();
    expect(out.active_store).toBeNull();
    expect(out.active_role_code).toBeNull();
    expect(out.user.id).toBe(USER_ID);
    expect(out.memberships).toHaveLength(1);
  });

  it("returns the full payload when active tenant + store are set", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: STORE_ID }),
    );
    const out = await service.getActiveContext(SESSION_PRINCIPAL);
    expect(out.active_tenant).toEqual({
      id: TENANT_ID,
      slug: "acme",
      name: "Acme",
    });
    expect(out.active_store).toEqual({
      id: STORE_ID,
      code: "S01",
      name: "Main",
    });
    expect(out.active_role_code).toBe("tenant_admin");
  });

  it("includes memberships array verbatim from listForUser", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.listForUserResult = [
      {
        tenantId: TENANT_ID,
        tenantName: "Acme",
        roleCode: "tenant_admin",
        storeAccessKind: "all",
        accessibleStoreIds: [],
      },
      {
        tenantId: TENANT_ID_OTHER,
        tenantName: "Globex",
        roleCode: "store_staff",
        storeAccessKind: "specific",
        accessibleStoreIds: [STORE_ID],
      },
    ];
    const out = await service.getActiveContext(SESSION_PRINCIPAL);
    expect(out.memberships).toHaveLength(2);
    expect(out.memberships[1]!.role_code).toBe("store_staff");
    expect(out.memberships[1]!.accessible_store_ids).toEqual([STORE_ID]);
  });

  it("throws 401 when the session is missing or revoked (TOCTOU)", async () => {
    // sessions.rows is empty
    await expect(
      service.getActiveContext(SESSION_PRINCIPAL),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("supports token principal with tenantId set", async () => {
    const out = await service.getActiveContext(TOKEN_PRINCIPAL);
    expect(out.user.id).toBe(USER_ID);
    expect(out.active_tenant?.id).toBe(TENANT_ID);
  });

  it("supports platform-scoped token (tenantId null, userId null)", async () => {
    const out = await service.getActiveContext(PLATFORM_TOKEN);
    expect(out.active_tenant).toBeNull();
    expect(out.user.is_platform_admin).toBe(true);
  });
});

// --- switchTenant -----------------------------------------------------

describe("ContextService.switchTenant", () => {
  beforeEach(() => {
    sessions.rows.push(activeSession({ activeTenantId: null }));
  });

  it("updates the session with the new tenant and clears active store", async () => {
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID);
    expect(sessions.updates).toHaveLength(1);
    expect(sessions.updates[0]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID,
      activeStoreId: null,
    });
  });

  it("auto-clears active store on tenant switch (T157 prereq)", async () => {
    sessions.rows[0] = activeSession({
      activeTenantId: TENANT_ID,
      activeStoreId: STORE_ID,
    });
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID_OTHER);
    expect(sessions.updates[0]!.activeStoreId).toBeNull();
  });

  it("throws 404 when the user has no active membership in the requested tenant (FR-ISO-4)", async () => {
    memberships.membershipResult = null;
    await expect(
      service.switchTenant(SESSION_PRINCIPAL, TENANT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(sessions.updates).toHaveLength(0);
  });

  it("succeeds for a platform admin without a membership (FR-TEN-6)", async () => {
    memberships.isPlatformAdminResult = true;
    memberships.membershipResult = null;
    // tenantSummaryById has TENANT_ID set in beforeEach
    await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID);
    expect(sessions.updates).toHaveLength(1);
    expect(memberships.findActiveMembershipCalls).toHaveLength(0);
  });

  it("throws 404 when the platform admin requests a non-existent tenant", async () => {
    memberships.isPlatformAdminResult = true;
    memberships.tenantSummaryById.delete(TENANT_ID);
    await expect(
      service.switchTenant(SESSION_PRINCIPAL, TENANT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws 400 when the principal is a token (token tenant is fixed at issuance)", async () => {
    await expect(
      service.switchTenant(TOKEN_PRINCIPAL, TENANT_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.updates).toHaveLength(0);
  });

  it("throws 401 when the session was revoked between the guard and the update", async () => {
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    sessions.updateReturnsNull = true;
    await expect(
      service.switchTenant(SESSION_PRINCIPAL, TENANT_ID),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// --- switchStore ------------------------------------------------------

describe("ContextService.switchStore", () => {
  it("throws 409 when there is no active tenant", async () => {
    sessions.rows.push(activeSession({ activeTenantId: null }));
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("kind='all' + store in tenant → updates session active store", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    memberships.canAccessStoreResult = true;
    await service.switchStore(SESSION_PRINCIPAL, STORE_ID);
    expect(sessions.updates[0]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID,
      activeStoreId: STORE_ID,
    });
  });

  it("kind='all' + cross-tenant store → 404 (FR-ISO-4)", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    memberships.canAccessStoreResult = false;
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(sessions.updates).toHaveLength(0);
  });

  it("kind='specific' + no grant → 404", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "specific",
    };
    memberships.canAccessStoreResult = false;
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("kind='specific' + grant exists → success", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "specific",
    };
    memberships.canAccessStoreResult = true;
    await service.switchStore(SESSION_PRINCIPAL, STORE_ID);
    expect(memberships.canAccessStoreCalls[0]?.kind).toBe("specific");
  });

  it("platform admin: only validates store-belongs-to-tenant via the 'all' branch", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.isPlatformAdminResult = true;
    memberships.canAccessStoreResult = true;
    await service.switchStore(SESSION_PRINCIPAL, STORE_ID);
    expect(memberships.canAccessStoreCalls[0]?.kind).toBe("all");
    expect(memberships.findActiveMembershipCalls).toHaveLength(0);
  });

  it("throws 404 when no membership in the active tenant (cross-tenant active state)", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.isPlatformAdminResult = false;
    memberships.membershipResult = null;
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws 400 when the principal is a token", async () => {
    await expect(
      service.switchStore(TOKEN_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("throws 401 when the session is missing/revoked", async () => {
    // sessions.rows empty
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// --- clearStore -------------------------------------------------------

describe("ContextService.clearStore", () => {
  it("sets activeStoreId to null while preserving activeTenantId", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: STORE_ID }),
    );
    await service.clearStore(SESSION_PRINCIPAL);
    expect(sessions.updates[0]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID,
      activeStoreId: null,
    });
  });

  it("is idempotent — clearing when already null still returns 200-shape response", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: null }),
    );
    const out = await service.clearStore(SESSION_PRINCIPAL);
    expect(out.active_store).toBeNull();
    expect(out.active_tenant?.id).toBe(TENANT_ID);
  });

  it("throws 401 when session is missing/revoked", async () => {
    await expect(
      service.clearStore(SESSION_PRINCIPAL),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 400 for token principals", async () => {
    await expect(
      service.clearStore(TOKEN_PRINCIPAL),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// --- I-4 defensive read: cross-tenant active store --------------------
//
// These tests verify that buildResponse silently renders active_store: null
// when findStoreSummary returns null (because the DB's tenant_id filter
// excluded the mismatched store). This is the read-side complement to the
// DB trigger that blocks future writes.

describe("ContextService — I-4 defensive read (active_store cross-tenant)", () => {
  const STORE_ID_WRONG_TENANT = "0a000000-0000-7000-8000-0000000sto99";

  it("renders active_store: null when the stored store ID is not found for the active tenant", async () => {
    // STORE_ID_WRONG_TENANT is NOT in storeSummaryById — simulates
    // findStoreSummary returning null because of the tenant_id filter.
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: STORE_ID_WRONG_TENANT }),
    );
    const out = await service.getActiveContext(SESSION_PRINCIPAL);
    expect(out.active_store).toBeNull();
    expect(out.active_tenant?.id).toBe(TENANT_ID);
  });

  it("skips the store lookup and renders active_store: null when active_tenant_id is null", async () => {
    // Guard: even if active_store_id is set, buildResponse must not call
    // findStoreSummary without a tenant context (would skip the tenant filter).
    sessions.rows.push(
      activeSession({ activeTenantId: null, activeStoreId: STORE_ID }),
    );
    const out = await service.getActiveContext(SESSION_PRINCIPAL);
    expect(out.active_store).toBeNull();
    expect(out.active_tenant).toBeNull();
  });
});
