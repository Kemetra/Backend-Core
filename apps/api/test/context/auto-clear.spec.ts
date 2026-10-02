/**
 * T157 — auto-clear-active-store-on-tenant-switch regression spec.
 *
 * Pins the behavior already implemented in PR #21
 * (`ContextService.switchTenant`) and required by
 * `specs/.../contracts/context.openapi.yaml` line 41 ("Active tenant
 * switched. Active store is cleared.").
 *
 * Why a dedicated regression file
 * -------------------------------
 * The same behavior IS exercised inside `context.service.spec.ts`,
 * but a future PR that "optimizes" `switchTenant` (e.g., only
 * updating activeTenantId without touching activeStoreId) would
 * regress silently. A clearly-named file makes the breakage land in
 * a regression-named test rather than a buried one.
 *
 * Test style: pure unit, fake repositories — same idiom as
 * `tenant-context.guard.spec.ts` and `context.service.spec.ts`.
 */
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
const SESSION_ID = "0a000000-0000-7000-8000-0000000000a1";
const TENANT_ID = "0a000000-0000-7000-8000-0000000000b2";
const TENANT_ID_OTHER = "0a000000-0000-7000-8000-0000000000c3";
const STORE_ID = "0a000000-0000-7000-8000-0000000000d4";
const STORE_ID_NEW = "0a000000-0000-7000-8000-0000000000d5";
const MEMBERSHIP_ID = "0a000000-0000-7000-8000-0000000000e5";

// --- Fakes -----------------------------------------------------------

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
    | null = {
    membershipId: MEMBERSHIP_ID,
    storeAccessKind: "all",
  };
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

  async isPlatformAdmin(): Promise<boolean> {
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

  memberships.userSummary = {
    id: USER_ID,
    email: "alice@example.com",
    displayName: "Alice",
    isPlatformAdmin: false,
  };
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
  memberships.storeSummaryById.set(STORE_ID_NEW, {
    id: STORE_ID_NEW,
    code: "S02",
    name: "Secondary",
  });
});

// =====================================================================
// switchTenant — auto-clear-store invariant
// =====================================================================

describe("switchTenant — auto-clears activeStoreId", () => {
  it("from no prior state writes activeStoreId: null", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: null, activeStoreId: null }),
    );
    await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID);
    expect(sessions.updates).toHaveLength(1);
    expect(sessions.updates[0]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID,
      activeStoreId: null,
    });
  });

  it("from old tenant + store to new tenant clears the prior store", async () => {
    sessions.rows.push(
      activeSession({
        activeTenantId: TENANT_ID,
        activeStoreId: STORE_ID,
      }),
    );
    await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID_OTHER);
    expect(sessions.updates[0]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID_OTHER,
      activeStoreId: null,
    });
  });

  it("re-switching to the SAME tenant still clears the prior activeStoreId", async () => {
    // Defensive: re-affirming the active tenant should reset
    // store-scope. A future PR that "optimizes" by short-circuiting
    // when tenantId is unchanged would silently regress this.
    sessions.rows.push(
      activeSession({
        activeTenantId: TENANT_ID,
        activeStoreId: STORE_ID,
      }),
    );
    await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID);
    expect(sessions.updates[0]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID,
      activeStoreId: null,
    });
  });

  it("platform-admin tenant switch ALSO clears activeStoreId", async () => {
    memberships.isPlatformAdminResult = true;
    memberships.membershipResult = null; // platform admin has no membership
    sessions.rows.push(
      activeSession({
        activeTenantId: TENANT_ID,
        activeStoreId: STORE_ID,
      }),
    );
    await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID_OTHER);
    expect(sessions.updates[0]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID_OTHER,
      activeStoreId: null,
    });
  });
});

// =====================================================================
// clearStore — preserves activeTenantId
// =====================================================================

describe("clearStore — preserves activeTenantId", () => {
  it("clears only activeStoreId; tenantId remains intact", async () => {
    sessions.rows.push(
      activeSession({
        activeTenantId: TENANT_ID,
        activeStoreId: STORE_ID,
      }),
    );
    await service.clearStore(SESSION_PRINCIPAL);
    expect(sessions.updates).toHaveLength(1);
    expect(sessions.updates[0]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID,
      activeStoreId: null,
    });
  });

  it("is idempotent: clearing when already null preserves activeTenantId and writes null", async () => {
    sessions.rows.push(
      activeSession({
        activeTenantId: TENANT_ID,
        activeStoreId: null,
      }),
    );
    await service.clearStore(SESSION_PRINCIPAL);
    expect(sessions.updates[0]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID,
      activeStoreId: null,
    });
  });
});

// =====================================================================
// switchTenant → switchStore sequence
// =====================================================================

describe("switchTenant followed by switchStore — correct update sequence", () => {
  it("records two updates in the right order with the right shapes", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: null, activeStoreId: null }),
    );

    await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID);
    // After switchTenant the fake's session row is (TENANT_ID, null).
    // switchStore reads it, validates, then writes the new store.
    await service.switchStore(SESSION_PRINCIPAL, STORE_ID);

    expect(sessions.updates).toHaveLength(2);
    expect(sessions.updates[0]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID,
      activeStoreId: null,
    });
    expect(sessions.updates[1]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID,
      activeStoreId: STORE_ID,
    });
  });

  it("subsequent tenant switch clears the now-set active store again", async () => {
    sessions.rows.push(
      activeSession({ activeTenantId: null, activeStoreId: null }),
    );

    await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID);
    await service.switchStore(SESSION_PRINCIPAL, STORE_ID);
    // sessions row is now (TENANT_ID, STORE_ID)
    await service.switchTenant(SESSION_PRINCIPAL, TENANT_ID_OTHER);

    expect(sessions.updates).toHaveLength(3);
    expect(sessions.updates[2]).toEqual({
      id: SESSION_ID,
      activeTenantId: TENANT_ID_OTHER,
      activeStoreId: null,
    });
  });
});
