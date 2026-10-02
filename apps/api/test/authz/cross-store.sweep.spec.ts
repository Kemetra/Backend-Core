/**
 * T204 — SC-2 cross-store authorization sweep.
 *
 * Scope
 * -----
 * Cross-store means: a single tenant (T) has stores S1 and S2; a user U
 * has `kind='specific'` membership with a `store_access` row for S1 only.
 * This file tests U's attempts on S2.
 *
 * In scope (D-class matrix rows asserted here)
 * --------------------------------------------
 *   D-2: POST /api/v1/context/store { store_id: S2 } → 404 not_found
 *        (ContextService.switchStore calls canAccessStore; returns false for S2
 *        → NotFoundException — safe 404 per FR-ISO-4).
 *   D-3: GET /api/v1/stores/:S2 → 404 not_found
 *        (StoresService.read calls findActiveMembership then canAccessStore;
 *        returns false for S2 → NotFoundException).
 *   D-1: Positive control — same user with access to S1 → both endpoints succeed.
 *
 * Out of scope (documented reasons)
 * ----------------------------------
 *   PATCH /api/v1/stores/:S2, DELETE /api/v1/stores/:S2
 *     — decorated @Roles("owner","tenant_admin"). A store_staff caller with
 *       kind='specific' is rejected by RolesGuard BEFORE any store-access check.
 *       Cross-store is degenerate for these endpoints when the caller is
 *       store_staff; for owner/tenant_admin the access kind is implicitly 'all',
 *       so cross-store is also not a meaningful scenario. Not a gap; the role gate
 *       is the correct first defense.
 *
 *   GET /api/v1/stores (list)
 *     — returns all stores in the active tenant; no per-store canAccessStore
 *       check is applied. Visibility is tenant-scoped, not store-access-scoped.
 *       The spec intentionally lets kind='specific' members see the full
 *       store catalog (they just can't *operate* on restricted stores).
 *
 *   GET /api/v1/audit/events?store_id=S2
 *     — tenant-scoped query; no guard-level safe 404 per store_id. The service
 *       filters rows by store_id and returns empty for rows the actor never
 *       had visibility into. This is a service-internal filter, not a guard-level
 *       canAccessStore check. Potential follow-up: B-14-adjacent gap.
 *
 *   DB-layer invariant (D-7)
 *     — `store_access` composite FK mismatch is tested separately at
 *       `packages/db/__tests__/store-access.invariant.spec.ts`. Not duplicated here.
 *
 * Style
 * -----
 * Hand-rolled fakes matching the idiom in `default-deny.spec.ts` and
 * `frontend-bypass.spec.ts`. Real production controller + service are
 * instantiated; collaborator repositories are fake classes. Docker-free.
 * No NestJS TestingModule required.
 *
 * Envelope assertion
 * ------------------
 * The dedicated envelope test is `apps/api/test/common/exception.filter.spec.ts`.
 * Here we assert the thrown exception is NotFoundException (instanceof check).
 * Rendering to `{ error: { code: "not_found", ... } }` is GlobalExceptionFilter's
 * responsibility; we reference the filter spec rather than re-running it.
 *
 * References
 * ----------
 *   - D-2 also covered at: apps/api/test/context/tenant-context.guard.spec.ts
 *   - D-3 also covered at: apps/api/test/stores/stores.controller.spec.ts
 *   - DB-layer invariant I-3: packages/db/__tests__/store-access.invariant.spec.ts
 *   - Envelope shape: apps/api/test/common/exception.filter.spec.ts
 */

import { NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { SessionRow, StoreAccessKind } from "@data-pulse-2/db/schema";

import type { Principal } from "../../src/auth/auth.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import { ContextController } from "../../src/context/context.controller";
import { ContextService } from "../../src/context/context.service";
import type {
  ActiveMembership,
  MembershipRepository,
  MembershipSummary,
  StoreSummary,
  TenantSummary,
} from "../../src/context/membership.repository";
import type { AuthedRequest } from "../../src/auth/auth.guard";
import { StoresController } from "../../src/stores/stores.controller";
import { StoresService } from "../../src/stores/stores.service";
import type { StoresRepository, StoreRecord } from "../../src/stores/stores.repository";
import type { ResolvedContext } from "../../src/context/types";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const USER_ID = "0d000000-0000-7000-8000-00000000aa01";
const SESSION_ID = "0d000000-0000-7000-8000-0000000ses01";
const TENANT_ID = "0d000000-0000-7000-8000-0000000ten01";
const MEMBERSHIP_ID = "0d000000-0000-7000-8000-0000000mem01";

/** S1 — store the user has access to. */
const S1_ID = "0d000000-0000-7000-8000-0000000sto01";
/** S2 — store in the same tenant the user does NOT have access to. */
const S2_ID = "0d000000-0000-7000-8000-0000000sto02";

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
    activeTenantId: TENANT_ID,
    activeStoreId: null,
    issuedAt: new Date(),
    lastSeenAt: new Date(),
    absoluteExpiresAt: new Date(Date.now() + 3600 * 1000),
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
 * Fake membership repository whose `canAccessStore` returns true only when
 * `storeId === S1_ID`. For any other store (including S2) it returns false,
 * modelling U's kind='specific' membership with access to S1 only.
 */
class FakeMembershipRepository {
  isPlatformAdminResult = false;
  /** Non-null = user has an active membership in the tenant. */
  activeMembership: ActiveMembership | null = {
    membershipId: MEMBERSHIP_ID,
    storeAccessKind: "specific" as StoreAccessKind,
  };

  async isPlatformAdmin(_userId: string): Promise<boolean> {
    return this.isPlatformAdminResult;
  }

  async findActiveMembership(
    _userId: string,
    _tenantId: string,
    _client?: PoolClient,
  ): Promise<ActiveMembership | null> {
    return this.activeMembership;
  }

  /**
   * Grants access to S1 only. S2 returns false.
   * kind='all' is not used in this sweep (the user is kind='specific').
   */
  async canAccessStore(
    _membershipId: string,
    _tenantId: string,
    storeId: string,
    _kind: StoreAccessKind,
    _client?: PoolClient,
  ): Promise<boolean> {
    return storeId === S1_ID;
  }

  // ---- ContextService.buildResponse stubs (called after a successful switch) ----

  async findUserSummary(
    userId: string,
    _client?: PoolClient,
  ): Promise<{
    id: string;
    email: string;
    displayName: string | null;
    isPlatformAdmin: boolean;
  } | null> {
    return {
      id: userId,
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
        tenantId: TENANT_ID,
        tenantName: "Acme Corp",
        roleCode: "store_staff",
        storeAccessKind: "specific" as StoreAccessKind,
        accessibleStoreIds: [S1_ID],
      },
    ];
  }

  async findTenantSummary(
    _tenantId: string,
    _client?: PoolClient,
  ): Promise<TenantSummary | null> {
    return { id: TENANT_ID, name: "Acme Corp" } as TenantSummary;
  }

  async findStoreSummary(
    storeId: string,
    _tenantId: string,
    _client?: PoolClient,
  ): Promise<StoreSummary | null> {
    if (storeId === S1_ID) {
      return { id: S1_ID, code: "S1", name: "Store One" };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fake: StoresRepository (used by StoresService in Scenario B)
// ---------------------------------------------------------------------------

/**
 * Fake stores repository. `findById` returns a record for S1 only.
 * `existsInTenant` returns true for both stores (S2 exists in the tenant;
 * the access denial comes from canAccessStore, not from RLS absence).
 * This is important: StoresService.read stage-1 calls canAccessStore first;
 * if that throws, stage-2 (findById) never fires.
 */
class FakeStoresRepository {
  async listInTenant(_client: PoolClient): Promise<StoreRecord[]> {
    return [makeStoreRecord(S1_ID, "S1"), makeStoreRecord(S2_ID, "S2")];
  }

  async findById(
    _client: PoolClient,
    storeId: string,
  ): Promise<StoreRecord | null> {
    if (storeId === S1_ID) return makeStoreRecord(S1_ID, "S1");
    return null;
  }

  async existsInTenant(_client: PoolClient, storeId: string): Promise<boolean> {
    // Both S1 and S2 exist in the tenant (S2 is just not accessible to U).
    return storeId === S1_ID || storeId === S2_ID;
  }

  async create(
    _client: PoolClient,
    input: { id: string; tenantId: string; code: string; name: string },
  ): Promise<StoreRecord> {
    return makeStoreRecord(input.id, input.code);
  }

  async update(
    _client: PoolClient,
    storeId: string,
    _next: { name?: string; isActive?: boolean },
  ): Promise<StoreRecord | null> {
    return storeId === S1_ID ? makeStoreRecord(S1_ID, "S1") : null;
  }

  async softDelete(
    _client: PoolClient,
    _storeId: string,
  ): Promise<boolean> {
    return true;
  }
}

function makeStoreRecord(id: string, code: string): StoreRecord {
  return {
    id,
    tenantId: TENANT_ID,
    code,
    name: `Store ${code}`,
    isActive: true,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    deletedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Wire-up helpers
// ---------------------------------------------------------------------------

/**
 * Passthrough TenantTxRunner: no real Pool needed. Calls the work function
 * with a stub PoolClient (fakes don't use it — they ignore the client arg).
 */
const passthroughTx = <T>(
  _pool: unknown,
  _ctx: unknown,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> => work({} as PoolClient);

function buildContextStack(): {
  controller: ContextController;
  sessions: FakeSessionRepository;
  memberships: FakeMembershipRepository;
} {
  const sessions = new FakeSessionRepository();
  const memberships = new FakeMembershipRepository();
  // No pool injected → ContextService.withBootstrapCtx calls work(undefined)
  // and fake repos ignore the client arg.
  const service = new ContextService(
    sessions as unknown as SessionRepository,
    memberships as unknown as MembershipRepository,
    // pool intentionally omitted (unit test path)
  );
  const controller = new ContextController(service);
  return { controller, sessions, memberships };
}

function buildStoresStack(): {
  controller: StoresController;
  memberships: FakeMembershipRepository;
  storesRepo: FakeStoresRepository;
} {
  const memberships = new FakeMembershipRepository();
  const storesRepo = new FakeStoresRepository();
  const service = new StoresService(
    {} as never, // pool — not reached; passthroughTx is injected
    storesRepo as unknown as StoresRepository,
    memberships as unknown as MembershipRepository,
    passthroughTx as never,
  );
  const controller = new StoresController(service);
  return { controller, memberships, storesRepo };
}

function makeSessionPrincipal(): Principal {
  return { kind: "session", sessionId: SESSION_ID, userId: USER_ID };
}

function makeAuthedRequest(
  principal: Principal,
  contextOverrides?: Partial<ResolvedContext>,
): AuthedRequest {
  const resolvedContext: ResolvedContext = {
    userId: USER_ID,
    tenantId: TENANT_ID,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    ...contextOverrides,
  };
  return {
    headers: {},
    principal,
    context: resolvedContext,
  } as unknown as AuthedRequest;
}

// ---------------------------------------------------------------------------
// Scenario A — D-2: POST /api/v1/context/store with cross-store store_id
// ---------------------------------------------------------------------------

describe("T204 D-2 — cross-store context switch (POST /api/v1/context/store)", () => {
  it("denies U when switching to S2 (no store_access row) → NotFoundException", async () => {
    const { controller, sessions } = buildContextStack();

    // Session must have activeTenantId so switchStore doesn't throw 409.
    sessions.row = makeActiveSession({ activeTenantId: TENANT_ID });
    // updateResult not needed — canAccessStore returns false before updateActiveContext.

    const req = makeAuthedRequest(makeSessionPrincipal());

    await expect(
      controller.switchStore(req as never, { store_id: S2_ID }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("denies U when switching to a completely unknown store → NotFoundException", async () => {
    const { controller, sessions } = buildContextStack();

    sessions.row = makeActiveSession({ activeTenantId: TENANT_ID });

    const req = makeAuthedRequest(makeSessionPrincipal());
    const UNKNOWN_STORE_ID = "0d000000-0000-7000-8000-0000000sto99";

    await expect(
      controller.switchStore(req as never, { store_id: UNKNOWN_STORE_ID }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// Scenario B — D-3: GET /api/v1/stores/:store_id with cross-store id
// ---------------------------------------------------------------------------

describe("T204 D-3 — cross-store store read (GET /api/v1/stores/:store_id)", () => {
  it("denies U reading S2 (no store_access row) → NotFoundException", async () => {
    const { controller } = buildStoresStack();

    const req = makeAuthedRequest(makeSessionPrincipal());

    await expect(controller.read(req as never, S2_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("canAccessStore is the denial gate — stage-2 findById never fires for S2", async () => {
    const { controller, storesRepo } = buildStoresStack();

    const findByIdSpy = jest.spyOn(storesRepo, "findById");
    const req = makeAuthedRequest(makeSessionPrincipal());

    await expect(controller.read(req as never, S2_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // stage-1 (canAccessStore) throws → stage-2 must not have run.
    expect(findByIdSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Positive control (D-1 mirror) — same user with access to S1 succeeds
// ---------------------------------------------------------------------------

describe("T204 D-1 (positive control) — user with S1 access can read/switch to S1", () => {
  it("context switch to S1 succeeds (POST /api/v1/context/store)", async () => {
    const { controller, sessions } = buildContextStack();

    sessions.row = makeActiveSession({ activeTenantId: TENANT_ID });
    // updateActiveContext must return a valid session for buildResponse.
    sessions.updateResult = makeActiveSession({ activeStoreId: S1_ID });

    const req = makeAuthedRequest(makeSessionPrincipal());

    await expect(
      controller.switchStore(req as never, { store_id: S1_ID }),
    ).resolves.toBeDefined();
  });

  it("store read for S1 succeeds (GET /api/v1/stores/:store_id)", async () => {
    const { controller } = buildStoresStack();

    const req = makeAuthedRequest(makeSessionPrincipal());

    const result = await controller.read(req as never, S1_ID);
    expect(result).toMatchObject({ id: S1_ID });
  });
});

// ---------------------------------------------------------------------------
// Envelope invariant documentation
// ---------------------------------------------------------------------------

describe("T204 — safe 404 envelope invariant", () => {
  it("cross-store rejection is NotFoundException (maps to 404 not_found via GlobalExceptionFilter)", async () => {
    const { controller, sessions } = buildContextStack();
    sessions.row = makeActiveSession({ activeTenantId: TENANT_ID });

    let caught: unknown;
    try {
      await controller.switchStore(makeAuthedRequest(makeSessionPrincipal()) as never, {
        store_id: S2_ID,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NotFoundException);
    // The canonical envelope { error: { code: "not_found", ... } } is rendered
    // by GlobalExceptionFilter. See apps/api/test/common/exception.filter.spec.ts.
    // We assert the exception kind rather than duplicating filter coverage here.
  });

  it("cross-store store read rejection is NotFoundException (maps to 404 not_found)", async () => {
    const { controller } = buildStoresStack();

    let caught: unknown;
    try {
      await controller.read(makeAuthedRequest(makeSessionPrincipal()) as never, S2_ID);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NotFoundException);
  });
});
