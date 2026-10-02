/**
 * invitations.service.unit.spec.ts
 *
 * Docker-free unit coverage for InvitationsService (T304-B-api coverage lift).
 *
 * Strategy:
 *   - Construct InvitationsService with a fake TxRunner injected via the
 *     `@Optional() tx` constructor parameter. The fake tx calls
 *     `work(fakeClient)` directly, bypassing `runWithTenantContext`.
 *   - Mock InvitationsRepository with per-test jest.fn() overrides.
 *   - Mock EmailJobEnqueuer with jest.fn().
 *   - Mock `drizzle-orm/node-postgres` so the module-level `getRoleCode`
 *     helper (which calls `drizzle(client)` directly) resolves deterministically.
 *   - Mock `@data-pulse-2/auth` (generateRawToken, hashToken) and
 *     `@data-pulse-2/shared` (newId) for determinism.
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit mocks.
 * The fake TxRunner bypasses `runWithTenantContext` and the fake DB resolves
 * whatever rows are seeded — RLS is a DB-layer guarantee tested only with a
 * real Postgres instance (Testcontainers integration spec).
 */

import "reflect-metadata";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE any imports that exercise them
// ---------------------------------------------------------------------------

// Seed controls for the getRoleCode Drizzle chain
let _roleCodeRows: Array<{ code: string }> = [];

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => makeGetRoleCodeFakeDb()),
}));

function makeGetRoleCodeFakeDb() {
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: (_n: number) => Promise.resolve(_roleCodeRows),
  };
  return chain;
}

jest.mock("@data-pulse-2/auth", () => ({
  generateRawToken: jest.fn(),
  hashToken: jest.fn(),
  verifyPassword: jest.fn(),
  hashPassword: jest.fn(),
}));

jest.mock("@data-pulse-2/shared", () => ({
  // RT-125: real queue names (read at module load by queue producers).
  QUEUE_NAMES: jest.requireActual("@data-pulse-2/shared").QUEUE_NAMES,
  newId: jest.fn(),
  assertMetricLabels: jest.fn(),
  getMeter: jest.fn(() => ({
    createCounter: jest.fn(() => ({ add: jest.fn() })),
    createHistogram: jest.fn(() => ({ record: jest.fn() })),
    createObservableGauge: jest.fn(() => ({ addCallback: jest.fn(), removeCallback: jest.fn() })),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { InvitationsService } from "../../src/memberships/invitations.service";
import type { InvitationsRepository } from "../../src/memberships/invitations.repository";
import type { EmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";
import type { InvitationRow, UserRow } from "@data-pulse-2/db/schema";
import type { ResolvedContext } from "../../src/context/types";
import type { MembershipDetail } from "../../src/context/membership.repository";

import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { newId } from "@data-pulse-2/shared";

const mockGenerateRawToken = generateRawToken as jest.MockedFunction<typeof generateRawToken>;
const mockHashToken = hashToken as jest.MockedFunction<typeof hashToken>;
const mockNewId = newId as jest.MockedFunction<typeof newId>;

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const TENANT_ID     = "0193c000-0000-7000-8000-0000000000a1";
const INVITATION_ID = "0193c000-0000-7000-8000-000000000001";
const ROLE_ID       = "0193c000-0000-7000-8000-000000000002";
const USER_ID       = "0193c000-0000-7000-8000-000000000003";
const MEMBERSHIP_ID = "0193c000-0000-7000-8000-000000000004";
const STORE_ID_1    = "0193c000-0000-7000-8000-000000000010";
const STORE_ID_2    = "0193c000-0000-7000-8000-000000000011";
const ROLE_CODE     = "tenant_admin";
const RAW_TOKEN     = "raw-token-abc-123";
const TOKEN_HASH    = Buffer.from("fake-token-hash-32-bytes-padding!!");
const NORMALIZED_EMAIL = "user@example.com";

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function makeInvitationRow(overrides: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: INVITATION_ID,
    tenantId: TENANT_ID,
    email: NORMALIZED_EMAIL,
    roleId: ROLE_ID,
    storeAccessKind: "all",
    invitedStoreIds: [],
    invitedByUserId: USER_ID,
    tokenHash: TOKEN_HASH,
    status: "pending",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    acceptedByUserId: null,
    acceptedAt: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as InvitationRow;
}

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: USER_ID,
    email: NORMALIZED_EMAIL,
    emailVerifiedAt: null,
    passwordHash: null,
    displayName: "Test User",
    isPlatformAdmin: false,
    clerkUserId: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as UserRow;
}

// ---------------------------------------------------------------------------
// Fake repository — jest.fn() fields, overridden per-test
// ---------------------------------------------------------------------------

function makeFakeRepo(): jest.Mocked<InvitationsRepository> {
  return {
    findRoleId:          jest.fn(),
    findInvalidStoreIds: jest.fn(),
    autoExpireStale:     jest.fn(),
    findPendingByEmail:  jest.fn(),
    create:              jest.fn(),
    findByTokenHash:     jest.fn(),
    findUserByEmail:     jest.fn(),
    markAccepted:        jest.fn(),
    createMembership:    jest.fn(),
    insertStoreAccessRows: jest.fn(),
  } as jest.Mocked<InvitationsRepository>;
}

// ---------------------------------------------------------------------------
// Fake email enqueuer
// ---------------------------------------------------------------------------

function makeFakeEnqueuer(): jest.Mocked<EmailJobEnqueuer> {
  return {
    enqueueInvitation:        jest.fn().mockResolvedValue(undefined),
    enqueuePasswordReset:     jest.fn().mockResolvedValue(undefined),
    enqueueEmailVerification: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<EmailJobEnqueuer>;
}

// ---------------------------------------------------------------------------
// TxRunner fake — synchronously calls work(fakeClient)
// ---------------------------------------------------------------------------

const fakeClient = {} as PoolClient;
const fakePool   = {} as Pool;

function makeFakeTx() {
  return jest.fn(
    async <T>(
      _pool: Pool,
      _ctx: unknown,
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => work(fakeClient),
  );
}

// ---------------------------------------------------------------------------
// Helper: build service with defaults
// ---------------------------------------------------------------------------

interface BuildServiceOpts {
  repo?:     jest.Mocked<InvitationsRepository>;
  enqueuer?: jest.Mocked<EmailJobEnqueuer>;
  tx?:       ReturnType<typeof makeFakeTx>;
}

function buildService(opts: BuildServiceOpts = {}) {
  const repo     = opts.repo     ?? makeFakeRepo();
  const enqueuer = opts.enqueuer ?? makeFakeEnqueuer();
  const tx       = opts.tx       ?? makeFakeTx();

  // InvitationsService(pool, invitations, emailEnqueuer, tx?)
  const service = new InvitationsService(
    fakePool,
    repo as unknown as InvitationsRepository,
    enqueuer,
    tx as unknown as NonNullable<ConstructorParameters<typeof InvitationsService>[3]>,
  );

  return { service, repo, enqueuer, tx };
}

// ---------------------------------------------------------------------------
// Fixed ResolvedContext builder
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset shared state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _roleCodeRows = [{ code: ROLE_CODE }];
  mockGenerateRawToken.mockReturnValue(RAW_TOKEN);
  mockHashToken.mockReturnValue(TOKEN_HASH);
  mockNewId.mockReturnValue(INVITATION_ID);

  const { drizzle } = jest.requireMock("drizzle-orm/node-postgres") as {
    drizzle: jest.Mock;
  };
  drizzle.mockImplementation(() => makeGetRoleCodeFakeDb());
});

// ===========================================================================
// A. invite() — authorization branching
// ===========================================================================

describe("InvitationsService.invite — authorization", () => {
  it("A1: ctx.userId is null → UnauthorizedException", async () => {
    const { service } = buildService();
    const ctx = makeCtx({ userId: null });

    await expect(
      service.invite(ctx, {
        email: NORMALIZED_EMAIL,
        role_code: ROLE_CODE,
        store_access_kind: "all",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ===========================================================================
// B. invite() — role_code validation
// ===========================================================================

describe("InvitationsService.invite — role_code validation", () => {
  it("B1: role_code === 'platform_admin' → BadRequestException (before any repo call)", async () => {
    const { service, repo } = buildService();
    const ctx = makeCtx();

    await expect(
      service.invite(ctx, {
        email: NORMALIZED_EMAIL,
        role_code: "platform_admin",
        store_access_kind: "all",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repo.findRoleId).not.toHaveBeenCalled();
  });

  it("B2: findRoleId returns null → BadRequestException('Unknown role_code')", async () => {
    const { service, repo } = buildService();
    repo.findRoleId.mockResolvedValue(null);
    const ctx = makeCtx();

    const err = await service
      .invite(ctx, {
        email: NORMALIZED_EMAIL,
        role_code: "nonexistent_role",
        store_access_kind: "all",
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain("Unknown role_code");
  });

  it("B3: findRoleId returns valid id → proceeds to store validation", async () => {
    const { service, repo, enqueuer } = buildService();
    repo.findRoleId.mockResolvedValue(ROLE_ID);
    repo.findInvalidStoreIds.mockResolvedValue([]);
    repo.autoExpireStale.mockResolvedValue(undefined);
    repo.findPendingByEmail.mockResolvedValue(false);
    repo.create.mockResolvedValue(makeInvitationRow());
    const ctx = makeCtx();

    const result = await service.invite(ctx, {
      email: NORMALIZED_EMAIL,
      role_code: ROLE_CODE,
      store_access_kind: "all",
    });

    expect(result).toBeDefined();
    expect(enqueuer.enqueueInvitation).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// C. invite() — store validation branching
// ===========================================================================

describe("InvitationsService.invite — store validation", () => {
  it("C1: store_ids empty/undefined → findInvalidStoreIds NOT called", async () => {
    const { service, repo, enqueuer } = buildService();
    repo.findRoleId.mockResolvedValue(ROLE_ID);
    repo.autoExpireStale.mockResolvedValue(undefined);
    repo.findPendingByEmail.mockResolvedValue(false);
    repo.create.mockResolvedValue(makeInvitationRow());
    const ctx = makeCtx();

    await service.invite(ctx, {
      email: NORMALIZED_EMAIL,
      role_code: ROLE_CODE,
      store_access_kind: "all",
    });

    expect(repo.findInvalidStoreIds).not.toHaveBeenCalled();
    expect(enqueuer.enqueueInvitation).toHaveBeenCalledTimes(1);
  });

  it("C2: store_ids non-empty with invalid ids → BadRequestException listing them", async () => {
    const { service, repo } = buildService();
    repo.findRoleId.mockResolvedValue(ROLE_ID);
    repo.findInvalidStoreIds.mockResolvedValue([STORE_ID_2]);
    const ctx = makeCtx();

    const err = await service
      .invite(ctx, {
        email: NORMALIZED_EMAIL,
        role_code: ROLE_CODE,
        store_access_kind: "specific",
        store_ids: [STORE_ID_1, STORE_ID_2],
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain(STORE_ID_2);
  });

  it("C3: store_ids non-empty all valid → proceeds; findInvalidStoreIds called with those ids", async () => {
    const { service, repo, enqueuer } = buildService();
    repo.findRoleId.mockResolvedValue(ROLE_ID);
    repo.findInvalidStoreIds.mockResolvedValue([]);
    repo.autoExpireStale.mockResolvedValue(undefined);
    repo.findPendingByEmail.mockResolvedValue(false);
    repo.create.mockResolvedValue(makeInvitationRow({ storeAccessKind: "specific", invitedStoreIds: [STORE_ID_1] }));
    const ctx = makeCtx();

    await service.invite(ctx, {
      email: NORMALIZED_EMAIL,
      role_code: ROLE_CODE,
      store_access_kind: "specific",
      store_ids: [STORE_ID_1],
    });

    expect(repo.findInvalidStoreIds).toHaveBeenCalledWith(
      fakeClient,
      TENANT_ID,
      [STORE_ID_1],
    );
    expect(enqueuer.enqueueInvitation).toHaveBeenCalledTimes(1);
  });

  it("C4: duplicate store_ids are deduped before create", async () => {
    const { service, repo, enqueuer } = buildService();
    repo.findRoleId.mockResolvedValue(ROLE_ID);
    repo.findInvalidStoreIds.mockResolvedValue([]);
    repo.autoExpireStale.mockResolvedValue(undefined);
    repo.findPendingByEmail.mockResolvedValue(false);
    repo.create.mockResolvedValue(makeInvitationRow({ storeAccessKind: "specific", invitedStoreIds: [STORE_ID_1] }));
    const ctx = makeCtx();

    await service.invite(ctx, {
      email: NORMALIZED_EMAIL,
      role_code: ROLE_CODE,
      store_access_kind: "specific",
      store_ids: [STORE_ID_1, STORE_ID_1, STORE_ID_1],
    });

    const createCall = repo.create.mock.calls[0]!;
    const params = createCall[1] as { invitedStoreIds: string[] };
    expect(params.invitedStoreIds).toEqual([STORE_ID_1]);
    expect(enqueuer.enqueueInvitation).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// D. invite() — pending-invite conflict check
// ===========================================================================

describe("InvitationsService.invite — pending-invite conflict", () => {
  it("D1: findPendingByEmail returns true → ConflictException", async () => {
    const { service, repo } = buildService();
    repo.findRoleId.mockResolvedValue(ROLE_ID);
    repo.autoExpireStale.mockResolvedValue(undefined);
    repo.findPendingByEmail.mockResolvedValue(true);
    const ctx = makeCtx();

    await expect(
      service.invite(ctx, {
        email: NORMALIZED_EMAIL,
        role_code: ROLE_CODE,
        store_access_kind: "all",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("D2: autoExpireStale is called before findPendingByEmail", async () => {
    const { service, repo } = buildService();
    repo.findRoleId.mockResolvedValue(ROLE_ID);
    repo.autoExpireStale.mockResolvedValue(undefined);
    repo.findPendingByEmail.mockResolvedValue(true);
    const ctx = makeCtx();

    await service.invite(ctx, {
      email: NORMALIZED_EMAIL,
      role_code: ROLE_CODE,
      store_access_kind: "all",
    }).catch(() => null);

    const autoExpireOrder = repo.autoExpireStale.mock.invocationCallOrder[0];
    const findPendingOrder = repo.findPendingByEmail.mock.invocationCallOrder[0];
    expect(autoExpireOrder).toBeLessThan(findPendingOrder!);
  });
});

// ===========================================================================
// E. invite() — happy path
// ===========================================================================

describe("InvitationsService.invite — happy path", () => {
  function setupHappyPath(repo: jest.Mocked<InvitationsRepository>, row?: InvitationRow) {
    repo.findRoleId.mockResolvedValue(ROLE_ID);
    repo.autoExpireStale.mockResolvedValue(undefined);
    repo.findPendingByEmail.mockResolvedValue(false);
    repo.create.mockResolvedValue(row ?? makeInvitationRow());
  }

  it("E1: returns { row, roleCode } on success", async () => {
    const { service, repo } = buildService();
    const row = makeInvitationRow();
    setupHappyPath(repo, row);
    const ctx = makeCtx();

    const result = await service.invite(ctx, {
      email: NORMALIZED_EMAIL,
      role_code: ROLE_CODE,
      store_access_kind: "all",
    });

    expect(result.row).toBe(row);
    expect(result.roleCode).toBe(ROLE_CODE);
  });

  it("E2: result shape has both row and roleCode fields", async () => {
    const { service, repo } = buildService();
    setupHappyPath(repo);
    const ctx = makeCtx();

    const result = await service.invite(ctx, {
      email: NORMALIZED_EMAIL,
      role_code: ROLE_CODE,
      store_access_kind: "all",
    });

    expect(Object.keys(result)).toEqual(expect.arrayContaining(["row", "roleCode"]));
    expect(result.row).toBeDefined();
    expect(typeof result.roleCode).toBe("string");
  });

  it("E3: email is normalized (trim + toLowerCase) before passing to repo", async () => {
    const { service, repo } = buildService();
    setupHappyPath(repo);
    const ctx = makeCtx();

    await service.invite(ctx, {
      email: "  ADMIN@EXAMPLE.COM  ",
      role_code: ROLE_CODE,
      store_access_kind: "all",
    });

    // autoExpireStale + findPendingByEmail + create all receive normalized email
    expect(repo.autoExpireStale).toHaveBeenCalledWith(fakeClient, TENANT_ID, "admin@example.com");
    expect(repo.findPendingByEmail).toHaveBeenCalledWith(fakeClient, TENANT_ID, "admin@example.com");
    const createParams = repo.create.mock.calls[0]![1] as { email: string };
    expect(createParams.email).toBe("admin@example.com");
  });

  it("E4: enqueueInvitation called AFTER create, with normalized email and raw token", async () => {
    const { service, repo, enqueuer } = buildService();
    setupHappyPath(repo);
    const ctx = makeCtx();

    await service.invite(ctx, {
      email: "USER@EXAMPLE.COM",
      role_code: ROLE_CODE,
      store_access_kind: "all",
    });

    expect(enqueuer.enqueueInvitation).toHaveBeenCalledTimes(1);
    expect(enqueuer.enqueueInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        rawToken: RAW_TOKEN,
        tenantId: TENANT_ID,
      }),
    );
    // enqueue must come after create
    const createOrder  = repo.create.mock.invocationCallOrder[0]!;
    const enqueueOrder = enqueuer.enqueueInvitation.mock.invocationCallOrder[0]!;
    expect(enqueueOrder).toBeGreaterThan(createOrder);
  });

  it("E5: enqueueInvitation NOT called when invite throws before create", async () => {
    const { service, repo, enqueuer } = buildService();
    repo.findRoleId.mockResolvedValue(null); // causes BadRequestException
    const ctx = makeCtx();

    await service.invite(ctx, {
      email: NORMALIZED_EMAIL,
      role_code: "bad_role",
      store_access_kind: "all",
    }).catch(() => null);

    expect(enqueuer.enqueueInvitation).not.toHaveBeenCalled();
  });

  it("E6: hashToken is called with the generated rawToken", async () => {
    const { service, repo } = buildService();
    setupHappyPath(repo);
    const ctx = makeCtx();

    await service.invite(ctx, {
      email: NORMALIZED_EMAIL,
      role_code: ROLE_CODE,
      store_access_kind: "all",
    });

    expect(mockHashToken).toHaveBeenCalledWith(RAW_TOKEN);
  });
});

// ===========================================================================
// F. lookupAndValidateAcceptToken()
// ===========================================================================

describe("InvitationsService.lookupAndValidateAcceptToken", () => {
  it("F1: row not found → BadRequestException (opaque message)", async () => {
    const { service, repo } = buildService();
    repo.findByTokenHash.mockResolvedValue(null);

    await expect(
      service.lookupAndValidateAcceptToken(RAW_TOKEN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("F2: row found but status !== 'pending' → BadRequestException", async () => {
    const { service, repo } = buildService();
    repo.findByTokenHash.mockResolvedValue(makeInvitationRow({ status: "accepted" }));

    await expect(
      service.lookupAndValidateAcceptToken(RAW_TOKEN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("F3: row found, pending, but expiresAt <= now → BadRequestException", async () => {
    const { service, repo } = buildService();
    repo.findByTokenHash.mockResolvedValue(
      makeInvitationRow({
        status: "pending",
        expiresAt: new Date(Date.now() - 1000), // already expired
      }),
    );

    await expect(
      service.lookupAndValidateAcceptToken(RAW_TOKEN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("F4: row found, status=pending, expiresAt in future → returns InvitationRow", async () => {
    const { service, repo } = buildService();
    const row = makeInvitationRow({
      status: "pending",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    repo.findByTokenHash.mockResolvedValue(row);

    const result = await service.lookupAndValidateAcceptToken(RAW_TOKEN);

    expect(result).toBe(row);
  });

  it("F5: hashToken is called with the rawToken argument", async () => {
    const { service, repo } = buildService();
    repo.findByTokenHash.mockResolvedValue(null);

    await service.lookupAndValidateAcceptToken(RAW_TOKEN).catch(() => null);

    expect(mockHashToken).toHaveBeenCalledWith(RAW_TOKEN);
  });

  it("F6: opaque error — all invalid-token cases return the same error message", async () => {
    const { service, repo } = buildService();

    const cases: Array<() => void> = [
      () => repo.findByTokenHash.mockResolvedValue(null),
      () => repo.findByTokenHash.mockResolvedValue(makeInvitationRow({ status: "revoked" })),
      () => repo.findByTokenHash.mockResolvedValue(makeInvitationRow({ status: "expired" })),
      () => repo.findByTokenHash.mockResolvedValue(makeInvitationRow({ expiresAt: new Date(0) })),
    ];

    const messages: string[] = [];
    for (const setup of cases) {
      setup();
      const err = await service
        .lookupAndValidateAcceptToken(RAW_TOKEN)
        .catch((e: unknown) => e);
      messages.push((err as BadRequestException).message);
    }

    // All cases produce the same opaque message (no enumeration leak)
    const unique = new Set(messages);
    expect(unique.size).toBe(1);
  });
});

// ===========================================================================
// G. acceptInvitationExistingUser() — user lookup
// ===========================================================================

describe("InvitationsService.acceptInvitationExistingUser — user lookup", () => {
  function setupValidToken(repo: jest.Mocked<InvitationsRepository>, row?: InvitationRow) {
    const invitation = row ?? makeInvitationRow({ status: "pending", expiresAt: new Date(Date.now() + 3_600_000) });
    repo.findByTokenHash.mockResolvedValue(invitation);
    return invitation;
  }

  it("G1: user not found → NotFoundException (invitation left pending)", async () => {
    const { service, repo } = buildService();
    setupValidToken(repo);
    repo.findUserByEmail.mockResolvedValue(null);

    await expect(
      service.acceptInvitationExistingUser(RAW_TOKEN),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("G2: user not found → markAccepted is NOT called (invitation stays pending)", async () => {
    const { service, repo } = buildService();
    setupValidToken(repo);
    repo.findUserByEmail.mockResolvedValue(null);

    await service.acceptInvitationExistingUser(RAW_TOKEN).catch(() => null);

    expect(repo.markAccepted).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// H. acceptInvitationExistingUser() — race-loss on markAccepted
// ===========================================================================

describe("InvitationsService.acceptInvitationExistingUser — markAccepted", () => {
  function setupReadyToAccept(repo: jest.Mocked<InvitationsRepository>, invitationOverrides?: Partial<InvitationRow>) {
    const invitation = makeInvitationRow({
      status: "pending",
      expiresAt: new Date(Date.now() + 3_600_000),
      ...invitationOverrides,
    });
    repo.findByTokenHash.mockResolvedValue(invitation);
    repo.findUserByEmail.mockResolvedValue(makeUserRow());
    return invitation;
  }

  it("H1: markAccepted returns false → BadRequestException (race-lost)", async () => {
    const { service, repo } = buildService();
    setupReadyToAccept(repo);
    repo.markAccepted.mockResolvedValue(false);

    await expect(
      service.acceptInvitationExistingUser(RAW_TOKEN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("H2: markAccepted is called with invitationId and userId", async () => {
    const { service, repo } = buildService();
    setupReadyToAccept(repo);
    repo.markAccepted.mockResolvedValue(false); // not the focus; just stop here

    await service.acceptInvitationExistingUser(RAW_TOKEN).catch(() => null);

    expect(repo.markAccepted).toHaveBeenCalledWith(fakeClient, INVITATION_ID, USER_ID);
  });
});

// ===========================================================================
// I. acceptInvitationExistingUser() — storeAccessKind branching
// ===========================================================================

describe("InvitationsService.acceptInvitationExistingUser — storeAccessKind", () => {
  function setupAcceptPath(repo: jest.Mocked<InvitationsRepository>, invitationOverrides?: Partial<InvitationRow>) {
    const invitation = makeInvitationRow({
      status: "pending",
      expiresAt: new Date(Date.now() + 3_600_000),
      ...invitationOverrides,
    });
    repo.findByTokenHash.mockResolvedValue(invitation);
    repo.findUserByEmail.mockResolvedValue(makeUserRow());
    repo.markAccepted.mockResolvedValue(true);
    repo.createMembership.mockResolvedValue({
      id: MEMBERSHIP_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      roleId: ROLE_ID,
      storeAccessKind: invitation.storeAccessKind,
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as never);
    repo.insertStoreAccessRows.mockResolvedValue(undefined);
    return invitation;
  }

  it("I1: storeAccessKind='all' → insertStoreAccessRows NOT called, accessibleStoreIds=[]", async () => {
    const { service, repo } = buildService();
    setupAcceptPath(repo, { storeAccessKind: "all", invitedStoreIds: [] });

    const result = await service.acceptInvitationExistingUser(RAW_TOKEN);

    expect(repo.insertStoreAccessRows).not.toHaveBeenCalled();
    expect(result.storeAccessKind).toBe("all");
    expect(result.accessibleStoreIds).toEqual([]);
  });

  it("I2: storeAccessKind='specific', non-empty invitedStoreIds → insertStoreAccessRows called", async () => {
    const { service, repo } = buildService();
    // acceptInvitationExistingUser calls newId() once for membershipId
    mockNewId.mockReturnValue(MEMBERSHIP_ID);
    setupAcceptPath(repo, {
      storeAccessKind: "specific",
      invitedStoreIds: [STORE_ID_1, STORE_ID_2],
    });

    const result = await service.acceptInvitationExistingUser(RAW_TOKEN);

    expect(repo.insertStoreAccessRows).toHaveBeenCalledWith(
      fakeClient,
      MEMBERSHIP_ID,
      TENANT_ID,
      [STORE_ID_1, STORE_ID_2],
    );
    expect(result.accessibleStoreIds).toEqual([STORE_ID_1, STORE_ID_2]);
  });

  it("I3: storeAccessKind='specific', empty invitedStoreIds → insertStoreAccessRows NOT called, accessibleStoreIds=[]", async () => {
    const { service, repo } = buildService();
    setupAcceptPath(repo, { storeAccessKind: "specific", invitedStoreIds: [] });

    const result = await service.acceptInvitationExistingUser(RAW_TOKEN);

    expect(repo.insertStoreAccessRows).not.toHaveBeenCalled();
    expect(result.accessibleStoreIds).toEqual([]);
  });

  it("I4: invitedStoreIds not an array → treated as empty, insertStoreAccessRows NOT called", async () => {
    const { service, repo } = buildService();
    setupAcceptPath(repo, {
      storeAccessKind: "specific",
      invitedStoreIds: null as unknown as string[],
    });

    const result = await service.acceptInvitationExistingUser(RAW_TOKEN);

    expect(repo.insertStoreAccessRows).not.toHaveBeenCalled();
    expect(result.accessibleStoreIds).toEqual([]);
  });
});

// ===========================================================================
// J. acceptInvitationExistingUser() — unique violation branching
// ===========================================================================

describe("InvitationsService.acceptInvitationExistingUser — unique violation", () => {
  function setupAcceptBase(repo: jest.Mocked<InvitationsRepository>) {
    const invitation = makeInvitationRow({
      status: "pending",
      expiresAt: new Date(Date.now() + 3_600_000),
      storeAccessKind: "all",
    });
    repo.findByTokenHash.mockResolvedValue(invitation);
    repo.findUserByEmail.mockResolvedValue(makeUserRow());
    repo.markAccepted.mockResolvedValue(true);
    return invitation;
  }

  it("J1: createMembership throws direct {code:'23505',constraint:'memberships_tenant_user_active_uidx'} → ConflictException", async () => {
    const { service, repo } = buildService();
    setupAcceptBase(repo);
    repo.createMembership.mockRejectedValue({
      code: "23505",
      constraint: "memberships_tenant_user_active_uidx",
      message: "duplicate key",
    });

    await expect(
      service.acceptInvitationExistingUser(RAW_TOKEN),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("J2: createMembership throws {code:'23505',message:'...memberships_tenant_user_active_uidx...'} → ConflictException", async () => {
    const { service, repo } = buildService();
    setupAcceptBase(repo);
    repo.createMembership.mockRejectedValue({
      code: "23505",
      message: "duplicate key value violates unique constraint \"memberships_tenant_user_active_uidx\"",
    });

    await expect(
      service.acceptInvitationExistingUser(RAW_TOKEN),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("J3: createMembership throws drizzle-wrapped {cause:{code:'23505',constraint:'memberships_tenant_user_active_uidx'}} → ConflictException", async () => {
    const { service, repo } = buildService();
    setupAcceptBase(repo);
    repo.createMembership.mockRejectedValue({
      message: "DrizzleQueryError",
      cause: {
        code: "23505",
        constraint: "memberships_tenant_user_active_uidx",
      },
    });

    await expect(
      service.acceptInvitationExistingUser(RAW_TOKEN),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("J4: createMembership throws {code:'23505',constraint:'other_constraint'} → rethrown as-is", async () => {
    const { service, repo } = buildService();
    setupAcceptBase(repo);
    const originalError = { code: "23505", constraint: "other_unique_constraint" };
    repo.createMembership.mockRejectedValue(originalError);

    const err = await service.acceptInvitationExistingUser(RAW_TOKEN).catch((e: unknown) => e);

    expect(err).toBe(originalError);
    expect(err).not.toBeInstanceOf(ConflictException);
  });

  it("J5: createMembership throws a random Error → rethrown", async () => {
    const { service, repo } = buildService();
    setupAcceptBase(repo);
    const randomError = new Error("random DB error");
    repo.createMembership.mockRejectedValue(randomError);

    await expect(
      service.acceptInvitationExistingUser(RAW_TOKEN),
    ).rejects.toBe(randomError);
  });

  it("J6: createMembership throws null → rethrown (covers null branch in isUniqueViolation)", async () => {
    const { service, repo } = buildService();
    setupAcceptBase(repo);
    repo.createMembership.mockRejectedValue(null);

    const err = await service.acceptInvitationExistingUser(RAW_TOKEN).catch((e: unknown) => e);
    expect(err).toBeNull();
  });
});

// ===========================================================================
// K. acceptInvitationExistingUser() — MembershipDetail result shape
// ===========================================================================

describe("InvitationsService.acceptInvitationExistingUser — result shape", () => {
  it("K1: returned MembershipDetail contains correct fields and NO tokenHash", async () => {
    const { service, repo } = buildService();
    const invitation = makeInvitationRow({
      status: "pending",
      expiresAt: new Date(Date.now() + 3_600_000),
      storeAccessKind: "all",
      invitedStoreIds: [],
    });
    const user = makeUserRow({ displayName: "Alice" });
    repo.findByTokenHash.mockResolvedValue(invitation);
    repo.findUserByEmail.mockResolvedValue(user);
    repo.markAccepted.mockResolvedValue(true);
    repo.createMembership.mockResolvedValue({
      id: MEMBERSHIP_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      roleId: ROLE_ID,
      storeAccessKind: "all",
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as never);
    mockNewId.mockReturnValue(MEMBERSHIP_ID);
    _roleCodeRows = [{ code: ROLE_CODE }];

    const result: MembershipDetail = await service.acceptInvitationExistingUser(RAW_TOKEN);

    // Shape assertions
    expect(result.membershipId).toBe(MEMBERSHIP_ID);
    expect(result.user.id).toBe(USER_ID);
    expect(result.user.email).toBe(NORMALIZED_EMAIL);
    expect(result.user.displayName).toBe("Alice");
    expect(result.roleCode).toBe(ROLE_CODE);
    expect(result.storeAccessKind).toBe("all");
    expect(result.accessibleStoreIds).toEqual([]);
    expect(result.revokedAt).toBeNull();

    // Ensure tokenHash is not exposed
    expect(Object.keys(result)).not.toContain("tokenHash");
    expect(Object.keys(result)).not.toContain("token_hash");
  });

  it("K2: user.displayName is null when UserRow.displayName is null", async () => {
    const { service, repo } = buildService();
    const invitation = makeInvitationRow({
      status: "pending",
      expiresAt: new Date(Date.now() + 3_600_000),
      storeAccessKind: "all",
    });
    repo.findByTokenHash.mockResolvedValue(invitation);
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ displayName: null }));
    repo.markAccepted.mockResolvedValue(true);
    repo.createMembership.mockResolvedValue({
      id: MEMBERSHIP_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      roleId: ROLE_ID,
      storeAccessKind: "all",
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as never);

    const result = await service.acceptInvitationExistingUser(RAW_TOKEN);

    expect(result.user.displayName).toBeNull();
  });

  it("K3: getRoleCode failure → Error propagates (guards corrupt state)", async () => {
    const { service, repo } = buildService();
    const invitation = makeInvitationRow({
      status: "pending",
      expiresAt: new Date(Date.now() + 3_600_000),
      storeAccessKind: "all",
    });
    repo.findByTokenHash.mockResolvedValue(invitation);
    repo.findUserByEmail.mockResolvedValue(makeUserRow());
    repo.markAccepted.mockResolvedValue(true);
    repo.createMembership.mockResolvedValue({
      id: MEMBERSHIP_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      roleId: ROLE_ID,
      storeAccessKind: "all",
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as never);

    // Seed empty rows so getRoleCode throws "role not found"
    _roleCodeRows = [];

    await expect(
      service.acceptInvitationExistingUser(RAW_TOKEN),
    ).rejects.toThrow(/getRoleCode: role .* not found/);
  });
});
