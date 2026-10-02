/**
 * Accept-invitation existing-user mutation foundation spec.
 *
 * Tests InvitationsService.acceptInvitationExistingUser() —
 * the mutation foundation that the future POST /api/v1/invitations/accept
 * endpoint will call. No HTTP route exists yet; this tests the service layer
 * directly.
 *
 * Scenarios:
 *   1.  Happy path — store_access_kind='all' → MembershipDetail returned,
 *       invitation.status='accepted', membership row created, no store_access rows
 *   2.  Happy path — store_access_kind='specific' with store_ids →
 *       store_access rows created, accessibleStoreIds matches
 *   3.  Unknown token → BadRequestException (same opaque message)
 *   4.  Token found but status='accepted' → BadRequestException
 *   5.  Token found but status='expired'  → BadRequestException
 *   6.  Token found but expires_at in past (status='pending') → BadRequestException
 *   7.  Email not found in users table → NotFoundException (before tx, invitation stays pending)
 *   8.  Duplicate membership (I-2 violation) → ConflictException (409)
 *   9.  Return type is MembershipDetail (not InvitationRow — no tokenHash)
 *   10. invitation.status set to 'accepted', accepted_by_user_id = user.id, accepted_at non-null
 *   11. Second call with same token → BadRequestException (invitation no longer pending)
 */
import "reflect-metadata";

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";

import { hashPassword, generateRawToken, hashToken } from "@data-pulse-2/auth";
import { AuthModule, PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
import { AuthService } from "../../src/auth/auth.service";
import { EMAIL_JOB_ENQUEUER } from "../../src/auth/email-job.enqueuer";
import { ContextModule } from "../../src/context/context.module";
import { MembershipsModule } from "../../src/memberships/memberships.module";
import { InvitationsService } from "../../src/memberships/invitations.service";
import type { RedisLike } from "../../src/auth/rate-limit";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

class AlwaysAllowRedis implements RedisLike {
  async incr(): Promise<number> { return 1; }
  async pexpireNx(): Promise<number> { return 1; }
  async pttl(): Promise<number> { return -1; }
  async decr(): Promise<number> { return 0; }
  async del(): Promise<number> { return 0; }
}

// ---- Fixture IDs -------------------------------------------------------------
// Prefix "b" — must not collide with patch ("e"), create ("f"), lookup ("a").

const OWNER_ID    = "b1000000-1000-4000-8000-000000000001";
const OWNER_EMAIL = "owner@accept-existing.test";
const OWNER_PASS  = "Owner-Accept-1!";

// The invitee — a user who already has an account
const INVITEE_ID    = "b2000000-2000-4000-8000-000000000002";
const INVITEE_EMAIL = "invitee@accept-existing.test";
const INVITEE_PASS  = "Invitee-Accept-1!";

// A second user for duplicate-membership test
const SECOND_ID    = "bc000000-c000-4000-8000-00000000000c";
const SECOND_EMAIL = "second@accept-existing.test";

const ALPHA_ID    = "b3000000-3000-4000-8000-000000000003";
const ROLE_ID     = "b4000000-4000-4000-8000-000000000004";
const MEM_OWNER   = "b5000000-5000-4000-8000-000000000005";

// Two stores in ALPHA for the specific-access tests
const STORE_A1    = "b6000000-6000-4000-8000-000000000006";
const STORE_A2    = "b7000000-7000-4000-8000-000000000007";

// ---- Bootstrap --------------------------------------------------------------

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let service: InvitationsService | null = null;
let authService: AuthService | null = null;
let dockerSkipped = false;

const mockEmailEnqueuer = {
  enqueueInvitation: jest.fn<Promise<void>, [object]>().mockResolvedValue(undefined),
  enqueuePasswordReset: jest.fn<Promise<void>, [object]>().mockResolvedValue(undefined),
  enqueueEmailVerification: jest.fn<Promise<void>, [object]>().mockResolvedValue(undefined),
};

async function seedBase(): Promise<void> {
  const pg = pool!;
  const ownerHash = await hashPassword(OWNER_PASS);
  const inviteeHash = await hashPassword(INVITEE_PASS);

  await pg.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
    [OWNER_ID, OWNER_EMAIL, ownerHash],
  );
  await pg.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
    [INVITEE_ID, INVITEE_EMAIL, inviteeHash],
  );
  // Second user (no password needed — just a user row)
  await pg.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
    [SECOND_ID, SECOND_EMAIL, ownerHash],
  );
  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'alpha-accept', 'Alpha Accept')`,
    [ALPHA_ID],
  );
  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'owner', 'Owner Alpha')`,
    [ROLE_ID, ALPHA_ID],
  );
  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1, $2, $3, $4, 'all')`,
    [MEM_OWNER, ALPHA_ID, OWNER_ID, ROLE_ID],
  );
  // Seed two stores in ALPHA for 'specific' tests
  await pg.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'store-a1', 'Store A1')`,
    [STORE_A1, ALPHA_ID],
  );
  await pg.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'store-a2', 'Store A2')`,
    [STORE_A2, ALPHA_ID],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });
    await seedBase();

    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, MembershipsModule],
    })
      .overrideProvider(PG_POOL).useValue(pool)
      .overrideProvider(REDIS_CLIENT).useValue(new AlwaysAllowRedis())
      .overrideProvider(EMAIL_JOB_ENQUEUER).useValue(mockEmailEnqueuer)
      .compile();

    service = moduleRef.get(InvitationsService);
    authService = moduleRef.get(AuthService);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[invitations.accept-existing-user.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (pool) await pool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[invitations.accept-existing-user.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

/** Insert a fixture invitation row directly via the admin pool. */
async function insertInvitation(opts: {
  id: string;
  email: string;
  rawToken: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  expiresAt: Date;
  storeAccessKind?: "all" | "specific";
  invitedStoreIds?: string[];
}): Promise<void> {
  const tokenHash = hashToken(opts.rawToken);
  const storeAccessKind = opts.storeAccessKind ?? "all";
  const invitedStoreIds = opts.invitedStoreIds ?? [];
  // Build a Postgres array literal for uuid[] column
  const storeIdLiteral =
    invitedStoreIds.length > 0
      ? `ARRAY[${invitedStoreIds.map((id) => `'${id}'`).join(",")}]::uuid[]`
      : "ARRAY[]::uuid[]";
  await pool!.query(
    `INSERT INTO invitations
       (id, tenant_id, email, role_id, store_access_kind, invited_store_ids,
        invited_by_user_id, token_hash, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, ${storeIdLiteral}, $6, $7, $8, $9)`,
    [
      opts.id,
      ALPHA_ID,
      opts.email,
      ROLE_ID,
      storeAccessKind,
      OWNER_ID,
      tokenHash,
      opts.status,
      opts.expiresAt,
    ],
  );
}

async function cleanInvitationsAndMemberships(): Promise<void> {
  if (!pool) return;
  await pool.query(
    `DELETE FROM memberships WHERE tenant_id = $1 AND id != $2`,
    [ALPHA_ID, MEM_OWNER],
  );
  await pool.query(`DELETE FROM invitations WHERE tenant_id = $1`, [ALPHA_ID]);
}

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

// ===== 1. Happy path — store_access_kind='all' ================================

describe("acceptInvitationExistingUser — all access happy path", () => {
  afterEach(cleanInvitationsAndMemberships);

  it("creates membership, marks invitation accepted, returns MembershipDetail", async () => {
    if (maybeSkip()) return;

    const rawToken = generateRawToken();
    const id = "b8000000-8000-4000-8000-000000000008";
    await insertInvitation({ id, email: INVITEE_EMAIL, rawToken, status: "pending", expiresAt: FUTURE });

    // Snapshot before: user count, session count, invitee password_hash
    const userCountBefore = (await pool!.query(`SELECT COUNT(*) FROM users`)).rows[0]?.count as string;
    const sessionCountBefore = (await pool!.query(`SELECT COUNT(*) FROM sessions`)).rows[0]?.count as string;
    const passHashBefore = (await pool!.query(
      `SELECT password_hash FROM users WHERE id = $1`,
      [INVITEE_ID],
    )).rows[0]?.password_hash as string;

    const detail = await service!.acceptInvitationExistingUser(rawToken);

    // No-side-effects: user count, session count, password_hash unchanged
    const userCountAfter = (await pool!.query(`SELECT COUNT(*) FROM users`)).rows[0]?.count as string;
    const sessionCountAfter = (await pool!.query(`SELECT COUNT(*) FROM sessions`)).rows[0]?.count as string;
    const passHashAfter = (await pool!.query(
      `SELECT password_hash FROM users WHERE id = $1`,
      [INVITEE_ID],
    )).rows[0]?.password_hash as string;

    expect(userCountAfter).toBe(userCountBefore);
    expect(sessionCountAfter).toBe(sessionCountBefore);
    expect(passHashAfter).toBe(passHashBefore);

    // MembershipDetail shape
    expect(detail.membershipId).toBeDefined();
    expect(detail.user.id).toBe(INVITEE_ID);
    expect(detail.user.email).toBe(INVITEE_EMAIL);
    expect(detail.roleCode).toBe("owner");
    expect(detail.storeAccessKind).toBe("all");
    expect(detail.accessibleStoreIds).toEqual([]);
    expect(detail.revokedAt).toBeNull();

    // DB: invitation marked accepted
    const inv = await pool!.query(`SELECT status, accepted_by_user_id, accepted_at FROM invitations WHERE id = $1`, [id]);
    const invRow = inv.rows[0];
    expect(invRow?.status).toBe("accepted");
    expect(invRow?.accepted_by_user_id).toBe(INVITEE_ID);
    expect(invRow?.accepted_at).not.toBeNull();

    // DB: membership created
    const mem = await pool!.query(
      `SELECT * FROM memberships WHERE id = $1`,
      [detail.membershipId],
    );
    expect(mem.rows[0]?.user_id).toBe(INVITEE_ID);
    expect(mem.rows[0]?.tenant_id).toBe(ALPHA_ID);
    expect(mem.rows[0]?.store_access_kind).toBe("all");
  });
});

// ===== 2. Happy path — store_access_kind='specific' ==========================

describe("acceptInvitationExistingUser — specific access happy path", () => {
  afterEach(cleanInvitationsAndMemberships);

  it("creates store_access rows for invited_store_ids", async () => {
    if (maybeSkip()) return;

    const rawToken = generateRawToken();
    const id = "b9000000-9000-4000-8000-000000000009";
    await insertInvitation({
      id,
      email: INVITEE_EMAIL,
      rawToken,
      status: "pending",
      expiresAt: FUTURE,
      storeAccessKind: "specific",
      invitedStoreIds: [STORE_A1, STORE_A2],
    });

    const detail = await service!.acceptInvitationExistingUser(rawToken);

    expect(detail.storeAccessKind).toBe("specific");
    expect(detail.accessibleStoreIds).toHaveLength(2);
    expect(detail.accessibleStoreIds).toEqual(
      expect.arrayContaining([STORE_A1, STORE_A2]),
    );

    // DB: store_access rows present
    const sa = await pool!.query(
      `SELECT store_id FROM store_access WHERE membership_id = $1 ORDER BY store_id`,
      [detail.membershipId],
    );
    const storeIds = sa.rows.map((r: { store_id: string }) => r.store_id).sort();
    expect(storeIds).toEqual([STORE_A1, STORE_A2].sort());
  });
});

// ===== 3. Unknown token → BadRequestException ================================

describe("acceptInvitationExistingUser — unknown token", () => {
  it("throws BadRequestException for a token that does not exist", async () => {
    if (maybeSkip()) return;
    const unknownToken = generateRawToken();
    await expect(
      service!.acceptInvitationExistingUser(unknownToken),
    ).rejects.toThrow(BadRequestException);
  });
});

// ===== 4–5. Non-pending status → BadRequestException =========================

describe("acceptInvitationExistingUser — non-pending status", () => {
  afterEach(cleanInvitationsAndMemberships);

  it.each([
    ["accepted", "ba000000-a000-4000-8000-00000000000a"],
    ["expired",  "bb000000-b000-4000-8000-00000000000b"],
    ["revoked",  "b0e00000-0e00-4000-8000-0000000000e0"],
  ] as const)("status='%s' → BadRequestException", async (status, id) => {
    if (maybeSkip()) return;
    const rawToken = generateRawToken();
    await insertInvitation({ id, email: INVITEE_EMAIL, rawToken, status, expiresAt: FUTURE });
    await expect(
      service!.acceptInvitationExistingUser(rawToken),
    ).rejects.toThrow(BadRequestException);
  });
});

// ===== 6. Pending but expires_at in the past =================================

describe("acceptInvitationExistingUser — time-expired pending token", () => {
  afterEach(cleanInvitationsAndMemberships);

  it("throws BadRequestException when expires_at is in the past", async () => {
    if (maybeSkip()) return;
    const rawToken = generateRawToken();
    await insertInvitation({
      id: "bd000000-d000-4000-8000-00000000000d",
      email: INVITEE_EMAIL,
      rawToken,
      status: "pending",
      expiresAt: new Date(Date.now() - 1_000), // 1 second ago
    });
    await expect(
      service!.acceptInvitationExistingUser(rawToken),
    ).rejects.toThrow(BadRequestException);
  });
});

// ===== 7. Email not found → NotFoundException, invitation stays pending ======

describe("acceptInvitationExistingUser — email not in users table", () => {
  afterEach(cleanInvitationsAndMemberships);

  it("throws NotFoundException and leaves invitation status='pending'", async () => {
    if (maybeSkip()) return;
    const rawToken = generateRawToken();
    const id = "be000000-e000-4000-8000-00000000000e";
    await insertInvitation({
      id,
      email: "ghost@accept-existing.test",  // no matching user row
      rawToken,
      status: "pending",
      expiresAt: FUTURE,
    });

    await expect(
      service!.acceptInvitationExistingUser(rawToken),
    ).rejects.toThrow(NotFoundException);

    // Invitation must remain pending (not accepted, not mutated)
    const res = await pool!.query(
      `SELECT status, accepted_by_user_id FROM invitations WHERE id = $1`,
      [id],
    );
    expect(res.rows[0]?.status).toBe("pending");
    expect(res.rows[0]?.accepted_by_user_id).toBeNull();
  });
});

// ===== 8. Duplicate membership → ConflictException (I-2) =====================

describe("acceptInvitationExistingUser — duplicate membership conflict", () => {
  afterEach(cleanInvitationsAndMemberships);

  it("throws ConflictException(409) when user already has an active membership", async () => {
    if (maybeSkip()) return;

    // Pre-create a membership for INVITEE_ID in ALPHA
    const existingMemId = "bf000000-f000-4000-8000-00000000000f";
    await pool!.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
       VALUES ($1, $2, $3, $4, 'all')`,
      [existingMemId, ALPHA_ID, INVITEE_ID, ROLE_ID],
    );

    const rawToken = generateRawToken();
    await insertInvitation({
      id: "b0a00000-0a00-4000-8000-0000000000a0",
      email: INVITEE_EMAIL,
      rawToken,
      status: "pending",
      expiresAt: FUTURE,
    });

    await expect(
      service!.acceptInvitationExistingUser(rawToken),
    ).rejects.toThrow(ConflictException);

    // Rollback assertions: invitation must be rolled back to 'pending'
    // because the tx that called markAccepted also threw ConflictException.
    const invRes = await pool!.query(
      `SELECT status, accepted_by_user_id FROM invitations WHERE id = $1`,
      ["b0a00000-0a00-4000-8000-0000000000a0"],
    );
    expect(invRes.rows[0]?.status).toBe("pending");
    expect(invRes.rows[0]?.accepted_by_user_id).toBeNull();

    // No store_access rows inserted (tx rolled back entirely)
    const saRes = await pool!.query(
      `SELECT COUNT(*) FROM store_access sa
         JOIN memberships m ON m.id = sa.membership_id
        WHERE m.tenant_id = $1 AND m.id != $2`,
      [ALPHA_ID, existingMemId],
    );
    expect(Number(saRes.rows[0]?.count)).toBe(0);
  });
});

// ===== 9. Returned shape — no tokenHash surface ==============================

describe("acceptInvitationExistingUser — returned shape", () => {
  afterEach(cleanInvitationsAndMemberships);

  it("returned MembershipDetail does not expose tokenHash or rawToken", async () => {
    if (maybeSkip()) return;

    const rawToken = generateRawToken();
    await insertInvitation({
      id: "b0b00000-0b00-4000-8000-0000000000b0",
      email: INVITEE_EMAIL,
      rawToken,
      status: "pending",
      expiresAt: FUTURE,
    });

    const detail = await service!.acceptInvitationExistingUser(rawToken);

    expect(detail).not.toHaveProperty("tokenHash");
    expect(detail).not.toHaveProperty("rawToken");
    const values = Object.values(detail as Record<string, unknown>);
    expect(values).not.toContain(rawToken);
    // Confirm expected keys present
    expect(detail).toHaveProperty("membershipId");
    expect(detail).toHaveProperty("user");
    expect(detail).toHaveProperty("roleCode");
    expect(detail).toHaveProperty("storeAccessKind");
    expect(detail).toHaveProperty("accessibleStoreIds");
    expect(detail).toHaveProperty("revokedAt");
  });
});

// ===== 10. Invitation fields set after accept =================================

describe("acceptInvitationExistingUser — invitation mutations", () => {
  afterEach(cleanInvitationsAndMemberships);

  it("invitation row has status=accepted, accepted_at non-null, accepted_by_user_id correct", async () => {
    if (maybeSkip()) return;

    const rawToken = generateRawToken();
    const id = "b0c00000-0c00-4000-8000-0000000000c0";
    await insertInvitation({ id, email: INVITEE_EMAIL, rawToken, status: "pending", expiresAt: FUTURE });

    await service!.acceptInvitationExistingUser(rawToken);

    const res = await pool!.query(
      `SELECT status, accepted_at, accepted_by_user_id FROM invitations WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    expect(row?.status).toBe("accepted");
    expect(row?.accepted_at).not.toBeNull();
    expect(row?.accepted_by_user_id).toBe(INVITEE_ID);
  });
});

// ===== 11. Second call with same token → error (no longer pending) ============

describe("acceptInvitationExistingUser — second call same token", () => {
  afterEach(cleanInvitationsAndMemberships);

  it("second call with the same token throws BadRequestException", async () => {
    if (maybeSkip()) return;

    const rawToken = generateRawToken();
    await insertInvitation({
      id: "b0d00000-0d00-4000-8000-0000000000d0",
      email: INVITEE_EMAIL,
      rawToken,
      status: "pending",
      expiresAt: FUTURE,
    });

    // First call succeeds
    await service!.acceptInvitationExistingUser(rawToken);

    // Second call must throw the same opaque error
    await expect(
      service!.acceptInvitationExistingUser(rawToken),
    ).rejects.toThrow(BadRequestException);
  });
});

// ===== SC-6 Stopwatch — invite → accept → sign-in < 5 min ====================
//
// SC-6 (sc-verification.md §SC-6):
//   "A new tenant admin can invite a user, assign a role, choose a store-access
//    policy, and have the user complete sign-in in under 5 minutes from invite send."
//
// This is a regression guard, not a performance benchmark. The 5-minute ceiling
// is the outer-bound threshold from the spec; well-architected code running
// against a local Testcontainers Postgres completes the entire flow in
// milliseconds. The stopwatch catches runaway blocking, accidental network calls,
// or infinite retry loops introduced by future changes.
//
// Shape A: performance.now() wraps the full service-layer sequence.
// Shape B (clock injection into production code) was evaluated and rejected —
// it would require production-source changes that violate the "test-first, no
// prod-change" constraint for this slice.

describe("SC-6 stopwatch — invite → accept → sign-in completes in under 5 minutes", () => {
  afterEach(cleanInvitationsAndMemberships);

  it("full invite→accept→signin flow finishes well within the 5-minute ceiling (SC-6)", async () => {
    if (maybeSkip()) return;

    // Build the owner's resolved context (the tenant admin who sends the invite).
    const ownerCtx = {
      userId: OWNER_ID,
      tenantId: ALPHA_ID,
      storeId: null as string | null,
      isPlatformAdmin: false,
      source: "session" as const,
    };

    // Ensure the enqueuer mock captures only this test's call.
    mockEmailEnqueuer.enqueueInvitation.mockClear();

    // ── Step 1 / Step 2 / Step 3 are measured as a single wall-clock sequence ──
    const start = performance.now();

    // Step 1: tenant admin invites the pre-existing user.
    await service!.invite(ownerCtx, {
      email: INVITEE_EMAIL,
      role_code: "owner",
      store_access_kind: "all",
    });

    // Retrieve the raw token the service handed to the email enqueuer.
    const rawToken = mockEmailEnqueuer.enqueueInvitation.mock.calls.at(-1)?.[0] as
      | { rawToken: string }
      | undefined;
    if (!rawToken) {
      throw new Error("enqueueInvitation was not called — invite() did not emit a token");
    }

    // Step 2: invited user (already has an account) accepts the invitation.
    await service!.acceptInvitationExistingUser(rawToken.rawToken);

    // Step 3: invited user signs in with their existing credentials.
    await authService!.signIn({ email: INVITEE_EMAIL, password: INVITEE_PASS });

    const elapsed = performance.now() - start;

    // eslint-disable-next-line no-console
    console.log(`SC-6 invite→accept→signin stopwatch: ${elapsed.toFixed(2)} ms`);

    // The spec ceiling is 5 minutes (300 000 ms). Any well-functioning
    // implementation completes in under a second; 5 min is the outer bound
    // that catches catastrophic regressions (blocking calls, retry storms, etc.).
    expect(elapsed).toBeLessThan(5 * 60 * 1000);
  });
});
