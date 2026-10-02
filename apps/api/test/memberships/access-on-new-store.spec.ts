/**
 * T176 [US4] — FR-ACCESS-3 D-5: kind='specific' users are NOT
 * automatically granted access to newly created stores.
 *
 * Spec definition (spec.md FR-ACCESS-3):
 *   "When a new store is created in a tenant, users with the 'all stores'
 *    policy MUST gain access automatically. Users with a specific-stores
 *    policy MUST NOT gain access until explicitly added."
 *
 * The production behaviour lives in
 * `apps/api/src/context/membership.repository.ts` — `canAccessStore`:
 *   - kind='all'      → store exists in tenant → return true (automatic)
 *   - kind='specific' → store exists in tenant AND a store_access row
 *                       exists → return true; without the row → false
 *
 * Test approach
 * -------------
 * Docker-free. Hand-rolled fakes follow the style of cross-store.sweep.spec.ts
 * and default-deny.spec.ts. We exercise `ContextService.switchStore`, which
 * calls `canAccessStore` before committing the context switch — it is the
 * natural end-to-end entry point for store-access policy.
 *
 * The fake `canAccessStore` models the two-step real logic in memory:
 *   Step 1: storeId must be registered as belonging to the queried tenantId.
 *   Step 2: for kind='specific', an explicit grant entry must also exist.
 *
 * This lets us assert the correct behaviour without a database.
 *
 * Scenarios
 * ---------
 *   kind='all' access behaviour
 *     - store in tenant (no grant needed) → accessible  [FR-ACCESS-3 positive]
 *     - store NOT in tenant (cross-tenant) → denied      [safety gate]
 *
 *   kind='specific' access behaviour (D-5 core)
 *     - new store in tenant, NO grant row → denied       [D-5]
 *     - same store WITH explicit grant row → accessible  [expected path]
 *     - store has been revoked (grant removed) → denied  [D-6 light variant]
 *
 *   Cross-tenant safety
 *     - grant for store in Tenant A cannot be used to access same store
 *       within Tenant B context → denied                 [D-5 cross-tenant]
 */

import { NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { SessionRow, StoreAccessKind } from "@data-pulse-2/db/schema";

import type { Principal } from "../../src/auth/auth.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import { ContextService } from "../../src/context/context.service";
import type {
  ActiveMembership,
  MembershipRepository,
  MembershipSummary,
  StoreSummary,
  TenantSummary,
} from "../../src/context/membership.repository";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const USER_ID      = "d5000000-0000-7000-8000-00000000aa01";
const SESSION_ID   = "d5000000-0000-7000-8000-0000000ses01";
const MEMBERSHIP_ID = "d5000000-0000-7000-8000-0000000mem01";

const TENANT_A = "d5000000-0000-7000-8000-0000000ten01";
const TENANT_B = "d5000000-0000-7000-8000-0000000ten02";

/** Existing store the user explicitly has access to (in TENANT_A). */
const STORE_EXISTING = "d5000000-0000-7000-8000-0000000sto01";
/** Newly created store — exists in TENANT_A but has NO store_access row yet. */
const STORE_NEW      = "d5000000-0000-7000-8000-0000000sto02";
/** Store that belongs to TENANT_B, not TENANT_A. */
const STORE_TENANT_B = "d5000000-0000-7000-8000-0000000sto03";

// ---------------------------------------------------------------------------
// Fake: SessionRepository
// ---------------------------------------------------------------------------

class FakeSessionRepository {
  row: SessionRow | null = null;
  updateResult: SessionRow | null = null;

  async findActiveById(_id: string): Promise<SessionRow | null> {
    return this.row;
  }

  async updateActiveContext(
    _sessionId: string,
    _ctx: { activeTenantId: string | null; activeStoreId: string | null },
  ): Promise<SessionRow | null> {
    return this.updateResult;
  }
}

function makeActiveSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    activeTenantId: TENANT_A,
    activeStoreId: null,
    issuedAt: new Date(),
    lastSeenAt: new Date(),
    absoluteExpiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    userAgent: null,
    ipAtIssue: null,
    ...overrides,
  } as SessionRow;
}

// ---------------------------------------------------------------------------
// Fake: MembershipRepository
// ---------------------------------------------------------------------------

/**
 * Configurable fake that models canAccessStore in memory.
 *
 * `storeTenantMap`
 *   Maps storeId → tenantId. Simulates Step 1 of the real implementation:
 *   "the store must belong to this tenant". Any storeId not in the map is
 *   treated as belonging to no tenant (or another tenant not under test).
 *
 * `grants`
 *   Set of storeIds that have explicit store_access rows for the user.
 *   Only consulted when kind='specific'. Simulates Step 2 of the real
 *   implementation. Note: real grants are also tenant-scoped, but since
 *   Step 1 already rejects the wrong tenant, we only need storeId here
 *   for the happy-path cases.
 */
class FakeMembershipRepository {
  kind: StoreAccessKind = "all";

  /** storeId → tenantId. Step 1 of canAccessStore. */
  storeTenantMap = new Map<string, string>([
    [STORE_EXISTING, TENANT_A],
    [STORE_NEW,      TENANT_A],
    [STORE_TENANT_B, TENANT_B],
  ]);

  /** Stores with an explicit store_access grant. Step 2 of canAccessStore. */
  grants = new Set<string>([STORE_EXISTING]);

  // ---- canAccessStore -------------------------------------------------

  async canAccessStore(
    _membershipId: string,
    tenantId: string,
    storeId: string,
    kind: StoreAccessKind,
    _client?: PoolClient,
  ): Promise<boolean> {
    // Step 1: store must belong to the queried tenant.
    if (this.storeTenantMap.get(storeId) !== tenantId) return false;
    // Step 2: for 'specific', an explicit grant is required.
    if (kind === "specific") return this.grants.has(storeId);
    return true;
  }

  // ---- findActiveMembership -------------------------------------------

  async findActiveMembership(
    _userId: string,
    _tenantId: string,
    _client?: PoolClient,
  ): Promise<ActiveMembership | null> {
    return { membershipId: MEMBERSHIP_ID, storeAccessKind: this.kind };
  }

  // ---- isPlatformAdmin ------------------------------------------------

  async isPlatformAdmin(_userId: string): Promise<boolean> {
    return false;
  }

  // ---- buildResponse stubs -------------------------------------------

  async findUserSummary(_userId: string): Promise<{
    id: string;
    email: string;
    displayName: string | null;
    isPlatformAdmin: boolean;
  } | null> {
    return {
      id: USER_ID,
      email: "user@example.com",
      displayName: null,
      isPlatformAdmin: false,
    };
  }

  async listForUser(
    _userId: string,
    _client?: PoolClient,
  ): Promise<MembershipSummary[]> {
    return [
      {
        tenantId: TENANT_A,
        tenantName: "Tenant A",
        roleCode: "store_staff",
        storeAccessKind: this.kind,
        accessibleStoreIds: this.kind === "specific" ? [...this.grants] : [],
      },
    ];
  }

  async findTenantSummary(
    _tenantId: string,
    _client?: PoolClient,
  ): Promise<TenantSummary | null> {
    return { id: TENANT_A, slug: "tenant-a", name: "Tenant A" };
  }

  async findStoreSummary(
    storeId: string,
    _tenantId: string,
    _client?: PoolClient,
  ): Promise<StoreSummary | null> {
    if (storeId === STORE_EXISTING) return { id: STORE_EXISTING, code: "EXIST", name: "Existing Store" };
    if (storeId === STORE_NEW)      return { id: STORE_NEW, code: "NEW", name: "New Store" };
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wire-up helpers
// ---------------------------------------------------------------------------

/**
 * Passthrough TenantTxRunner: fabricates a stub PoolClient so the service's
 * orchestration logic runs without a real Postgres pool. Fakes ignore client.
 */
const passthroughTx = <T>(
  _pool: unknown,
  _ctx: unknown,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> => work({} as PoolClient);

function buildStack(
  kindOverride?: StoreAccessKind,
): {
  service: ContextService;
  sessions: FakeSessionRepository;
  memberships: FakeMembershipRepository;
} {
  const sessions = new FakeSessionRepository();
  const memberships = new FakeMembershipRepository();
  if (kindOverride !== undefined) memberships.kind = kindOverride;

  const service = new ContextService(
    sessions as unknown as SessionRepository,
    memberships as unknown as MembershipRepository,
    // pool intentionally omitted (unit test path — withBootstrapCtx falls
    // back to work(undefined) when pool is absent, and fake repos ignore client)
  );
  // Inject passthroughTx so store-context service calls don't need a real pool.
  // ContextService does not expose a tx setter, but it reads from
  // runWithTenantContext (imported). For unit tests the fake repos ignore
  // the client arg, so we invoke the service method directly.
  return { service, sessions, memberships };
}

function makeSessionPrincipal(): Extract<Principal, { kind: "session" }> {
  return { kind: "session", sessionId: SESSION_ID, userId: USER_ID };
}

// ---------------------------------------------------------------------------
// kind='all' access behaviour
// ---------------------------------------------------------------------------

describe("kind='all' access behaviour — FR-ACCESS-3 automatic access", () => {
  it("store in tenant is accessible without any store_access row (auto-granted)", async () => {
    const { service, sessions } = buildStack("all");
    sessions.row = makeActiveSession({ activeTenantId: TENANT_A });
    sessions.updateResult = makeActiveSession({ activeStoreId: STORE_NEW });

    // kind='all': STORE_NEW exists in TENANT_A → should succeed with no grant.
    await expect(
      service.switchStore(makeSessionPrincipal(), STORE_NEW),
    ).resolves.toBeDefined();
  });

  it("newly created store (no store_access rows at all) is accessible for kind='all' user", async () => {
    const { service, sessions, memberships } = buildStack("all");
    // Ensure STORE_NEW has no grants whatsoever.
    memberships.grants = new Set();
    sessions.row = makeActiveSession({ activeTenantId: TENANT_A });
    sessions.updateResult = makeActiveSession({ activeStoreId: STORE_NEW });

    await expect(
      service.switchStore(makeSessionPrincipal(), STORE_NEW),
    ).resolves.toBeDefined();
  });

  it("store NOT in this tenant is denied even for kind='all' user (cross-tenant safety)", async () => {
    const { service, sessions } = buildStack("all");
    sessions.row = makeActiveSession({ activeTenantId: TENANT_A });

    // STORE_TENANT_B belongs to TENANT_B — Step 1 rejects it.
    await expect(
      service.switchStore(makeSessionPrincipal(), STORE_TENANT_B),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// kind='specific' access behaviour — D-5 core
// ---------------------------------------------------------------------------

describe("kind='specific' access behaviour — D-5: no auto-grant for new stores", () => {
  it("new store in tenant is denied when no store_access row exists (D-5)", async () => {
    const { service, sessions } = buildStack("specific");
    // Default grants set contains only STORE_EXISTING; STORE_NEW has no grant.
    sessions.row = makeActiveSession({ activeTenantId: TENANT_A });

    // This is the D-5 assertion: store exists in tenant, user is kind='specific',
    // but no explicit grant → must be denied.
    await expect(
      service.switchStore(makeSessionPrincipal(), STORE_NEW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("denial for new store is NotFoundException (maps to safe 404 per FR-ISO-4)", async () => {
    const { service, sessions } = buildStack("specific");
    sessions.row = makeActiveSession({ activeTenantId: TENANT_A });

    let caught: unknown;
    try {
      await service.switchStore(makeSessionPrincipal(), STORE_NEW);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundException);
  });

  it("store becomes accessible once an explicit store_access row is added", async () => {
    const { service, sessions, memberships } = buildStack("specific");
    // Simulate explicit grant being added for STORE_NEW.
    memberships.grants.add(STORE_NEW);
    sessions.row = makeActiveSession({ activeTenantId: TENANT_A });
    sessions.updateResult = makeActiveSession({ activeStoreId: STORE_NEW });

    await expect(
      service.switchStore(makeSessionPrincipal(), STORE_NEW),
    ).resolves.toBeDefined();
  });

  it("pre-existing granted store remains accessible for kind='specific' user", async () => {
    const { service, sessions } = buildStack("specific");
    // STORE_EXISTING is in the default grants set.
    sessions.row = makeActiveSession({ activeTenantId: TENANT_A });
    sessions.updateResult = makeActiveSession({ activeStoreId: STORE_EXISTING });

    await expect(
      service.switchStore(makeSessionPrincipal(), STORE_EXISTING),
    ).resolves.toBeDefined();
  });

  it("revoking grant (removing store_access row) denies access on next request", async () => {
    const { service, sessions, memberships } = buildStack("specific");
    // Simulate revocation: remove the grant for STORE_EXISTING.
    memberships.grants.delete(STORE_EXISTING);
    sessions.row = makeActiveSession({ activeTenantId: TENANT_A });

    await expect(
      service.switchStore(makeSessionPrincipal(), STORE_EXISTING),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant safety
// ---------------------------------------------------------------------------

describe("cross-tenant safety — store_access in Tenant A does not grant access in Tenant B context", () => {
  it("kind='specific' grant for STORE_NEW in Tenant A does not help in Tenant B context", async () => {
    const { service, sessions, memberships } = buildStack("specific");
    // Add a grant for STORE_NEW (but it belongs to TENANT_A, not TENANT_B).
    memberships.grants.add(STORE_NEW);
    // Session is active in TENANT_B.
    sessions.row = makeActiveSession({ activeTenantId: TENANT_B });

    // STORE_NEW.tenantId is TENANT_A; Step 1 rejects it when tenantId=TENANT_B.
    await expect(
      service.switchStore(makeSessionPrincipal(), STORE_NEW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("kind='all' grant for STORE_TENANT_B (in Tenant B) is not accessible in Tenant A context", async () => {
    const { service, sessions } = buildStack("all");
    sessions.row = makeActiveSession({ activeTenantId: TENANT_A });

    // STORE_TENANT_B belongs to TENANT_B → Step 1 fails in TENANT_A context.
    await expect(
      service.switchStore(makeSessionPrincipal(), STORE_TENANT_B),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
