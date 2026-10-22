/**
 * tenant-context.guard.unit.spec.ts
 *
 * Docker-free unit coverage for TenantContextGuard.
 *
 * Strategy: construct the guard with jest.fn() stub repositories and NO pool.
 * When pool is absent, withBootstrapCtx() calls work(undefined) directly —
 * a plain passthrough — so runWithTenantContext is never invoked and no
 * real DB connection is needed.
 *
 * Branch coverage note: the runWithTenantContext branch inside withBootstrapCtx
 * (reached only when a real pool is provided) is intentionally NOT covered here.
 * That path is exercised by the Testcontainers integration suite.
 *
 * Tests:
 *   TCG1  — canActivate: no principal → UnauthorizedException
 *   TCG2  — canActivate: principal present → resolves true, attaches context
 *   TCG3  — resolveToken: tenantId === null → UnauthorizedException (RT-149), every bearer scope
 *   TCG4  — resolveToken: tenantId set → isPlatformAdmin false, token source
 *   TCG5  — resolveSession: session not found → UnauthorizedException
 *   TCG6  — resolveSession: session found, activeTenantId null → UnauthorizedException
 *   TCG7  — resolveSession, non-admin, membership found, no store → success, canAccessStore NOT called
 *   TCG8  — resolveSession, non-admin, membership NOT found → NotFoundException
 *   TCG9  — resolveSession, non-admin, membership found, store set, canAccessStore=true → success
 *   TCG10 — resolveSession, non-admin, membership found, store set, canAccessStore=false → NotFoundException
 *   TCG11 — resolveSession, platform admin, no store → success, membership NOT queried
 *   TCG12 — resolveSession, platform admin, store set, canAccessStore=true → success, synthetic membershipId
 *   TCG13 — resolveSession, platform admin, store set, canAccessStore=false → NotFoundException
 *   TCG14 — RT-669: dashboard_api token of a non-active tenant → UnauthorizedException
 *   TCG15 — RT-669: tenant status is read only for dashboard_api tokens (POS scopes unchanged)
 *   TCG16 — RT-669: session non-admin → membership read refuses a non-active tenant (404);
 *           platform admin never consults tenant status (D-a)
 */
import "reflect-metadata";

import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";

import type { Principal } from "../../src/auth/auth.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { MembershipRepository } from "../../src/context/membership.repository";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import type { TenantContextRequest } from "../../src/context/types";

// ---------------------------------------------------------------------------
// Fixed IDs (UUIDv7-ish)
// ---------------------------------------------------------------------------

const SESSION_ID  = "0a000000-0000-7000-8000-0000000ses01";
const USER_ID     = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID   = "0a000000-0000-7000-8000-0000000ten01";
const STORE_ID    = "0a000000-0000-7000-8000-0000000str01";
const TOKEN_ID    = "0a000000-0000-7000-8000-0000000tok01";
const MEMBERSHIP_ID = "0a000000-0000-7000-8000-0000000mem01";

// ---------------------------------------------------------------------------
// Principal factories
// ---------------------------------------------------------------------------

const sessionPrincipal = (): Extract<Principal, { kind: "session" }> => ({
  kind: "session",
  sessionId: SESSION_ID,
  userId: USER_ID,
});

const tokenPrincipal = (tenantId: string | null): Extract<Principal, { kind: "token" }> => ({
  kind: "token",
  tokenId: TOKEN_ID,
  tenantId,
  userId: USER_ID,
  storeId: null,
  scope: "dashboard_api",
});

// ---------------------------------------------------------------------------
// Session row factory
// ---------------------------------------------------------------------------

function makeSession(
  overrides: Partial<{ activeTenantId: string | null; activeStoreId: string | null }> = {},
) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    activeTenantId: TENANT_ID,
    activeStoreId: null as string | null,
    revokedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Guard factory
// ---------------------------------------------------------------------------

function makeGuard(opts: {
  sessionFindActive?: jest.Mock;
  isPlatformAdmin?: jest.Mock;
  findActiveMembership?: jest.Mock;
  canAccessStore?: jest.Mock;
  listGrantedStoreIds?: jest.Mock;
  isTenantActive?: jest.Mock;
  hasLiveMembership?: jest.Mock;
} = {}) {
  const fakeSessions = {
    findActiveById: opts.sessionFindActive ?? jest.fn().mockResolvedValue(null),
  };
  const fakeMemberships = {
    isPlatformAdmin:       opts.isPlatformAdmin       ?? jest.fn().mockResolvedValue(false),
    findActiveMembership:  opts.findActiveMembership  ?? jest.fn().mockResolvedValue(null),
    canAccessStore:        opts.canAccessStore         ?? jest.fn().mockResolvedValue(false),
    listGrantedStoreIds:   opts.listGrantedStoreIds    ?? jest.fn().mockResolvedValue([]),
    isTenantActive:        opts.isTenantActive         ?? jest.fn().mockResolvedValue(true),
    // RT-414: platform admins here are members unless a test says otherwise.
    hasLiveMembership:     opts.hasLiveMembership      ?? jest.fn().mockResolvedValue(true),
  };
  const guard = new TenantContextGuard(
    fakeSessions as unknown as SessionRepository,
    fakeMemberships as unknown as MembershipRepository,
    // NO pool → withBootstrapCtx uses the passthrough (unit-test) path
  );
  return { guard, fakeSessions, fakeMemberships };
}

// ---------------------------------------------------------------------------
// ExecutionContext factory
// ---------------------------------------------------------------------------

function makeExecCtx(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as unknown as T,
    }),
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// TCG1 — canActivate: no principal → UnauthorizedException
// ---------------------------------------------------------------------------

describe("TCG1 — canActivate: no principal", () => {
  it("throws UnauthorizedException and leaves request.context untouched", async () => {
    const { guard } = makeGuard();
    const request: Partial<TenantContextRequest> = {}; // no .principal
    await expect(guard.canActivate(makeExecCtx(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect((request as TenantContextRequest).context).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TCG2 — canActivate: principal present → resolves true, attaches context
// ---------------------------------------------------------------------------

describe("TCG2 — canActivate: principal present", () => {
  it("returns true and attaches request.context for a token principal", async () => {
    const { guard } = makeGuard();
    const request: Partial<TenantContextRequest> & { principal: Principal } = {
      principal: tokenPrincipal(TENANT_ID),
    };
    const result = await guard.canActivate(makeExecCtx(request));
    expect(result).toBe(true);
    expect((request as TenantContextRequest).context).toBeDefined();
    expect((request as TenantContextRequest).context!.source).toBe("token");
  });
});

// ---------------------------------------------------------------------------
// TCG3 — resolveToken: tenantId === null → fail closed (RT-149 / RT-132 D6)
// ---------------------------------------------------------------------------

describe("TCG3 — resolveToken: null tenantId", () => {
  for (const scope of ["dashboard_api", "pos", "pos_operator", "connector"] as const) {
    it(`${scope}: rejects with UnauthorizedException — never resolves a platform-admin context`, async () => {
      const { guard } = makeGuard();
      await expect(
        guard.resolve({ ...tokenPrincipal(null), scope }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  }
});

// ---------------------------------------------------------------------------
// TCG4 — resolveToken: tenantId set → non-admin, token source
// ---------------------------------------------------------------------------

describe("TCG4 — resolveToken: tenantId set", () => {
  it("resolves to isPlatformAdmin=false with tenantId, source=token", async () => {
    const { guard } = makeGuard();
    const ctx = await guard.resolve(tokenPrincipal(TENANT_ID));
    expect(ctx).toEqual({
      userId: USER_ID,
      tenantId: TENANT_ID,
      storeId: null,
      isPlatformAdmin: false,
      source: "token",
    });
  });
});

// ---------------------------------------------------------------------------
// TCG5 — resolveSession: session not found → UnauthorizedException
// ---------------------------------------------------------------------------

describe("TCG5 — resolveSession: session not found", () => {
  it("throws UnauthorizedException when findActiveById returns null", async () => {
    const { guard } = makeGuard({
      sessionFindActive: jest.fn().mockResolvedValue(null),
    });
    await expect(guard.resolve(sessionPrincipal())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

// ---------------------------------------------------------------------------
// TCG6 — resolveSession: session found but activeTenantId is null → 401
// ---------------------------------------------------------------------------

describe("TCG6 — resolveSession: activeTenantId null", () => {
  it("throws UnauthorizedException when session has no activeTenantId", async () => {
    const { guard } = makeGuard({
      sessionFindActive: jest.fn().mockResolvedValue(makeSession({ activeTenantId: null })),
    });
    await expect(guard.resolve(sessionPrincipal())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

// ---------------------------------------------------------------------------
// TCG7 — non-admin, membership found, no active store → success, canAccessStore NOT called
// ---------------------------------------------------------------------------

describe("TCG7 — non-admin: membership found, no store", () => {
  it("resolves to storeId=null and does NOT call canAccessStore", async () => {
    const canAccessStore = jest.fn().mockResolvedValue(true);
    const { guard, fakeMemberships } = makeGuard({
      sessionFindActive: jest.fn().mockResolvedValue(makeSession({ activeStoreId: null })),
      isPlatformAdmin:   jest.fn().mockResolvedValue(false),
      findActiveMembership: jest.fn().mockResolvedValue({
        membershipId: MEMBERSHIP_ID,
        storeAccessKind: "all",
      }),
      canAccessStore,
    });

    const ctx = await guard.resolve(sessionPrincipal());
    expect(ctx).toEqual({
      userId: USER_ID,
      tenantId: TENANT_ID,
      storeId: null,
      isPlatformAdmin: false,
      source: "session",
      storeAccess: { kind: "all" },
    });
    expect(fakeMemberships.findActiveMembership).toHaveBeenCalledTimes(1);
    expect(canAccessStore).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TCG8 — non-admin, membership NOT found → NotFoundException
// ---------------------------------------------------------------------------

describe("TCG8 — non-admin: membership not found", () => {
  it("throws NotFoundException (FR-ISO-4) when membership is absent", async () => {
    const { guard } = makeGuard({
      sessionFindActive:    jest.fn().mockResolvedValue(makeSession()),
      isPlatformAdmin:      jest.fn().mockResolvedValue(false),
      findActiveMembership: jest.fn().mockResolvedValue(null),
    });
    await expect(guard.resolve(sessionPrincipal())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// TCG9 — non-admin, membership found, store set, canAccessStore=true → success
// ---------------------------------------------------------------------------

describe("TCG9 — non-admin: membership found, store set, access granted", () => {
  it("resolves with storeId and calls canAccessStore with correct args", async () => {
    const canAccessStore = jest.fn().mockResolvedValue(true);
    const { guard } = makeGuard({
      sessionFindActive: jest.fn().mockResolvedValue(makeSession({ activeStoreId: STORE_ID })),
      isPlatformAdmin:   jest.fn().mockResolvedValue(false),
      findActiveMembership: jest.fn().mockResolvedValue({
        membershipId: MEMBERSHIP_ID,
        storeAccessKind: "specific",
      }),
      canAccessStore,
    });

    const ctx = await guard.resolve(sessionPrincipal());
    expect(ctx.storeId).toBe(STORE_ID);
    expect(ctx.isPlatformAdmin).toBe(false);
    expect(ctx.source).toBe("session");
    expect(canAccessStore).toHaveBeenCalledWith(
      MEMBERSHIP_ID,
      TENANT_ID,
      STORE_ID,
      "specific",
      undefined, // client is undefined in unit-test path
    );
    // RT-131: the 'specific' membership's grants are published as store access.
    expect(ctx.storeAccess).toEqual({ kind: "specific", storeIds: [] });
  });
});

// ---------------------------------------------------------------------------
// TCG10 — non-admin, membership found, store set, canAccessStore=false → 404
// ---------------------------------------------------------------------------

describe("TCG10 — non-admin: membership found, store set, access denied", () => {
  it("throws NotFoundException when canAccessStore returns false", async () => {
    const { guard } = makeGuard({
      sessionFindActive: jest.fn().mockResolvedValue(makeSession({ activeStoreId: STORE_ID })),
      isPlatformAdmin:   jest.fn().mockResolvedValue(false),
      findActiveMembership: jest.fn().mockResolvedValue({
        membershipId: MEMBERSHIP_ID,
        storeAccessKind: "all",
      }),
      canAccessStore: jest.fn().mockResolvedValue(false),
    });
    await expect(guard.resolve(sessionPrincipal())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// TCG11 — platform admin, no store → success, membership NOT queried
// ---------------------------------------------------------------------------

describe("TCG11 — platform admin: no store", () => {
  it("bypasses membership check and resolves with isPlatformAdmin=true", async () => {
    const findActiveMembership = jest.fn().mockResolvedValue(null);
    const canAccessStore = jest.fn().mockResolvedValue(false);
    const { guard } = makeGuard({
      sessionFindActive:    jest.fn().mockResolvedValue(makeSession({ activeStoreId: null })),
      isPlatformAdmin:      jest.fn().mockResolvedValue(true),
      findActiveMembership,
      canAccessStore,
    });

    const ctx = await guard.resolve(sessionPrincipal());
    expect(ctx).toEqual({
      userId: USER_ID,
      tenantId: TENANT_ID,
      storeId: null,
      isPlatformAdmin: true,
      source: "session",
      storeAccess: { kind: "all" },
    });
    expect(findActiveMembership).not.toHaveBeenCalled();
    expect(canAccessStore).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TCG11b — RT-414: a NON-member platform admin needs a support session; with
// no pool the guard cannot check one, so it fails closed.
// ---------------------------------------------------------------------------

describe("TCG11b — RT-414: non-member platform admin without a pool", () => {
  it("refuses with 403 support_session_required and never validates the store", async () => {
    const canAccessStore = jest.fn().mockResolvedValue(true);
    const { guard } = makeGuard({
      sessionFindActive: jest.fn().mockResolvedValue(makeSession({ activeStoreId: STORE_ID })),
      isPlatformAdmin:   jest.fn().mockResolvedValue(true),
      hasLiveMembership: jest.fn().mockResolvedValue(false),
      canAccessStore,
    });

    await expect(guard.resolve(sessionPrincipal())).rejects.toMatchObject({
      status: 403,
      response: { code: "support_session_required" },
    });
    expect(canAccessStore).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TCG12 — platform admin, store set, canAccessStore=true → success, synthetic membershipId
// ---------------------------------------------------------------------------

describe("TCG12 — platform admin: store set, access granted", () => {
  it("calls canAccessStore with synthetic membershipId '00000000-...' and kind='all'", async () => {
    const SYNTHETIC_ID = "00000000-0000-0000-0000-000000000000";
    const canAccessStore = jest.fn().mockResolvedValue(true);
    const findActiveMembership = jest.fn();
    const { guard } = makeGuard({
      sessionFindActive:    jest.fn().mockResolvedValue(makeSession({ activeStoreId: STORE_ID })),
      isPlatformAdmin:      jest.fn().mockResolvedValue(true),
      findActiveMembership,
      canAccessStore,
    });

    const ctx = await guard.resolve(sessionPrincipal());
    expect(ctx.storeId).toBe(STORE_ID);
    expect(ctx.isPlatformAdmin).toBe(true);
    expect(findActiveMembership).not.toHaveBeenCalled();
    expect(canAccessStore).toHaveBeenCalledWith(
      SYNTHETIC_ID,
      TENANT_ID,
      STORE_ID,
      "all",
      undefined, // client is undefined in unit-test path
    );
  });
});

// ---------------------------------------------------------------------------
// TCG13 — platform admin, store set, canAccessStore=false → NotFoundException
// ---------------------------------------------------------------------------

describe("TCG13 — platform admin: store set, access denied", () => {
  it("throws NotFoundException when canAccessStore returns false for admin", async () => {
    const { guard } = makeGuard({
      sessionFindActive: jest.fn().mockResolvedValue(makeSession({ activeStoreId: STORE_ID })),
      isPlatformAdmin:   jest.fn().mockResolvedValue(true),
      canAccessStore:    jest.fn().mockResolvedValue(false),
    });
    await expect(guard.resolve(sessionPrincipal())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// TCG14 — RT-669: dashboard_api token of a non-active tenant → 401
// ---------------------------------------------------------------------------

describe("TCG14 — RT-669: dashboard_api token, tenant not active", () => {
  it("rejects with the same UnauthorizedException as an invalid token", async () => {
    const isTenantActive = jest.fn().mockResolvedValue(false);
    const { guard } = makeGuard({ isTenantActive });
    const err = await guard.resolve(tokenPrincipal(TENANT_ID)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toEqual(
      new UnauthorizedException("Unauthorized").getResponse(),
    );
    expect(isTenantActive).toHaveBeenCalledWith(TENANT_ID, undefined);
  });

  it("canActivate: does not attach a context", async () => {
    const { guard } = makeGuard({ isTenantActive: jest.fn().mockResolvedValue(false) });
    const request: Partial<TenantContextRequest> & { principal: Principal } = {
      principal: tokenPrincipal(TENANT_ID),
    };
    await expect(guard.canActivate(makeExecCtx(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect((request as TenantContextRequest).context).toBeUndefined();
  });

  it("an active tenant still resolves (and the tenant is read)", async () => {
    const isTenantActive = jest.fn().mockResolvedValue(true);
    const { guard } = makeGuard({ isTenantActive });
    const ctx = await guard.resolve(tokenPrincipal(TENANT_ID));
    expect(ctx.tenantId).toBe(TENANT_ID);
    expect(isTenantActive).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TCG15 — RT-669: only dashboard_api tokens read tenant status here
// ---------------------------------------------------------------------------

describe("TCG15 — RT-669: POS / connector token scopes are unchanged", () => {
  // POS scopes are refused for non-active tenants on the device path
  // (RT-213); this guard's token branch stays as it was for them.
  for (const scope of ["pos", "pos_operator", "connector"] as const) {
    it(`${scope}: resolves without reading tenant status`, async () => {
      const isTenantActive = jest.fn().mockResolvedValue(false);
      const { guard } = makeGuard({ isTenantActive });
      const ctx = await guard.resolve({ ...tokenPrincipal(TENANT_ID), scope });
      expect(ctx.source).toBe("token");
      expect(isTenantActive).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// TCG16 — RT-669: session branch
// ---------------------------------------------------------------------------

describe("TCG16 — RT-669: session branch", () => {
  it("non-admin: a non-active tenant reads as no membership → NotFoundException", async () => {
    // The tenant-active predicate lives in findActiveMembership's SQL
    // (membership.repository.tenant-status.unit.spec.ts): it returns null.
    const isTenantActive = jest.fn();
    const { guard } = makeGuard({
      sessionFindActive: jest.fn().mockResolvedValue(makeSession()),
      findActiveMembership: jest.fn().mockResolvedValue(null),
      isTenantActive,
    });
    await expect(guard.resolve(sessionPrincipal())).rejects.toBeInstanceOf(NotFoundException);
    expect(isTenantActive).not.toHaveBeenCalled();
  });

  it("platform admin (D-a): tenant status is never consulted", async () => {
    const isTenantActive = jest.fn().mockResolvedValue(false);
    const { guard } = makeGuard({
      sessionFindActive: jest.fn().mockResolvedValue(makeSession()),
      isPlatformAdmin: jest.fn().mockResolvedValue(true),
      isTenantActive,
    });
    const ctx = await guard.resolve(sessionPrincipal());
    expect(ctx.isPlatformAdmin).toBe(true);
    expect(isTenantActive).not.toHaveBeenCalled();
  });
});
