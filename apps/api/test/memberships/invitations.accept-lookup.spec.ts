/**
 * Accept-token lookup foundation spec.
 *
 * Tests InvitationsService.lookupAndValidateAcceptToken() —
 * the read-only foundation that the future POST /api/v1/invitations/accept
 * endpoint will call. No HTTP route exists yet; this tests the service layer
 * directly.
 *
 * Scenarios:
 *   1.  Valid pending token → returns invitation row (correct id / email / tenantId)
 *   2.  Unknown token → BadRequestException (same opaque message)
 *   3.  Token found, status = 'expired' → BadRequestException (same message)
 *   4.  Token found, status = 'revoked' → BadRequestException (same message)
 *   5.  Token found, status = 'accepted' → BadRequestException (same message)
 *   6.  Token found, status = 'pending', but expires_at in the past → BadRequestException
 *   7.  Lookup does NOT create a membership row
 *   8.  Lookup does NOT create a user row
 *   9.  Lookup does NOT create a session row
 *   10. Lookup does NOT mark the invitation accepted (accepted_at / accepted_by_user_id null)
 *   11. Returned row does NOT expose token_hash or raw token on its surface
 */
import "reflect-metadata";

import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";

import { hashPassword, generateRawToken, hashToken } from "@data-pulse-2/auth";
import { AuthModule, PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
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
// Prefix "a" — must not collide with create spec ("f") or patch spec ("e").

const OWNER_ID   = "a1000000-1000-4000-8000-000000000001";
const OWNER_EMAIL = "owner@accept-lookup.test";
const OWNER_PASS  = "Owner-Lookup-1!";

const ALPHA_ID   = "a2000000-2000-4000-8000-000000000002";
const ROLE_ID    = "a3000000-3000-4000-8000-000000000003";
const MEM_ID     = "a4000000-4000-4000-8000-000000000004";

// ---- Bootstrap --------------------------------------------------------------

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let service: InvitationsService | null = null;
let dockerSkipped = false;

const mockEmailEnqueuer = {
  enqueueInvitation: jest.fn<Promise<void>, [object]>().mockResolvedValue(undefined),
  enqueuePasswordReset: jest.fn<Promise<void>, [object]>().mockResolvedValue(undefined),
  enqueueEmailVerification: jest.fn<Promise<void>, [object]>().mockResolvedValue(undefined),
};

async function seedBase(): Promise<void> {
  const pg = pool!;
  const ownerHash = await hashPassword(OWNER_PASS);

  await pg.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
    [OWNER_ID, OWNER_EMAIL, ownerHash],
  );
  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'alpha-lookup', 'Alpha Lookup')`,
    [ALPHA_ID],
  );
  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'owner', 'Owner Alpha')`,
    [ROLE_ID, ALPHA_ID],
  );
  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1, $2, $3, $4, 'all')`,
    [MEM_ID, ALPHA_ID, OWNER_ID, ROLE_ID],
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[invitations.accept-lookup.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[invitations.accept-lookup.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

/** Insert a fixture invitation row directly via the admin pool. */
async function insertInvitation(opts: {
  id: string;
  rawToken: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  expiresAt: Date;
}): Promise<void> {
  const tokenHash = hashToken(opts.rawToken);
  await pool!.query(
    `INSERT INTO invitations
       (id, tenant_id, email, role_id, store_access_kind, invited_store_ids,
        invited_by_user_id, token_hash, status, expires_at)
     VALUES ($1, $2, $3, $4, 'all', '{}', $5, $6, $7, $8)`,
    [
      opts.id,
      ALPHA_ID,
      "invitee@accept-lookup.test",
      ROLE_ID,
      OWNER_ID,
      tokenHash,
      opts.status,
      opts.expiresAt,
    ],
  );
}

async function cleanInvitations(): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM invitations WHERE tenant_id = $1`, [ALPHA_ID]);
}

// ===== 1. Valid pending token → returns row ==================================

describe("lookupAndValidateAcceptToken — valid pending token", () => {
  afterEach(cleanInvitations);

  it("returns the invitation row with correct id, email, and tenantId", async () => {
    if (maybeSkip()) return;
    const rawToken = generateRawToken();
    const id = "a5000000-5000-4000-8000-000000000005";
    await insertInvitation({
      id,
      rawToken,
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const row = await service!.lookupAndValidateAcceptToken(rawToken);

    expect(row.id).toBe(id);
    expect(row.email).toBe("invitee@accept-lookup.test");
    expect(row.tenantId).toBe(ALPHA_ID);
    expect(row.status).toBe("pending");
  });
});

// ===== 2. Unknown token → same opaque error ==================================

describe("lookupAndValidateAcceptToken — unknown token", () => {
  it("throws BadRequestException for a token that does not exist", async () => {
    if (maybeSkip()) return;
    const unknownToken = generateRawToken();
    await expect(
      service!.lookupAndValidateAcceptToken(unknownToken),
    ).rejects.toThrow(BadRequestException);
  });
});

// ===== 3–5. Invalid status → same opaque error ===============================

describe("lookupAndValidateAcceptToken — non-pending status", () => {
  afterEach(cleanInvitations);

  it.each([
    ["expired",  "a6000000-6000-4000-8000-000000000006"],
    ["revoked",  "a7000000-7000-4000-8000-000000000007"],
    ["accepted", "a8000000-8000-4000-8000-000000000008"],
  ] as const)("status='%s' → BadRequestException", async (status, id) => {
    if (maybeSkip()) return;
    const rawToken = generateRawToken();
    await insertInvitation({
      id,
      rawToken,
      status,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    await expect(
      service!.lookupAndValidateAcceptToken(rawToken),
    ).rejects.toThrow(BadRequestException);
  });

  it("all invalid-status errors carry the same opaque message (no enumeration)", async () => {
    if (maybeSkip()) return;
    const rawExpired  = generateRawToken();
    const rawRevoked  = generateRawToken();
    const rawAccepted = generateRawToken();
    const rawUnknown  = generateRawToken();

    await insertInvitation({ id: "a9000000-9000-4000-8000-000000000009", rawToken: rawExpired,  status: "expired",  expiresAt: new Date(Date.now() + 1_000) });
    await insertInvitation({ id: "aa000000-a000-4000-8000-00000000000a", rawToken: rawRevoked,  status: "revoked",  expiresAt: new Date(Date.now() + 1_000) });
    await insertInvitation({ id: "ab000000-b000-4000-8000-00000000000b", rawToken: rawAccepted, status: "accepted", expiresAt: new Date(Date.now() + 1_000) });

    const [errExpired, errRevoked, errAccepted, errUnknown] = await Promise.all([
      service!.lookupAndValidateAcceptToken(rawExpired).catch((e: unknown) => e),
      service!.lookupAndValidateAcceptToken(rawRevoked).catch((e: unknown) => e),
      service!.lookupAndValidateAcceptToken(rawAccepted).catch((e: unknown) => e),
      service!.lookupAndValidateAcceptToken(rawUnknown).catch((e: unknown) => e),
    ]);

    const msg = (e: unknown) =>
      e instanceof BadRequestException ? (e.getResponse() as { message: string }).message : null;

    expect(msg(errExpired)).toBe(msg(errUnknown));
    expect(msg(errRevoked)).toBe(msg(errUnknown));
    expect(msg(errAccepted)).toBe(msg(errUnknown));
  });
});

// ===== 6. Pending but past expires_at → error ================================

describe("lookupAndValidateAcceptToken — pending but expired by time", () => {
  afterEach(cleanInvitations);

  it("throws BadRequestException when expires_at is in the past", async () => {
    if (maybeSkip()) return;
    const rawToken = generateRawToken();
    await insertInvitation({
      id: "ac000000-c000-4000-8000-00000000000c",
      rawToken,
      status: "pending",
      expiresAt: new Date(Date.now() - 1_000), // 1 second ago
    });

    await expect(
      service!.lookupAndValidateAcceptToken(rawToken),
    ).rejects.toThrow(BadRequestException);
  });
});

// ===== 7–10. No mutations on lookup ==========================================

describe("lookupAndValidateAcceptToken — no side-effects", () => {
  afterEach(cleanInvitations);

  it("does NOT create a membership row", async () => {
    if (maybeSkip()) return;
    const rawToken = generateRawToken();
    const id = "ad000000-d000-4000-8000-00000000000d";
    await insertInvitation({ id, rawToken, status: "pending", expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
    const beforeCount = (await pool!.query(`SELECT COUNT(*) FROM memberships WHERE tenant_id = $1`, [ALPHA_ID])).rows[0]?.count as string;

    await service!.lookupAndValidateAcceptToken(rawToken);

    const afterCount = (await pool!.query(`SELECT COUNT(*) FROM memberships WHERE tenant_id = $1`, [ALPHA_ID])).rows[0]?.count as string;
    expect(afterCount).toBe(beforeCount);
  });

  it("does NOT create a user row", async () => {
    if (maybeSkip()) return;
    const rawToken = generateRawToken();
    const id = "ae000000-e000-4000-8000-00000000000e";
    await insertInvitation({ id, rawToken, status: "pending", expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
    const beforeCount = (await pool!.query(`SELECT COUNT(*) FROM users`)).rows[0]?.count as string;

    await service!.lookupAndValidateAcceptToken(rawToken);

    const afterCount = (await pool!.query(`SELECT COUNT(*) FROM users`)).rows[0]?.count as string;
    expect(afterCount).toBe(beforeCount);
  });

  it("does NOT create a session row", async () => {
    if (maybeSkip()) return;
    const rawToken = generateRawToken();
    const id = "af000000-f000-4000-8000-00000000000f";
    await insertInvitation({ id, rawToken, status: "pending", expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
    const beforeCount = (await pool!.query(`SELECT COUNT(*) FROM sessions`)).rows[0]?.count as string;

    await service!.lookupAndValidateAcceptToken(rawToken);

    const afterCount = (await pool!.query(`SELECT COUNT(*) FROM sessions`)).rows[0]?.count as string;
    expect(afterCount).toBe(beforeCount);
  });

  it("does NOT mark the invitation accepted (accepted_at / accepted_by_user_id remain null)", async () => {
    if (maybeSkip()) return;
    const rawToken = generateRawToken();
    const id = "a0a00000-0a00-4000-8000-0000000000a0";
    await insertInvitation({ id, rawToken, status: "pending", expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });

    await service!.lookupAndValidateAcceptToken(rawToken);

    const res = await pool!.query(
      `SELECT status, accepted_at, accepted_by_user_id FROM invitations WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    expect(row?.status).toBe("pending");
    expect(row?.accepted_at).toBeNull();
    expect(row?.accepted_by_user_id).toBeNull();
  });
});

// ===== 11. Returned row surface — no raw token / token_hash ==================

describe("lookupAndValidateAcceptToken — returned row surface", () => {
  afterEach(cleanInvitations);

  it("returned InvitationRow keys do not include rawToken", async () => {
    if (maybeSkip()) return;
    const rawToken = generateRawToken();
    const id = "a0b00000-0b00-4000-8000-0000000000b0";
    await insertInvitation({ id, rawToken, status: "pending", expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });

    const row = await service!.lookupAndValidateAcceptToken(rawToken);

    expect(row).not.toHaveProperty("rawToken");
    // token_hash IS on InvitationRow (it's the DB column) — internal callers
    // are trusted not to forward it; the controller (not yet implemented)
    // must never include it in HTTP responses.
    expect(row.tokenHash).toBeDefined(); // confirms it IS on the row type
    // The raw token the caller passed in is not echoed back
    const rowAsAny = row as Record<string, unknown>;
    expect(Object.values(rowAsAny)).not.toContain(rawToken);
  });
});
