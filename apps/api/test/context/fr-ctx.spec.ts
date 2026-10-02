/**
 * T156 — FR-CTX-4 / FR-CTX-6 regression spec.
 *
 * Pins the *primitives* that future store-scoped and tenant-scoped
 * controllers will rely on. The route-level "store scope required"
 * enforcement does not exist yet — it lands with the first
 * store-scoped controller. This file pins the upstream contract that
 * `TenantContextGuard` (PR #19) and `ContextService` (PR #21) deliver
 * the right discriminators.
 *
 * Coverage matches the approved test plan:
 *
 *   FR-CTX-4 (store-scoped request without active store → reject)
 *   ------------------------------------------------------------
 *     - session with no activeTenantId → guard 401
 *     - valid tenant + no active store → resolves with storeId === null
 *       (this null IS the discriminator a future store-scoped route
 *       will check)
 *
 *   FR-CTX-6 (tenant-scoped without store-scoped is allowed)
 *   --------------------------------------------------------
 *     - tenant-scoped + no store → guard succeeds
 *     - request.context.tenantId is set, storeId is null
 *     - ContextService.getActiveContext returns active_store: null
 *
 *   Cross-cutting (FR-ISO-4 adjacent)
 *   ---------------------------------
 *     - cross-tenant store on switch → 404 (no existence leak)
 *     - store switch with no active tenant → 409
 *
 * Test style: pure unit, fake repositories — same idiom as
 * `tenant-context.guard.spec.ts` and `context.service.spec.ts`.
 */
import {
  type ExecutionContext,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { SessionRow, StoreAccessKind } from "@data-pulse-2/db/schema";
import type {
  AuthedRequest,
  Principal,
} from "../../src/auth/auth.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import type {
  MembershipRepository,
  MembershipSummary,
  StoreSummary,
  TenantSummary,
} from "../../src/context/membership.repository";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import { ContextService } from "../../src/context/context.service";
import type { TenantContextRequest } from "../../src/context/types";

// --- IDs ---------------------------------------------------------------

const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const SESSION_ID = "0a000000-0000-7000-8000-0000000000a1";
const TENANT_ID = "0a000000-0000-7000-8000-0000000000b2";
const OTHER_TENANT_ID = "0a000000-0000-7000-8000-0000000000c3";
const STORE_ID = "0a000000-0000-7000-8000-0000000000d4";
const MEMBERSHIP_ID = "0a000000-0000-7000-8000-0000000000e5";

// --- Fakes (slim variants, mirror the pattern of prior specs) ---------

class FakeSessionRepository {
  rows: SessionRow[] = [];
  updates: Array<{
    id: string;
    activeTenantId: string | null;
    activeStoreId: string | null;
  }> = [];

  async findActiveById(id: string): Promise<SessionRow | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async updateActiveContext(
    id: string,
    next: { activeTenantId: string | null; activeStoreId: string | null },
  ): Promise<SessionRow | null> {
    this.updates.push({ id, ...next });
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

  async isPlatformAdmin(userId: string): Promise<boolean> {
    void userId;
    return this.isPlatformAdminResult;
  }
  async findActiveMembership(): Promise<
    { membershipId: string; storeAccessKind: StoreAccessKind } | null
  > {
    return this.membershipResult;
  }
  async canAccessStore(): Promise<boolean> {
    return this.canAccessStoreResult;
  }
  async listGrantedStoreIds(): Promise<readonly string[]> {
    return [];
  }
  async listForUser(): Promise<readonly MembershipSummary[]> {
    return this.listForUserResult;
  }
  async findTenantSummary(id: string): Promise<TenantSummary | null> {
    return this.tenantSummaryById.get(id) ?? null;
  }
  async findStoreSummary(id: string, _tenantId: string): Promise<StoreSummary | null> {
    return this.storeSummaryById.get(id) ?? null;
  }
  async findUserSummary(): Promise<typeof this.userSummary> {
    return this.userSummary;
  }
}

// --- Helpers ----------------------------------------------------------

function activeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    activeTenantId: TENANT_ID,
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

function makeRequest(principal: Principal | undefined): TenantContextRequest {
  const r: Partial<TenantContextRequest> = {};
  if (principal) r.principal = principal;
  return r as TenantContextRequest;
}

function makeExecCtx(request: AuthedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as unknown as T,
      getResponse: <T>() => ({}) as T,
      getNext: <T>() => ({}) as T,
    }),
  } as unknown as ExecutionContext;
}

const SESSION_PRINCIPAL: Principal = {
  kind: "session",
  sessionId: SESSION_ID,
  userId: USER_ID,
};

// --- Wiring -----------------------------------------------------------

let sessions: FakeSessionRepository;
let memberships: FakeMembershipRepository;
let guard: TenantContextGuard;
let service: ContextService;

beforeEach(() => {
  sessions = new FakeSessionRepository();
  memberships = new FakeMembershipRepository();
  guard = new TenantContextGuard(
    sessions as unknown as SessionRepository,
    memberships as unknown as MembershipRepository,
  );
  service = new ContextService(
    sessions as unknown as SessionRepository,
    memberships as unknown as MembershipRepository,
  );

  // A happy-path user with one membership in TENANT_ID, kind='all'.
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
  memberships.tenantSummaryById.set(OTHER_TENANT_ID, {
    id: OTHER_TENANT_ID,
    slug: "globex",
    name: "Globex",
  });
  memberships.storeSummaryById.set(STORE_ID, {
    id: STORE_ID,
    code: "S01",
    name: "Main",
  });
});

// =====================================================================
// FR-CTX-4 — store-scoped request without active store → reject
// =====================================================================

describe("FR-CTX-4 — TenantContextGuard primitive", () => {
  it("rejects with 401 when the session has no activeTenantId", async () => {
    sessions.rows.push(activeSession({ activeTenantId: null }));
    const request = makeRequest(SESSION_PRINCIPAL);
    await expect(
      guard.canActivate(makeExecCtx(request)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("publishes request.context.storeId === null when activeStoreId is null", async () => {
    // This null IS the discriminator a future store-scoped route will
    // check via an upstream `RequireActiveStore` mini-guard. Pinning
    // it here means the contract the future guard depends on is
    // covered by a regression test independent of the per-route guard.
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: null }),
    );
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };

    const request = makeRequest(SESSION_PRINCIPAL);
    await expect(guard.canActivate(makeExecCtx(request))).resolves.toBe(true);
    expect(request.context).toBeDefined();
    expect(request.context!.storeId).toBeNull();
  });
});

// =====================================================================
// FR-CTX-6 — tenant-scoped without store-scoped is allowed
// =====================================================================

describe("FR-CTX-6 — TenantContextGuard primitive", () => {
  it("allows a request with active tenant + no active store", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: null }),
    );
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    const request = makeRequest(SESSION_PRINCIPAL);
    await expect(guard.canActivate(makeExecCtx(request))).resolves.toBe(true);
  });

  it("populates request.context with tenantId set and storeId null", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: null }),
    );
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    const request = makeRequest(SESSION_PRINCIPAL);
    await guard.canActivate(makeExecCtx(request));

    expect(request.context).toEqual({
      userId: USER_ID,
      tenantId: TENANT_ID,
      storeId: null,
      isPlatformAdmin: false,
      source: "session",
      storeAccess: { kind: "all" },
    });
  });

  it("does NOT call canAccessStore when activeStoreId is null (storeless tenant scope)", async () => {
    let canAccessCalls = 0;
    memberships.canAccessStore = async () => {
      canAccessCalls += 1;
      return true;
    };
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: null }),
    );
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    await guard.canActivate(makeExecCtx(makeRequest(SESSION_PRINCIPAL)));
    expect(canAccessCalls).toBe(0);
  });
});

describe("FR-CTX-6 — ContextService.getActiveContext", () => {
  it("returns active_store: null when the session has tenant set but no store", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: null }),
    );
    const out = await service.getActiveContext(SESSION_PRINCIPAL);
    expect(out.active_tenant).not.toBeNull();
    expect(out.active_tenant?.id).toBe(TENANT_ID);
    expect(out.active_store).toBeNull();
  });

  it("returns active_role_code from the membership in the active tenant", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: TENANT_ID, activeStoreId: null }),
    );
    const out = await service.getActiveContext(SESSION_PRINCIPAL);
    expect(out.active_role_code).toBe("tenant_admin");
  });
});

// =====================================================================
// Cross-cutting: FR-ISO-4 adjacent rejections
// =====================================================================

describe("FR-CTX cross-cutting — non-leaking error envelopes", () => {
  it("cross-tenant store on switch → NotFoundException (404, not 403)", async () => {
    sessions.rows.push(activeSession({ activeTenantId: TENANT_ID }));
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    memberships.canAccessStoreResult = false; // simulates cross-tenant store
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("store switch with no active tenant → ConflictException (409)", async () => {
    sessions.rows.push(activeSession({ activeTenantId: null }));
    await expect(
      service.switchStore(SESSION_PRINCIPAL, STORE_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
