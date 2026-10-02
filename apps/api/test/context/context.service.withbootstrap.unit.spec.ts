/**
 * context.service.withbootstrap.unit.spec.ts
 *
 * Covers the `withBootstrapCtx` path in ContextService when a real `Pool`
 * is injected (the `runWithTenantContext` branch at lines 391-395).
 *
 * `runWithTenantContext` is mocked so no DB connection is required.
 * The service is constructed with a fake pool to exercise the non-fallback
 * branch of `withBootstrapCtx`.
 */

// Mock must appear before any import that transitively loads @data-pulse-2/db.
jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: jest.fn(
    async (_pool: unknown, _ctx: unknown, fn: (client: unknown) => unknown) => fn({}),
  ),
}));

import "reflect-metadata";

import { NotFoundException } from "@nestjs/common";
import type { Pool } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db";

import type { SessionRepository } from "../../src/auth/session.repository";
import type {
  MembershipRepository,
  MembershipSummary,
} from "../../src/context/membership.repository";
import { ContextService } from "../../src/context/context.service";
import type { Principal } from "../../src/auth/auth.guard";

const USER_ID    = "0c000000-0000-7000-8000-000000000001";
const SESSION_ID = "0c000000-0000-7000-8000-000000000002";
const TENANT_ID  = "0c000000-0000-7000-8000-000000000003";

const fakePool = {} as Pool;

describe("ContextService — withBootstrapCtx pool path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: unknown) => unknown) => fn({}),
    );
  });

  it("switchTenant calls runWithTenantContext when pool is present (covers withBootstrapCtx pool branch)", async () => {
    const fakeMembership = {
      membershipId: "m1",
      storeAccessKind: "all",
    } as unknown as MembershipSummary;

    const fakeSessions = {
      updateActiveContext: jest.fn().mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        activeTenantId: TENANT_ID,
        activeStoreId: null,
        revokedAt: null,
        issuedAt: new Date(),
        lastSeenAt: new Date(),
        absoluteExpiresAt: new Date(Date.now() + 3_600_000),
        userAgent: null,
        ipAtIssue: null,
      }),
    } as unknown as SessionRepository;

    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
      findActiveMembership: jest.fn().mockResolvedValue(fakeMembership),
      listForUser: jest.fn().mockResolvedValue([]),
      findUserSummary: jest.fn().mockResolvedValue({
        id: USER_ID,
        email: "user@example.com",
        displayName: "Test User",
        isPlatformAdmin: false,
      }),
      findTenantSummary: jest.fn().mockResolvedValue(null),
      canAccessStore: jest.fn().mockResolvedValue(true),
    } as unknown as MembershipRepository;

    const service = new ContextService(fakeSessions, fakeMemberships, fakePool);

    const principal: Principal = {
      kind: "session",
      sessionId: SESSION_ID,
      userId: USER_ID,
    };

    // switchTenant is the simplest method that calls withBootstrapCtx
    // when isPlatformAdmin is false and pool is present.
    await expect(
      service.switchTenant(principal, TENANT_ID),
    ).resolves.toBeDefined();

    // runWithTenantContext is called multiple times: once for the membership
    // check and additional times for buildResponse (listForUser, findTenantSummary).
    expect(runWithTenantContext).toHaveBeenCalled();
    expect(fakeMemberships.findActiveMembership).toHaveBeenCalledWith(
      USER_ID,
      TENANT_ID,
      expect.anything(),
    );
  });

  it("withBootstrapCtx propagates NotFoundException when membership not found", async () => {
    const fakeSessions = {} as unknown as SessionRepository;

    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
      findActiveMembership: jest.fn().mockResolvedValue(null),
    } as unknown as MembershipRepository;

    const service = new ContextService(fakeSessions, fakeMemberships, fakePool);

    const principal: Principal = {
      kind: "session",
      sessionId: SESSION_ID,
      userId: USER_ID,
    };

    await expect(
      service.switchTenant(principal, TENANT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(runWithTenantContext).toHaveBeenCalledTimes(1);
  });
});
