/**
 * context.service.unit.spec.ts
 *
 * Docker-free unit coverage for ContextService (T304-B-api coverage lift).
 *
 * Strategy: hand-written fakes for SessionRepository and MembershipRepository.
 * No real DB, no real Redis, no Testcontainers, no NestJS DI container.
 * ContextService is constructed directly with two args (no Pool); the
 * `withBootstrapCtx` method falls back to `work(undefined)` when pool is
 * absent, so faked repo methods receive `undefined` as their client arg
 * (which they already ignore).
 *
 * The Testcontainers integration spec (context.service.spec.ts) covers the
 * same paths against a real Postgres instance with RLS. This spec pins service
 * business logic in isolation.
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit mocks.
 * The fake repos resolve whatever rows are seeded regardless of tenant context.
 * RLS is a DB-layer guarantee tested only with a real Postgres instance.
 *
 * Tests:
 *   CS1   — session principal: session not found → 401 UnauthorizedException
 *   CS2   — session principal: no active tenant/store → null fields, memberships mapped
 *   CS3   — session principal: activeTenantId set → active_tenant in response
 *   CS4   — session principal: findUserSummary null → 401 UnauthorizedException
 *   CS5   — session principal: role_code null when activeTenant not in memberships list
 *   CS6   — session principal: role_code set when activeTenant matches a membership
 *   CS7   — session principal: memberships array mapped correctly (all fields)
 *   CS8   — token principal: userId+tenantId → buildResponse path
 *   CS9   — token principal: userId=null, tenantId=null → stub platform payload
 *   CS10  — token principal: userId=null, tenantId set → findTenantSummary called
 *   CS11  — token principal: userId set, tenantId=null → buildResponse with null tenantId
 *   CS12  — switchTenant: token principal → 400 BadRequestException
 *   CS13  — switchTenant: non-admin, valid membership → updateActiveContext called
 *   CS14  — switchTenant: non-admin, membership not found → 404 NotFoundException
 *   CS15  — switchTenant: platform admin, tenant exists → updateActiveContext called
 *   CS16  — switchTenant: platform admin, tenant not found → 404 NotFoundException
 *   CS17  — switchTenant: updateActiveContext returns null → 401 UnauthorizedException
 *   CS18  — switchTenant: auto-clears active store (activeStoreId: null in update call)
 *   CS19  — switchStore: token principal → 400 BadRequestException
 *   CS20  — switchStore: session not found → 401 UnauthorizedException
 *   CS21  — switchStore: no active tenant → 409 ConflictException
 *   CS22  — switchStore: non-admin, membership not found → 404 NotFoundException
 *   CS23  — switchStore: non-admin, membership found, canAccessStore false → 404
 *   CS24  — switchStore: non-admin, membership found, canAccessStore true → success
 *   CS25  — switchStore: platform admin, canAccessStore true → success with NIL membershipId
 *   CS26  — switchStore: platform admin, canAccessStore false → 404 NotFoundException
 *   CS27  — switchStore: updateActiveContext returns null → 401 UnauthorizedException
 *   CS28  — clearStore: token principal → 400 BadRequestException
 *   CS29  — clearStore: session not found → 401 UnauthorizedException
 *   CS30  — clearStore: success, activeStoreId set to null
 *   CS31  — clearStore: idempotent when activeStoreId already null
 *   CS32  — clearStore: updateActiveContext returns null → 401 UnauthorizedException
 */
import "reflect-metadata";

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

// ---------------------------------------------------------------------------
// Fixed UUIDs
// ---------------------------------------------------------------------------

const USER_ID        = "0c000000-0000-7000-8000-000000000001";
const SESSION_ID     = "0c000000-0000-7000-8000-000000000002";
const TENANT_ID      = "0c000000-0000-7000-8000-000000000003";
const TENANT_ID_B    = "0c000000-0000-7000-8000-000000000004";
const STORE_ID       = "0c000000-0000-7000-8000-000000000005";
const TOKEN_ID       = "0c000000-0000-7000-8000-000000000006";
const MEMBERSHIP_ID  = "0c000000-0000-7000-8000-000000000007";
const NIL_UUID       = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Fake SessionRepository
// ---------------------------------------------------------------------------

class FakeSessionRepository {
  rows: SessionRow[] = [];
  updates: Array<{
    id: string;
    activeTenantId: string | null;
    activeStoreId: string | null;
  }> = [];
  /** When true, updateActiveContext returns null (revoked/missing session). */
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

// ---------------------------------------------------------------------------
// Fake MembershipRepository
// ---------------------------------------------------------------------------

class FakeMembershipRepository {
  isPlatformAdminResult = false;
  membershipResult: { membershipId: string; storeAccessKind: StoreAccessKind } | null = null;
  canAccessStoreResult = true;
  listForUserResult: readonly MembershipSummary[] = [];
  tenantSummaryById = new Map<string, TenantSummary>();
  storeSummaryById  = new Map<string, StoreSummary>();
  userSummary: {
    id: string;
    email: string;
    displayName: string | null;
    isPlatformAdmin: boolean;
  } | null = null;

  // Call trackers
  isPlatformAdminCalls: string[] = [];
  findActiveMembershipCalls: Array<{ userId: string; tenantId: string }> = [];
  canAccessStoreCalls: Array<{
    membershipId: string;
    tenantId: string;
    storeId: string;
    kind: StoreAccessKind;
  }> = [];
  findTenantSummaryCalls: string[] = [];
  findStoreSummaryCalls: string[] = [];
  findUserSummaryCalls: string[] = [];
  listForUserCalls: string[] = [];

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

  async listForUser(userId: string): Promise<readonly MembershipSummary[]> {
    this.listForUserCalls.push(userId);
    return this.listForUserResult;
  }

  async findTenantSummary(tenantId: string): Promise<TenantSummary | null> {
    this.findTenantSummaryCalls.push(tenantId);
    return this.tenantSummaryById.get(tenantId) ?? null;
  }

  async findStoreSummary(storeId: string, _tenantId: string): Promise<StoreSummary | null> {
    this.findStoreSummaryCalls.push(storeId);
    return this.storeSummaryById.get(storeId) ?? null;
  }

  async findUserSummary(userId: string): Promise<{
    id: string;
    email: string;
    displayName: string | null;
    isPlatformAdmin: boolean;
  } | null> {
    this.findUserSummaryCalls.push(userId);
    return this.userSummary;
  }
}

// ---------------------------------------------------------------------------
// Principal / session-row builders
// ---------------------------------------------------------------------------

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

/** Platform-scoped token — no user, no tenant. */
const PLATFORM_TOKEN_NO_USER_NO_TENANT: Principal = {
  kind: "token",
  tokenId: TOKEN_ID,
  tenantId: null,
  userId: null,
  storeId: null,
  scope: "dashboard_api",
};

/** Platform-scoped token — no user but HAS a tenantId. */
const PLATFORM_TOKEN_NO_USER_WITH_TENANT: Principal = {
  kind: "token",
  tokenId: TOKEN_ID,
  tenantId: TENANT_ID,
  userId: null,
  storeId: null,
  scope: "dashboard_api",
};

/** Token with userId set but tenantId is null. */
const TOKEN_WITH_USER_NO_TENANT: Principal = {
  kind: "token",
  tokenId: TOKEN_ID,
  tenantId: null,
  userId: USER_ID,
  storeId: null,
  scope: "dashboard_api",
};

// ---------------------------------------------------------------------------
// Service wiring
// ---------------------------------------------------------------------------

let sessions: FakeSessionRepository;
let memberships: FakeMembershipRepository;
let service: ContextService;

beforeEach(() => {
  sessions = new FakeSessionRepository();
  memberships = new FakeMembershipRepository();
  // No pool arg → withBootstrapCtx falls back to work(undefined)
  service = new ContextService(
    sessions as unknown as SessionRepository,
    memberships as unknown as MembershipRepository,
  );

  // Happy-path defaults
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
  memberships.tenantSummaryById.set(TENANT_ID_B, {
    id: TENANT_ID_B,
    slug: "globex",
    name: "Globex",
  });
  memberships.storeSummaryById.set(STORE_ID, {
    id: STORE_ID,
    code: "S01",
    name: "Main",
  });
});

// ===========================================================================
// CS1 — session not found → 401 UnauthorizedException
// ===========================================================================

describe("CS1 — getActiveContext (session): session not found", () => {
  it("throws UnauthorizedException when findActiveById returns null", async () => {
    // sessions.rows is empty
    await expect(
      service.getActiveContext(SESSION_PRINCIPAL),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ===========================================================================
// CS2 — session found, no active tenant/store → null fields, memberships populated
// ===========================================================================

describe("CS2 — getActiveContext (session): session found, no active tenant/store", () => {
  it("returns null active_tenant, null active_store, null role_code, user and memberships present", async () => {
    sessions.rows.push(activeSession({ activeTenantId: null, activeStoreId: null }));
    const out = await service.getActiveContext(SESSION_PRINCIPAL);
    expect(out.active_tenant).toBeNull();
    expect(out.active_store).toBeNull();
    expect(out.active_role_code).toBeNull();
    expect(out.user.id).toBe(USER_ID);
    expect(out.memberships).toHaveLength(1);
  });
});

// ===========================================================================
// CS3 — session found, activeTenantId set → buildResponse called with correct tenantId
// ===========================================================================

describe("CS3 — getActiveContext (session): activeTenantId set", () => {
  it("resolves active_tenant from tenantSummaryById using the session's activeTenantId", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: STORE_ID }),
    );
    const out = await service.getActiveContext(SESSION_PRINCIPAL);
    expect(out.active_tenant).toEqual({ id: TENANT_ID, slug: "acme", name: "Acme" });
    expect(out.active_store).toEqual({ id: STORE_ID, code: "S01", name: "Main" });
  });
});

// ===========================================================================
// CS4 — user not found in findUserSummary → 401
// ===========================================================================

describe("CS4 — getActiveContext (session): findUserSummary returns null", () => {
  it("throws UnauthorizedException when the user has been deleted between guard and service", async () => {
    sessions.rows.push(activeSession());
    memberships.userSummary = null;
    await expect(
      service.getActiveContext(SESSION_PRINCIPAL),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ===========================================================================
// CS5 — role_code null when activeTenant not in memberships list
// ===========================================================================

describe("CS5 — getActiveContext (session): role_code null when activeTenant absent from memberships", () => {
  it("sets active_role_code to null when no membership matches the activeTenantId", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID_B }));
    // listForUserResult only has TENANT_ID, not TENANT_ID_B
    const out = await service.getActiveContext(SESSION_PRINCIPAL);
    expect(out.active_role_code).toBeNull();
  });
});

// ===========================================================================
// CS6 — role_code set when activeTenant matches a membership entry
// ===========================================================================

describe("CS6 — getActiveContext (session): role_code resolved from matching membership", () => {
  it("returns the roleCode of the membership that matches activeTenantId", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    const out = await service.getActiveContext(SESSION_PRINCIPAL);
    expect(out.active_role_code).toBe("tenant_admin");
  });
});

// ===========================================================================
// CS7 — memberships array mapped correctly (all fields)
// ===========================================================================

describe("CS7 — getActiveContext (session): memberships array fields mapped verbatim", () => {
  it("maps tenant_id, tenant_name, role_code, store_access_kind, accessible_store_ids for each membership", async () => {
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
        tenantId: TENANT_ID_B,
        tenantName: "Globex",
        roleCode: "store_staff",
        storeAccessKind: "specific",
        accessibleStoreIds: [STORE_ID],
      },
    ];
    const out = await service.getActiveContext(SESSION_PRINCIPAL);
    expect(out.memberships).toHaveLength(2);
    const second = out.memberships[1]!;
    expect(second.tenant_id).toBe(TENANT_ID_B);
    expect(second.tenant_name).toBe("Globex");
    expect(second.role_code).toBe("store_staff");
    expect(second.store_access_kind).toBe("specific");
    expect(second.accessible_store_ids).toEqual([STORE_ID]);
  });
});

// ===========================================================================
// CS8 — token with userId+tenantId → buildResponse path
// ===========================================================================

describe("CS8 — getActiveContext (token): userId + tenantId set", () => {
  it("goes through buildResponse and returns user + active_tenant, active_store is null", async () => {
    const out = await service.getActiveContext(TOKEN_PRINCIPAL);
    expect(out.user.id).toBe(USER_ID);
    expect(out.active_tenant?.id).toBe(TENANT_ID);
    expect(out.active_store).toBeNull();
  });
});

// ===========================================================================
// CS9 — token with userId=null, tenantId=null → stub platform payload returned
// ===========================================================================

describe("CS9 — getActiveContext (token): userId=null, tenantId=null", () => {
  it("returns stub platform payload with is_platform_admin=true, empty user id/email", async () => {
    const out = await service.getActiveContext(PLATFORM_TOKEN_NO_USER_NO_TENANT);
    expect(out.user.id).toBe("");
    expect(out.user.email).toBe("");
    expect(out.user.is_platform_admin).toBe(true);
    expect(out.active_tenant).toBeNull();
    expect(out.active_store).toBeNull();
    expect(out.memberships).toHaveLength(0);
  });
});

// ===========================================================================
// CS10 — token with userId=null, tenantId set → findTenantSummary called
// ===========================================================================

describe("CS10 — getActiveContext (token): userId=null, tenantId set", () => {
  it("calls findTenantSummary and includes active_tenant in the stub platform payload", async () => {
    const out = await service.getActiveContext(PLATFORM_TOKEN_NO_USER_WITH_TENANT);
    expect(out.active_tenant).toEqual({ id: TENANT_ID, slug: "acme", name: "Acme" });
    expect(out.user.is_platform_admin).toBe(true);
    expect(memberships.findTenantSummaryCalls).toContain(TENANT_ID);
  });
});

// ===========================================================================
// CS11 — token with userId set, tenantId=null → buildResponse with null tenantId
// ===========================================================================

describe("CS11 — getActiveContext (token): userId set, tenantId=null", () => {
  it("calls buildResponse with null tenantId; active_tenant is null, findTenantSummary NOT called", async () => {
    const out = await service.getActiveContext(TOKEN_WITH_USER_NO_TENANT);
    expect(out.user.id).toBe(USER_ID);
    expect(out.active_tenant).toBeNull();
    expect(out.active_store).toBeNull();
    // findTenantSummary must not be called for the activeTenantId slot since it is null
    expect(memberships.findTenantSummaryCalls).toHaveLength(0);
  });
});

// ===========================================================================
// CS12 — switchTenant: token principal → BadRequestException
// ===========================================================================

describe("CS12 — switchTenant: token principal", () => {
  it("throws BadRequestException with a message mentioning token", async () => {
    await expect(
      service.switchTenant(TOKEN_PRINCIPAL, TENANT_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.updates).toHaveLength(0);
  });
});

// ===========================================================================
// CS13 — switchTenant: non-admin, valid membership → updateActiveContext called, returns body
// ===========================================================================

describe("CS13 — switchTenant: non-admin, valid membership", () => {
  it("calls updateActiveContext and returns a ContextResponseBody", async () => {
    sessions.rows.push(activeSession({ activeTenantId: null }));
    memberships.membershipResult = { membershipId: MEMBERSHIP_ID, storeAccessKind: "all" };
    const out = await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID);
    expect(sessions.updates).toHaveLength(1);
    expect(sessions.updates[0]!.activeTenantId).toBe(TENANT_ID);
    expect(out.user.id).toBe(USER_ID);
  });
});

// ===========================================================================
// CS14 — switchTenant: non-admin, membership not found → NotFoundException
// ===========================================================================

describe("CS14 — switchTenant: non-admin, membership not found", () => {
  it("throws NotFoundException (FR-ISO-4) when findActiveMembership returns null", async () => {
    sessions.rows.push(activeSession({ activeTenantId: null }));
    memberships.membershipResult = null;
    await expect(
      service.switchTenant(SESSION_PRINCIPAL, TENANT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(sessions.updates).toHaveLength(0);
  });
});

// ===========================================================================
// CS15 — switchTenant: platform admin, tenant exists → updateActiveContext called
// ===========================================================================

describe("CS15 — switchTenant: platform admin, tenant exists", () => {
  it("bypasses membership check and calls updateActiveContext (FR-TEN-6)", async () => {
    sessions.rows.push(activeSession({ activeTenantId: null }));
    memberships.isPlatformAdminResult = true;
    memberships.membershipResult = null; // would fail non-admin path
    await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID);
    expect(sessions.updates).toHaveLength(1);
    expect(memberships.findActiveMembershipCalls).toHaveLength(0);
    expect(memberships.findTenantSummaryCalls).toContain(TENANT_ID);
  });
});

// ===========================================================================
// CS16 — switchTenant: platform admin, tenant not found → NotFoundException
// ===========================================================================

describe("CS16 — switchTenant: platform admin, tenant not found", () => {
  it("throws NotFoundException when findTenantSummary returns null for admin", async () => {
    sessions.rows.push(activeSession({ activeTenantId: null }));
    memberships.isPlatformAdminResult = true;
    memberships.tenantSummaryById.delete(TENANT_ID);
    await expect(
      service.switchTenant(SESSION_PRINCIPAL, TENANT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(sessions.updates).toHaveLength(0);
  });
});

// ===========================================================================
// CS17 — switchTenant: updateActiveContext returns null → UnauthorizedException
// ===========================================================================

describe("CS17 — switchTenant: updateActiveContext returns null", () => {
  it("throws UnauthorizedException on TOCTOU session revocation", async () => {
    sessions.rows.push(activeSession({ activeTenantId: null }));
    memberships.membershipResult = { membershipId: MEMBERSHIP_ID, storeAccessKind: "all" };
    sessions.updateReturnsNull = true;
    await expect(
      service.switchTenant(SESSION_PRINCIPAL, TENANT_ID),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ===========================================================================
// CS18 — switchTenant: auto-clears active store (activeStoreId: null in update call)
// ===========================================================================

describe("CS18 — switchTenant: auto-clears active store", () => {
  it("passes activeStoreId: null to updateActiveContext regardless of prior store", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: STORE_ID }),
    );
    memberships.membershipResult = { membershipId: MEMBERSHIP_ID, storeAccessKind: "all" };
    await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID_B);
    expect(sessions.updates[0]!.activeStoreId).toBeNull();
    expect(sessions.updates[0]!.activeTenantId).toBe(TENANT_ID_B);
  });
});

// ===========================================================================
// CS19 — switchStore: token principal → BadRequestException
// ===========================================================================

describe("CS19 — switchStore: token principal", () => {
  it("throws BadRequestException — token context is fixed at issuance", async () => {
    await expect(
      service.switchStore(TOKEN_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.updates).toHaveLength(0);
  });
});

// ===========================================================================
// CS20 — switchStore: session not found → UnauthorizedException
// ===========================================================================

describe("CS20 — switchStore: session not found", () => {
  it("throws UnauthorizedException when findActiveById returns null", async () => {
    // sessions.rows is empty
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ===========================================================================
// CS21 — switchStore: no active tenant → ConflictException
// ===========================================================================

describe("CS21 — switchStore: no active tenant", () => {
  it("throws ConflictException (409) when session has no activeTenantId", async () => {
    sessions.rows.push(activeSession({ activeTenantId: null }));
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

// ===========================================================================
// CS22 — switchStore: non-admin, no membership → NotFoundException
// ===========================================================================

describe("CS22 — switchStore: non-admin, no membership", () => {
  it("throws NotFoundException (FR-ISO-4) when findActiveMembership returns null", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.membershipResult = null;
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ===========================================================================
// CS23 — switchStore: non-admin, membership found, canAccessStore false → NotFoundException
// ===========================================================================

describe("CS23 — switchStore: non-admin, membership found, canAccessStore=false", () => {
  it("throws NotFoundException when canAccessStore returns false", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.membershipResult = { membershipId: MEMBERSHIP_ID, storeAccessKind: "all" };
    memberships.canAccessStoreResult = false;
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(sessions.updates).toHaveLength(0);
  });
});

// ===========================================================================
// CS24 — switchStore: non-admin, membership found, canAccessStore true → success
// ===========================================================================

describe("CS24 — switchStore: non-admin, membership found, canAccessStore=true", () => {
  it("calls updateActiveContext with correct tenantId and storeId", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.membershipResult = { membershipId: MEMBERSHIP_ID, storeAccessKind: "all" };
    memberships.canAccessStoreResult = true;
    await service.switchStore(SESSION_PRINCIPAL, STORE_ID);
    expect(sessions.updates[0]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID,
      activeStoreId: STORE_ID,
    });
  });
});

// ===========================================================================
// CS25 — switchStore: platform admin, canAccessStore true → success with NIL membershipId
// ===========================================================================

describe("CS25 — switchStore: platform admin, canAccessStore=true", () => {
  it("calls canAccessStore with NIL membershipId and kind='all'; bypasses membership lookup", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.isPlatformAdminResult = true;
    memberships.canAccessStoreResult = true;
    await service.switchStore(SESSION_PRINCIPAL, STORE_ID);
    expect(memberships.findActiveMembershipCalls).toHaveLength(0);
    expect(memberships.canAccessStoreCalls[0]?.membershipId).toBe(NIL_UUID);
    expect(memberships.canAccessStoreCalls[0]?.kind).toBe("all");
    expect(sessions.updates).toHaveLength(1);
  });
});

// ===========================================================================
// CS26 — switchStore: platform admin, canAccessStore false → NotFoundException
// ===========================================================================

describe("CS26 — switchStore: platform admin, canAccessStore=false", () => {
  it("throws NotFoundException when store does not belong to active tenant for admin", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.isPlatformAdminResult = true;
    memberships.canAccessStoreResult = false;
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ===========================================================================
// CS27 — switchStore: updateActiveContext returns null → UnauthorizedException
// ===========================================================================

describe("CS27 — switchStore: updateActiveContext returns null", () => {
  it("throws UnauthorizedException on TOCTOU session revocation after store-access check", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.membershipResult = { membershipId: MEMBERSHIP_ID, storeAccessKind: "all" };
    memberships.canAccessStoreResult = true;
    sessions.updateReturnsNull = true;
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ===========================================================================
// CS28 — clearStore: token principal → BadRequestException
// ===========================================================================

describe("CS28 — clearStore: token principal", () => {
  it("throws BadRequestException — token context is fixed at issuance", async () => {
    await expect(
      service.clearStore(TOKEN_PRINCIPAL),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.updates).toHaveLength(0);
  });
});

// ===========================================================================
// CS29 — clearStore: session not found → UnauthorizedException
// ===========================================================================

describe("CS29 — clearStore: session not found", () => {
  it("throws UnauthorizedException when findActiveById returns null", async () => {
    // sessions.rows is empty
    await expect(
      service.clearStore(SESSION_PRINCIPAL),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ===========================================================================
// CS30 — clearStore: success, activeStoreId set to null
// ===========================================================================

describe("CS30 — clearStore: success — activeStoreId set to null", () => {
  it("passes activeStoreId=null to updateActiveContext while preserving activeTenantId", async () => {
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
});

// ===========================================================================
// CS31 — clearStore: idempotent when activeStoreId already null
// ===========================================================================

describe("CS31 — clearStore: idempotent when activeStoreId already null", () => {
  it("still issues updateActiveContext and returns a valid response when store is already null", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: null }),
    );
    const out = await service.clearStore(SESSION_PRINCIPAL);
    expect(sessions.updates).toHaveLength(1);
    expect(out.active_store).toBeNull();
    expect(out.active_tenant?.id).toBe(TENANT_ID);
  });
});

// ===========================================================================
// CS32 — clearStore: updateActiveContext returns null → UnauthorizedException
// ===========================================================================

describe("CS32 — clearStore: updateActiveContext returns null", () => {
  it("throws UnauthorizedException on TOCTOU session revocation in clearStore", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: STORE_ID }),
    );
    sessions.updateReturnsNull = true;
    await expect(
      service.clearStore(SESSION_PRINCIPAL),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
