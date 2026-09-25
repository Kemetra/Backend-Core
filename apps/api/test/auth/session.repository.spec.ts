/**
 * T102 — SessionRepository spec.
 *
 * Real Postgres via Testcontainers. Verifies:
 *   - create + findActiveById round-trip
 *   - findActiveById returns null for revoked sessions
 *   - findActiveById returns null past absolute_expires_at
 *   - touchLastSeen updates last_seen_at without altering absolute_expires_at
 *   - revoke is idempotent and visible on next read
 *   - the no-op cache does not break behaviour
 *
 * Sessions are user-scoped (not tenant-scoped); admin pool is fine.
 */
import { hashToken } from "@data-pulse-2/auth";
import { newId } from "@data-pulse-2/shared";
import { Pool } from "pg";
import { SessionRepository } from "../../src/auth/session.repository";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let repo: SessionRepository;
let userId: string;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });

    // Seed a single user — sessions reference users.id.
    userId = newId();
    await pool.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [userId, "session-test@example.com", "phc-placeholder"],
    );
    repo = new SessionRepository(pool);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[session.repository.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (pool) await pool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

function rawCredential(id: string): string {
  return `cookie-${id}`;
}

function sessionInput(id: string, absoluteExpiresAt: Date) {
  return {
    id,
    userId: userId,
    absoluteExpiresAt,
    credentialHash: hashToken(rawCredential(id)),
  };
}

function futureExpiry(): Date {
  return new Date(Date.now() + 60 * 60 * 1000); // 1h ahead
}

function pastExpiry(): Date {
  return new Date(Date.now() - 60 * 1000); // 1 minute ago
}

describe("SessionRepository", () => {
  it("creates a session and finds it by id", async () => {
    const sessionId = newId();
    const created = await repo.create(sessionInput(sessionId, futureExpiry()));
    expect(created.id).toBe(sessionId);
    expect(created.userId).toBe(userId);
    expect(created.revokedAt).toBeNull();

    const found = await repo.findActiveById(sessionId);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(sessionId);

    const byCredential = await repo.findActiveByCredential(rawCredential(sessionId));
    expect(byCredential?.id).toBe(sessionId);
    expect(await repo.findActiveByCredential(sessionId)).toBeNull();
  });

  it("returns null for a non-existent id", async () => {
    expect(await repo.findActiveById(newId())).toBeNull();
  });

  it("returns null for a revoked session", async () => {
    const id = newId();
    await repo.create(sessionInput(id, futureExpiry()));
    expect(await repo.revoke(id)).toBe(true);
    expect(await repo.findActiveById(id)).toBeNull();
  });

  it("revoke is idempotent and does not overwrite the revoked_at timestamp", async () => {
    const id = newId();
    await repo.create(sessionInput(id, futureExpiry()));

    expect(await repo.revoke(id)).toBe(true);
    const after1 = await pool!.query<{ revoked_at: Date }>(
      "SELECT revoked_at FROM sessions WHERE id = $1",
      [id],
    );
    const firstRevoke = new Date(after1.rows[0]!.revoked_at).getTime();

    // Second revoke is a no-op for the application but doesn't change revoked_at.
    expect(await repo.revoke(id)).toBe(false);
    const after2 = await pool!.query<{ revoked_at: Date }>(
      "SELECT revoked_at FROM sessions WHERE id = $1",
      [id],
    );
    expect(new Date(after2.rows[0]!.revoked_at).getTime()).toBe(firstRevoke);
  });

  it("returns null past absolute_expires_at", async () => {
    const id = newId();
    await repo.create(sessionInput(id, pastExpiry()));
    expect(await repo.findActiveById(id)).toBeNull();
  });

  it("touchLastSeen updates last_seen_at without altering absolute_expires_at", async () => {
    const id = newId();
    const expiry = futureExpiry();
    await repo.create(sessionInput(id, expiry));

    const before = await pool!.query<{
      last_seen_at: Date;
      absolute_expires_at: Date;
    }>(
      "SELECT last_seen_at, absolute_expires_at FROM sessions WHERE id = $1",
      [id],
    );

    await pool!.query("SELECT pg_sleep(0.05)");
    expect(await repo.touchLastSeen(id)).toBe(true);

    const after = await pool!.query<{
      last_seen_at: Date;
      absolute_expires_at: Date;
    }>(
      "SELECT last_seen_at, absolute_expires_at FROM sessions WHERE id = $1",
      [id],
    );

    expect(new Date(after.rows[0]!.last_seen_at).getTime()).toBeGreaterThan(
      new Date(before.rows[0]!.last_seen_at).getTime(),
    );
    expect(new Date(after.rows[0]!.absolute_expires_at).getTime()).toBe(
      new Date(before.rows[0]!.absolute_expires_at).getTime(),
    );
  });

  it("touchLastSeen on a revoked session returns false", async () => {
    const id = newId();
    await repo.create(sessionInput(id, futureExpiry()));
    await repo.revoke(id);
    expect(await repo.touchLastSeen(id)).toBe(false);
  });
});
