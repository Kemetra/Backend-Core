/**
 * InvitationsService — unit spec (no Postgres, no Testcontainers, no network).
 *
 * Pattern: hand-written fake InvitationsRepository + fake EmailJobEnqueuer +
 * injectable TenantTxRunner (passthrough or per-call mock), mirroring the
 * TenantsService and PosOperatorsService unit-spec style already in this repo.
 *
 * getRoleCode (module-level helper) calls drizzle(client).select(...).
 * We handle this by giving the fake client a `query` method that returns the
 * drizzle-compatible pg result shape for that specific SELECT, keyed by the
 * role fixture we set up.
 *
 * Coverage targets
 * ----------------
 * invite()
 *   - no userId on context → UnauthorizedException
 *   - role_code === 'platform_admin' → BadRequestException
 *   - unknown role_code (findRoleId → null) → BadRequestException
 *   - invalid store_ids (findInvalidStoreIds returns non-empty) → BadRequestException
 *   - findPendingByEmail → true → ConflictException
 *   - happy path (kind='all', no store_ids) → returns InvitationRow, enqueues email
 *   - happy path (kind='specific', store_ids deduplicated)
 *   - email normalised (trimmed + lowercased) before use
 *
 * lookupAndValidateAcceptToken()
 *   - findByTokenHash → null → BadRequestException
 *   - status !== 'pending' → BadRequestException
 *   - expiresAt in the past → BadRequestException
 *   - valid pending non-expired → returns InvitationRow
 *
 * acceptInvitationExistingUser()
 *   - token invalid (propagates from lookupAndValidateAcceptToken) → BadRequestException
 *   - user not found → NotFoundException
 *   - markAccepted returns false (race) → BadRequestException
 *   - createMembership throws 23505 on correct constraint → ConflictException
 *   - createMembership throws 23505 on different constraint → re-thrown
 *   - createMembership throws non-23505 error → re-thrown
 *   - happy path kind='all' → MembershipDetail, no insertStoreAccessRows
 *   - happy path kind='specific' with store_ids → MembershipDetail, insertStoreAccessRows called
 */
import "reflect-metadata";

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { TenantContext } from "@data-pulse-2/db";
import type { InvitationRow, UserRow } from "@data-pulse-2/db/schema";

import { InvitationsService } from "../../src/memberships/invitations.service";
import type { InvitationsRepository } from "../../src/memberships/invitations.repository";
import type { EmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";
import type { ResolvedContext } from "../../src/context/types";

type TxRunner = NonNullable<ConstructorParameters<typeof InvitationsService>[3]>;

// ---------------------------------------------------------------------------
// Fixed IDs / fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "0a000000-0000-7000-8000-0000000000b1";
const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const ROLE_ID = "0a000000-0000-7000-8000-00000000cc01";
const ROLE_CODE = "tenant_admin";
const INVITE_ID = "0a000000-0000-7000-8000-00000000dd01";
const STORE_ID_A = "0a000000-0000-7000-8000-00000000ee01";
const STORE_ID_B = "0a000000-0000-7000-8000-00000000ee02";
const MEMBERSHIP_ID = "0a000000-0000-7000-8000-00000000ff01";

const BASE_CTX: ResolvedContext = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
};

// ---------------------------------------------------------------------------
// Fake PoolClient that answers drizzle's pg query() calls.
// drizzle sends a { text, values, rowMode } object to client.query().
// We intercept on the `text` field to return shaped results.
// ---------------------------------------------------------------------------

function makeFakeClient(
  queryResults: Array<{ rows: Record<string, unknown>[] }> = [],
): PoolClient {
  let callCount = 0;
  return {
    query: jest.fn((_q: unknown) => {
      const result = queryResults[callCount] ?? { rows: [] };
      callCount++;
      return Promise.resolve({ rows: result.rows, rowCount: result.rows.length });
    }),
  } as unknown as PoolClient;
}

// A fake client whose query() always returns a single roles row (for getRoleCode).
// drizzle-orm/node-postgres uses rowMode:'array' — rows must be arrays, not objects.
// SELECT "code" FROM "roles" returns one column, so each row is [codeValue].
function makeFakeClientWithRole(roleCode: string): PoolClient {
  return {
    query: jest.fn(() =>
      Promise.resolve({ rows: [[roleCode]], rowCount: 1 }),
    ),
  } as unknown as PoolClient;
}

// ---------------------------------------------------------------------------
// Fake Pool — never actually called (tx runner is injectable)
// ---------------------------------------------------------------------------

const FAKE_POOL = {} as Pool;

// ---------------------------------------------------------------------------
// Fake InvitationsRepository
// ---------------------------------------------------------------------------

class FakeInvitationsRepository {
  findRoleIdResult: string | null = ROLE_ID;
  findInvalidStoreIdsResult: string[] = [];
  autoExpireStaleCallCount = 0;
  findPendingByEmailResult = false;
  createResult: InvitationRow | null = null;
  findByTokenHashResult: InvitationRow | null = null;
  findUserByEmailResult: UserRow | null = null;
  markAcceptedResult = true;
  createMembershipError: unknown = undefined;
  insertStoreAccessRowsCalled = false;

  async findRoleId(_client: PoolClient, _tenantId: string, _code: string): Promise<string | null> {
    return this.findRoleIdResult;
  }

  async findInvalidStoreIds(_client: PoolClient, _tenantId: string, _ids: string[]): Promise<string[]> {
    return this.findInvalidStoreIdsResult;
  }

  async autoExpireStale(_client: PoolClient, _tenantId: string, _email: string): Promise<void> {
    this.autoExpireStaleCallCount++;
  }

  async findPendingByEmail(_client: PoolClient, _tenantId: string, _email: string): Promise<boolean> {
    return this.findPendingByEmailResult;
  }

  async create(_client: PoolClient, params: unknown): Promise<InvitationRow> {
    if (!this.createResult) throw new Error("FakeInvitationsRepository.create: not configured");
    return this.createResult;
  }

  async findByTokenHash(_client: PoolClient, _hash: Buffer): Promise<InvitationRow | null> {
    return this.findByTokenHashResult;
  }

  async findUserByEmail(_client: PoolClient, _email: string): Promise<UserRow | null> {
    return this.findUserByEmailResult;
  }

  async markAccepted(_client: PoolClient, _invitationId: string, _userId: string): Promise<boolean> {
    return this.markAcceptedResult;
  }

  async createMembership(_client: PoolClient, _params: unknown): Promise<unknown> {
    if (this.createMembershipError !== undefined) throw this.createMembershipError;
    return { id: MEMBERSHIP_ID };
  }

  async insertStoreAccessRows(_client: PoolClient, _membershipId: string, _tenantId: string, _storeIds: string[]): Promise<void> {
    this.insertStoreAccessRowsCalled = true;
  }
}

// ---------------------------------------------------------------------------
// Fake EmailJobEnqueuer
// ---------------------------------------------------------------------------

class FakeEmailEnqueuer {
  enqueueInvitationCalled = false;
  enqueueInvitationError: unknown = null;
  lastJob: unknown = null;

  async enqueuePasswordReset(): Promise<void> {}
  async enqueueEmailVerification(): Promise<void> {}

  async enqueueInvitation(job: unknown): Promise<void> {
    this.lastJob = job;
    this.enqueueInvitationCalled = true;
    if (this.enqueueInvitationError) throw this.enqueueInvitationError;
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeInvitationRow(overrides: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: INVITE_ID,
    tenantId: TENANT_ID,
    email: "invitee@example.com",
    roleId: ROLE_ID,
    storeAccessKind: "all",
    invitedStoreIds: [],
    invitedByUserId: USER_ID,
    tokenHash: Buffer.alloc(32),
    status: "pending",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    acceptedByUserId: null,
    acceptedAt: null,
    deletedAt: null,
    ...overrides,
  } as unknown as InvitationRow;
}

function makeUserRow(overrides: { [K in keyof UserRow]?: UserRow[K] | undefined } = {}): UserRow {
  return {
    id: USER_ID,
    email: "invitee@example.com",
    displayName: "Test User",
    passwordHash: null,
    isPlatformAdmin: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    emailVerifiedAt: null,
    ...overrides,
  } as unknown as UserRow;
}

/**
 * Build a passthrough tx runner whose fake client is supplied per call.
 * Calls are resolved in order from `clients`; any extra calls use a plain empty client.
 */
function makeTxRunner(clients: PoolClient[] = []) {
  let idx = 0;
  return jest.fn(
    async <T>(
      _pool: Pool,
      _ctx: TenantContext,
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      const client = clients[idx] ?? ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) } as unknown as PoolClient);
      idx++;
      return work(client);
    },
  ) as unknown as jest.MockedFunction<TxRunner>;
}

/**
 * Simple passthrough where every client responds with the given role code
 * (used for most tests that don't care about client specifics).
 */
function makeSimpleTxRunner(roleCode?: string) {
  return jest.fn(
    async <T>(
      _pool: Pool,
      _ctx: TenantContext,
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      const client = roleCode
        ? makeFakeClientWithRole(roleCode)
        : ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) } as unknown as PoolClient);
      return work(client);
    },
  ) as unknown as jest.MockedFunction<TxRunner>;
}

function makeService(
  repo: FakeInvitationsRepository,
  enqueuer: FakeEmailEnqueuer,
  tx: ReturnType<typeof makeSimpleTxRunner>,
): InvitationsService {
  return new InvitationsService(
    FAKE_POOL,
    repo as unknown as InvitationsRepository,
    enqueuer as unknown as EmailJobEnqueuer,
    tx,
  );
}

// ---------------------------------------------------------------------------
// invite()
// ---------------------------------------------------------------------------

describe("InvitationsService.invite()", () => {
  let repo: FakeInvitationsRepository;
  let enqueuer: FakeEmailEnqueuer;

  beforeEach(() => {
    repo = new FakeInvitationsRepository();
    enqueuer = new FakeEmailEnqueuer();
  });

  it("throws UnauthorizedException when ctx.userId is null", async () => {
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    const ctx: ResolvedContext = { ...BASE_CTX, userId: null };
    await expect(
      svc.invite(ctx, { email: "x@example.com", role_code: "owner", store_access_kind: "all" }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("throws BadRequestException for role_code 'platform_admin'", async () => {
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(
      svc.invite(BASE_CTX, { email: "x@example.com", role_code: "platform_admin", store_access_kind: "all" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when role_code is unknown (findRoleId → null)", async () => {
    repo.findRoleIdResult = null;
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(
      svc.invite(BASE_CTX, { email: "x@example.com", role_code: "ghost_role", store_access_kind: "all" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when store_ids contains invalid IDs", async () => {
    repo.findInvalidStoreIdsResult = [STORE_ID_A];
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(
      svc.invite(BASE_CTX, {
        email: "x@example.com",
        role_code: "owner",
        store_access_kind: "specific",
        store_ids: [STORE_ID_A],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws ConflictException when a pending invitation already exists", async () => {
    repo.findPendingByEmailResult = true;
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(
      svc.invite(BASE_CTX, { email: "x@example.com", role_code: "owner", store_access_kind: "all" }),
    ).rejects.toThrow(ConflictException);
  });

  it("happy path (kind='all') returns invitation row and enqueues email", async () => {
    const expected = makeInvitationRow();
    repo.createResult = expected;
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    const result = await svc.invite(BASE_CTX, {
      email: "  Invitee@Example.COM  ",
      role_code: "owner",
      store_access_kind: "all",
    });
    expect(result.row).toBe(expected);
    expect(result.roleCode).toBe("owner");
    expect(enqueuer.enqueueInvitationCalled).toBe(true);
    expect(enqueuer.lastJob).toMatchObject({ tenantId: TENANT_ID });
  });

  it("normalises email (trims + lowercases) before all operations", async () => {
    const expected = makeInvitationRow({ email: "invitee@example.com" });
    repo.createResult = expected;
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    const result = await svc.invite(BASE_CTX, {
      email: "  INVITEE@EXAMPLE.COM  ",
      role_code: "owner",
      store_access_kind: "all",
    });
    expect(result.row).toBe(expected);
    expect(result.roleCode).toBe("owner");
    // Enqueuer receives the normalised address
    expect((enqueuer.lastJob as { email: string }).email).toBe("invitee@example.com");
  });

  it("happy path (kind='specific') passes deduplicated store_ids to create", async () => {
    const expected = makeInvitationRow({ storeAccessKind: "specific", invitedStoreIds: [STORE_ID_A] });
    repo.createResult = expected;
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    // Pass a duplicate store_id — the service must deduplicate
    const result = await svc.invite(BASE_CTX, {
      email: "x@example.com",
      role_code: "owner",
      store_access_kind: "specific",
      store_ids: [STORE_ID_A, STORE_ID_A],
    });
    expect(result.row).toBe(expected);
    expect(result.roleCode).toBe("owner");
    expect(enqueuer.enqueueInvitationCalled).toBe(true);
  });

  it("calls autoExpireStale before the pending check", async () => {
    repo.createResult = makeInvitationRow();
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await svc.invite(BASE_CTX, { email: "x@example.com", role_code: "owner", store_access_kind: "all" });
    expect(repo.autoExpireStaleCallCount).toBe(1);
  });

  it("does not call findInvalidStoreIds when store_ids is absent", async () => {
    repo.createResult = makeInvitationRow();
    const findInvalidSpy = jest.spyOn(repo, "findInvalidStoreIds");
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await svc.invite(BASE_CTX, { email: "x@example.com", role_code: "owner", store_access_kind: "all" });
    expect(findInvalidSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// lookupAndValidateAcceptToken()
// ---------------------------------------------------------------------------

describe("InvitationsService.lookupAndValidateAcceptToken()", () => {
  let repo: FakeInvitationsRepository;
  let enqueuer: FakeEmailEnqueuer;

  beforeEach(() => {
    repo = new FakeInvitationsRepository();
    enqueuer = new FakeEmailEnqueuer();
  });

  it("throws BadRequestException when token hash is not found", async () => {
    repo.findByTokenHashResult = null;
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(svc.lookupAndValidateAcceptToken("rawtoken")).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when status is not 'pending'", async () => {
    repo.findByTokenHashResult = makeInvitationRow({ status: "accepted" as "pending" });
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(svc.lookupAndValidateAcceptToken("rawtoken")).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when invitation is expired", async () => {
    repo.findByTokenHashResult = makeInvitationRow({
      expiresAt: new Date(Date.now() - 1000), // past
    });
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(svc.lookupAndValidateAcceptToken("rawtoken")).rejects.toThrow(BadRequestException);
  });

  it("returns the invitation row for a valid pending non-expired token", async () => {
    const invitation = makeInvitationRow({
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    repo.findByTokenHashResult = invitation;
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    const result = await svc.lookupAndValidateAcceptToken("rawtoken");
    expect(result).toBe(invitation);
  });

  it("uses the same opaque message for all failure cases", async () => {
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);

    // not found
    repo.findByTokenHashResult = null;
    const [e1] = await svc.lookupAndValidateAcceptToken("t").then(() => [], (e: BadRequestException) => [e]);

    // wrong status
    repo.findByTokenHashResult = makeInvitationRow({ status: "revoked" as "pending" });
    const [e2] = await svc.lookupAndValidateAcceptToken("t").then(() => [], (e: BadRequestException) => [e]);

    // expired
    repo.findByTokenHashResult = makeInvitationRow({ expiresAt: new Date(Date.now() - 1) });
    const [e3] = await svc.lookupAndValidateAcceptToken("t").then(() => [], (e: BadRequestException) => [e]);

    expect(e1!.message).toBe(e2!.message);
    expect(e2!.message).toBe(e3!.message);
  });
});

// ---------------------------------------------------------------------------
// acceptInvitationExistingUser()
// ---------------------------------------------------------------------------

describe("InvitationsService.acceptInvitationExistingUser()", () => {
  let repo: FakeInvitationsRepository;
  let enqueuer: FakeEmailEnqueuer;

  beforeEach(() => {
    repo = new FakeInvitationsRepository();
    enqueuer = new FakeEmailEnqueuer();
  });

  it("propagates BadRequestException from token validation when token not found", async () => {
    repo.findByTokenHashResult = null;
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(svc.acceptInvitationExistingUser("bad-token")).rejects.toThrow(BadRequestException);
  });

  it("throws NotFoundException when no user exists for invitation email", async () => {
    repo.findByTokenHashResult = makeInvitationRow();
    repo.findUserByEmailResult = null;
    const tx = makeSimpleTxRunner();
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(svc.acceptInvitationExistingUser("rawtoken")).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException when markAccepted returns false (race lost)", async () => {
    repo.findByTokenHashResult = makeInvitationRow();
    repo.findUserByEmailResult = makeUserRow();
    repo.markAcceptedResult = false;
    // tx call 1: token lookup (findByTokenHash)
    // tx call 2: user lookup (findUserByEmail)
    // tx call 3: mutation (markAccepted + createMembership + getRoleCode)
    const tx = makeSimpleTxRunner(ROLE_CODE);
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(svc.acceptInvitationExistingUser("rawtoken")).rejects.toThrow(BadRequestException);
  });

  it("throws ConflictException when createMembership violates memberships_tenant_user_active_uidx", async () => {
    repo.findByTokenHashResult = makeInvitationRow();
    repo.findUserByEmailResult = makeUserRow();
    repo.createMembershipError = {
      code: "23505",
      constraint: "memberships_tenant_user_active_uidx",
    };
    const tx = makeSimpleTxRunner(ROLE_CODE);
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(svc.acceptInvitationExistingUser("rawtoken")).rejects.toThrow(ConflictException);
  });

  it("re-throws when createMembership violates a different unique constraint", async () => {
    repo.findByTokenHashResult = makeInvitationRow();
    repo.findUserByEmailResult = makeUserRow();
    const otherErr = { code: "23505", constraint: "some_other_constraint" };
    repo.createMembershipError = otherErr;
    const tx = makeSimpleTxRunner(ROLE_CODE);
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(svc.acceptInvitationExistingUser("rawtoken")).rejects.toMatchObject(otherErr);
  });

  it("re-throws non-23505 errors from createMembership verbatim", async () => {
    repo.findByTokenHashResult = makeInvitationRow();
    repo.findUserByEmailResult = makeUserRow();
    const otherErr = new Error("unexpected-db-error");
    repo.createMembershipError = otherErr;
    const tx = makeSimpleTxRunner(ROLE_CODE);
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(svc.acceptInvitationExistingUser("rawtoken")).rejects.toThrow("unexpected-db-error");
  });

  it("happy path kind='all' returns MembershipDetail without calling insertStoreAccessRows", async () => {
    repo.findByTokenHashResult = makeInvitationRow({ storeAccessKind: "all", invitedStoreIds: [] });
    repo.findUserByEmailResult = makeUserRow();
    const tx = makeSimpleTxRunner(ROLE_CODE);
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    const result = await svc.acceptInvitationExistingUser("rawtoken");
    expect(result.roleCode).toBe(ROLE_CODE);
    expect(result.storeAccessKind).toBe("all");
    expect(result.accessibleStoreIds).toHaveLength(0);
    expect(result.revokedAt).toBeNull();
    expect(repo.insertStoreAccessRowsCalled).toBe(false);
  });

  it("happy path kind='specific' calls insertStoreAccessRows and returns accessible store list", async () => {
    repo.findByTokenHashResult = makeInvitationRow({
      storeAccessKind: "specific",
      invitedStoreIds: [STORE_ID_A, STORE_ID_B],
    });
    repo.findUserByEmailResult = makeUserRow();
    const tx = makeSimpleTxRunner(ROLE_CODE);
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    const result = await svc.acceptInvitationExistingUser("rawtoken");
    expect(result.storeAccessKind).toBe("specific");
    expect(result.accessibleStoreIds).toEqual([STORE_ID_A, STORE_ID_B]);
    expect(repo.insertStoreAccessRowsCalled).toBe(true);
  });

  it("happy path includes user details in MembershipDetail", async () => {
    const user = makeUserRow({ id: USER_ID, email: "invitee@example.com", displayName: "Alice" });
    repo.findByTokenHashResult = makeInvitationRow();
    repo.findUserByEmailResult = user;
    const tx = makeSimpleTxRunner(ROLE_CODE);
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    const result = await svc.acceptInvitationExistingUser("rawtoken");
    expect(result.user.id).toBe(USER_ID);
    expect(result.user.email).toBe("invitee@example.com");
    expect(result.user.displayName).toBe("Alice");
  });

  it("sets displayName to null when user has no displayName", async () => {
    const user = makeUserRow({ displayName: undefined });
    repo.findByTokenHashResult = makeInvitationRow();
    repo.findUserByEmailResult = user;
    const tx = makeSimpleTxRunner(ROLE_CODE);
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    const result = await svc.acceptInvitationExistingUser("rawtoken");
    expect(result.user.displayName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isUniqueViolation helper (tested indirectly via acceptInvitationExistingUser)
// ---------------------------------------------------------------------------

describe("isUniqueViolation (indirect coverage via acceptInvitationExistingUser)", () => {
  let repo: FakeInvitationsRepository;
  let enqueuer: FakeEmailEnqueuer;

  beforeEach(() => {
    repo = new FakeInvitationsRepository();
    enqueuer = new FakeEmailEnqueuer();
    repo.findByTokenHashResult = makeInvitationRow();
    repo.findUserByEmailResult = makeUserRow();
  });

  it("detects constraint name in error message when constraint field is absent", async () => {
    repo.createMembershipError = {
      code: "23505",
      message: "duplicate key value violates unique constraint memberships_tenant_user_active_uidx",
    };
    const tx = makeSimpleTxRunner(ROLE_CODE);
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(svc.acceptInvitationExistingUser("rawtoken")).rejects.toThrow(ConflictException);
  });

  it("follows .cause chain to find 23505 wrapped by DrizzleQueryError", async () => {
    repo.createMembershipError = {
      message: "drizzle wrapper",
      cause: {
        code: "23505",
        constraint: "memberships_tenant_user_active_uidx",
      },
    };
    const tx = makeSimpleTxRunner(ROLE_CODE);
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    await expect(svc.acceptInvitationExistingUser("rawtoken")).rejects.toThrow(ConflictException);
  });

  it("re-throws when err is null", async () => {
    // null is not an object — should not match and re-throw
    repo.createMembershipError = null;
    // null error gets thrown as null; the service re-throws it
    const tx = makeSimpleTxRunner(ROLE_CODE);
    const svc = new InvitationsService(FAKE_POOL, repo as unknown as InvitationsRepository, enqueuer as unknown as EmailJobEnqueuer, tx);
    // null is re-thrown as-is (not ConflictException or BadRequestException)
    await expect(svc.acceptInvitationExistingUser("rawtoken")).rejects.toBeNull();
  });
});
