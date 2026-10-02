/**
 * T150 — TenantContextGuard spec.
 *
 * Pure unit-level. Collaborators (`SessionRepository`,
 * `MembershipRepository`) are faked at the class boundary; no Postgres,
 * no `runWithTenantContext`, no Testcontainers.
 *
 * The test pyramid mirrors the established repo idiom (PR #14/#15/#16/#17):
 * tiny `*Like`-style fakes that record calls and return canned values.
 *
 * Coverage maps to the approved test list:
 *   - missing principal             → 401
 *   - session w/ no active tenant   → 401
 *   - valid membership, no store    → allowed
 *   - revoked / deleted / missing   → 404 (FR-ISO-4)
 *   - kind='all' + store in tenant  → allowed
 *   - kind='all' + cross-tenant     → 404
 *   - kind='specific' + grant exists → allowed
 *   - kind='specific' + no grant     → 404
 *   - platform-admin session         → membership skipped
 *   - token w/ tenantId              → no membership query
 *   - platform-scoped token (null)   → isPlatformAdmin: true
 */
import {
  type ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { SessionRow, StoreAccessKind } from "@data-pulse-2/db/schema";
import type {
  AuthedRequest,
  Principal,
} from "../../src/auth/auth.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { MembershipRepository } from "../../src/context/membership.repository";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import type { TenantContextRequest } from "../../src/context/types";

// --- IDs (UUIDv7-ish) -------------------------------------------------

const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const SESSION_ID = "0a000000-0000-7000-8000-0000000ses01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000ten01";
const OTHER_TENANT_ID = "0a000000-0000-7000-8000-0000000ten02";
const STORE_ID = "0a000000-0000-7000-8000-0000000sto01";
const TOKEN_ID = "0a000000-0000-7000-8000-0000000tok01";
const MEMBERSHIP_ID = "0a000000-0000-7000-8000-0000000mem01";

// --- Fakes ------------------------------------------------------------

class FakeSessionRepository {
  row: SessionRow | null = null;
  calls: string[] = [];
  async findActiveById(id: string): Promise<SessionRow | null> {
    this.calls.push(id);
    return this.row;
  }
}

interface CanAccessCall {
  membershipId: string;
  tenantId: string;
  storeId: string;
  kind: StoreAccessKind;
}

class FakeMembershipRepository {
  isPlatformAdminResult = false;
  membershipResult: { membershipId: string; storeAccessKind: StoreAccessKind } | null =
    null;
  canAccessStoreResult = true;

  isPlatformAdminCalls: string[] = [];
  findActiveMembershipCalls: Array<{ userId: string; tenantId: string }> = [];
  canAccessStoreCalls: CanAccessCall[] = [];

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

  grantedStoreIds: readonly string[] = [STORE_ID];
  async listGrantedStoreIds(): Promise<readonly string[]> {
    return this.grantedStoreIds;
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
  };
}

function makeRequest(
  principal: Principal | undefined,
): TenantContextRequest {
  const r: Partial<TenantContextRequest> = {};
  if (principal) r.principal = principal;
  return r as TenantContextRequest;
}

function makeContext(request: AuthedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as unknown as T,
      getResponse: <T>() => ({}) as T,
      getNext: <T>() => ({}) as T,
    }),
  } as unknown as ExecutionContext;
}

// --- Wiring -----------------------------------------------------------

let sessions: FakeSessionRepository;
let memberships: FakeMembershipRepository;
let guard: TenantContextGuard;

beforeEach(() => {
  sessions = new FakeSessionRepository();
  memberships = new FakeMembershipRepository();
  guard = new TenantContextGuard(
    sessions as unknown as SessionRepository,
    memberships as unknown as MembershipRepository,
  );
});

// --- Tests ------------------------------------------------------------

describe("TenantContextGuard — preconditions", () => {
  it("throws 401 when request.principal is missing", async () => {
    const ctx = makeContext(makeRequest(undefined));
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe("TenantContextGuard — session principal: tenant-only", () => {
  it("throws 401 when the session has no activeTenantId", async () => {
    sessions.row = activeSession({ activeTenantId: null });
    const ctx = makeContext(
      makeRequest({ kind: "session", sessionId: SESSION_ID, userId: USER_ID }),
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(memberships.findActiveMembershipCalls).toHaveLength(0);
  });

  it("throws 401 when the session can no longer be found (TOCTOU)", async () => {
    sessions.row = null;
    const ctx = makeContext(
      makeRequest({ kind: "session", sessionId: SESSION_ID, userId: USER_ID }),
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("publishes context for a valid membership with no active store", async () => {
    sessions.row = activeSession({ activeStoreId: null });
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };

    const request = makeRequest({
      kind: "session",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    const ctx = makeContext(request);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(request.context).toEqual({
      userId: USER_ID,
      tenantId: TENANT_ID,
      storeId: null,
      isPlatformAdmin: false,
      source: "session",
      storeAccess: { kind: "all" },
    });
    expect(memberships.findActiveMembershipCalls).toEqual([
      { userId: USER_ID, tenantId: TENANT_ID },
    ]);
    // No store on the session → canAccessStore must NOT be called.
    expect(memberships.canAccessStoreCalls).toHaveLength(0);
  });

  it("throws 404 when the user has no active membership in the active tenant (FR-ISO-4)", async () => {
    sessions.row = activeSession();
    memberships.membershipResult = null;

    const ctx = makeContext(
      makeRequest({ kind: "session", sessionId: SESSION_ID, userId: USER_ID }),
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("TenantContextGuard — session principal: store-access", () => {
  beforeEach(() => {
    sessions.row = activeSession({ activeStoreId: STORE_ID });
  });

  it("kind='all' + store in active tenant → allowed", async () => {
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    memberships.canAccessStoreResult = true;

    const request = makeRequest({
      kind: "session",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.context?.storeId).toBe(STORE_ID);
    expect(memberships.canAccessStoreCalls).toEqual([
      {
        membershipId: MEMBERSHIP_ID,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        kind: "all",
      },
    ]);
  });

  it("kind='all' + store from a different tenant → 404", async () => {
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "all",
    };
    memberships.canAccessStoreResult = false;

    const ctx = makeContext(
      makeRequest({ kind: "session", sessionId: SESSION_ID, userId: USER_ID }),
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("kind='specific' + store_access row exists → allowed", async () => {
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "specific",
    };
    memberships.canAccessStoreResult = true;

    const request = makeRequest({
      kind: "session",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.context?.storeId).toBe(STORE_ID);
    expect(memberships.canAccessStoreCalls[0]).toEqual({
      membershipId: MEMBERSHIP_ID,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      kind: "specific",
    });
    expect(request.context?.storeAccess).toEqual({
      kind: "specific",
      storeIds: [STORE_ID],
    });
  });

  it("RT-131: kind='specific' + no active store → publishes the granted stores, not tenant-wide", async () => {
    sessions.row = activeSession({ activeStoreId: null });
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "specific",
    };

    const request = makeRequest({
      kind: "session",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.context?.storeId).toBeNull();
    expect(request.context?.storeAccess).toEqual({
      kind: "specific",
      storeIds: [STORE_ID],
    });
  });

  it("kind='specific' + no store_access row → 404", async () => {
    memberships.membershipResult = {
      membershipId: MEMBERSHIP_ID,
      storeAccessKind: "specific",
    };
    memberships.canAccessStoreResult = false;

    const ctx = makeContext(
      makeRequest({ kind: "session", sessionId: SESSION_ID, userId: USER_ID }),
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("TenantContextGuard — platform-admin session", () => {
  it("bypasses membership validation (FR-TEN-6)", async () => {
    sessions.row = activeSession({ activeStoreId: null });
    memberships.isPlatformAdminResult = true;

    const request = makeRequest({
      kind: "session",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.context).toEqual({
      userId: USER_ID,
      tenantId: TENANT_ID,
      storeId: null,
      isPlatformAdmin: true,
      source: "session",
      storeAccess: { kind: "all" },
    });
    // is_platform_admin === true ⇒ membership lookup must be skipped
    expect(memberships.findActiveMembershipCalls).toHaveLength(0);
  });

  it("still validates store-tenant binding when storeId is set", async () => {
    sessions.row = activeSession({ activeStoreId: STORE_ID });
    memberships.isPlatformAdminResult = true;
    memberships.canAccessStoreResult = false;

    const ctx = makeContext(
      makeRequest({ kind: "session", sessionId: SESSION_ID, userId: USER_ID }),
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Must use the 'all' branch (no membership policy applies).
    expect(memberships.canAccessStoreCalls[0]?.kind).toBe("all");
  });
});

describe("TenantContextGuard — token principal", () => {
  it("with tenantId set: resolves without a membership query", async () => {
    const request = makeRequest({
      kind: "token",
      tokenId: TOKEN_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      storeId: null,
      scope: "dashboard_api",
    });
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.context).toEqual({
      userId: USER_ID,
      tenantId: TENANT_ID,
      storeId: null,
      isPlatformAdmin: false,
      source: "token",
    });
    expect(memberships.isPlatformAdminCalls).toHaveLength(0);
    expect(memberships.findActiveMembershipCalls).toHaveLength(0);
    expect(memberships.canAccessStoreCalls).toHaveLength(0);
    expect(sessions.calls).toHaveLength(0);
  });

  it("with tenantId === null: resolves as platform admin", async () => {
    const request = makeRequest({
      kind: "token",
      tokenId: TOKEN_ID,
      tenantId: null,
      userId: null,
      storeId: null,
      scope: "dashboard_api",
    });
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.context).toEqual({
      userId: null,
      tenantId: null,
      storeId: null,
      isPlatformAdmin: true,
      source: "token",
    });
    expect(memberships.isPlatformAdminCalls).toHaveLength(0);
  });

  it("does not consult the membership repo even when tenantId would mismatch (defence-in-depth defers to RLS / DB middleware)", async () => {
    // A token whose tenant is supposedly "wrong" should still resolve at the
    // guard layer — the cross-tenant check happens later via RLS once the
    // DB middleware sets app.current_tenant from request.context.tenantId.
    // This test pins the deliberate non-action.
    const request = makeRequest({
      kind: "token",
      tokenId: TOKEN_ID,
      tenantId: OTHER_TENANT_ID,
      userId: USER_ID,
      storeId: null,
      scope: "dashboard_api",
    });
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.context?.tenantId).toBe(OTHER_TENANT_ID);
    expect(memberships.findActiveMembershipCalls).toHaveLength(0);
  });
});
