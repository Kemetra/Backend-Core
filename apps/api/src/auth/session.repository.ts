/**
 * SessionRepository — Postgres source of truth for `sessions`.
 *
 * Sessions are user-scoped (not tenant-scoped) per data-model.md §9; RLS
 * is NOT applied to this table, so all reads/writes happen on a plain
 * connection — no `runWithTenantContext` required.
 *
 * The Redis read-through cache is deferred to slice 3b. This file exposes
 * a `SessionCache` interface so slice 3b plugs an `ioredis` implementation
 * in without touching the repository. The default is a no-op cache.
 */
import { Injectable } from "@nestjs/common";
import { hashToken, tokenHashesEqual } from "@data-pulse-2/auth";
import {
  type NewSessionRow,
  sessions,
  type SessionRow,
} from "@data-pulse-2/db/schema";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Pool } from "pg";

/**
 * Optional cache implementation. Slice 3b will provide a Redis-backed one;
 * for now the default is a no-op so the repository's call sites are
 * stable.
 */
export interface SessionCache {
  get(id: string): Promise<SessionRow | null>;
  set(session: SessionRow): Promise<void>;
  invalidate(id: string): Promise<void>;
}

class NoOpSessionCache implements SessionCache {
  async get(_id: string): Promise<SessionRow | null> {
    return null;
  }
  async set(_session: SessionRow): Promise<void> {
    // intentionally empty
  }
  async invalidate(_id: string): Promise<void> {
    // intentionally empty
  }
}

export interface SessionRepositoryOptions {
  cache?: SessionCache;
}

/**
 * Dashboard-session idle timeout (RT-139): a session unused for this long is
 * dead, even inside its absolute cap. Spec 001 research.md / plan.md: "12h
 * sliding (max 24h absolute)". Activity slides `last_seen_at`; it never
 * extends `absolute_expires_at`.
 */
export const SESSION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/**
 * Activity renews `last_seen_at` at most this often per session, so an
 * authenticated burst costs one UPDATE, not one per request. Well below the
 * idle timeout, so the slide is effectively continuous.
 */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** `last_seen_at` still inside the idle window (DB clock). */
const notIdle = sql`${sessions.lastSeenAt} > now() - make_interval(secs => ${SESSION_IDLE_TIMEOUT_MS / 1000})`;

@Injectable()
export class SessionRepository {
  private readonly db: NodePgDatabase;
  private readonly cache: SessionCache;

  constructor(pool: Pool, opts: SessionRepositoryOptions = {}) {
    this.db = drizzle(pool);
    this.cache = opts.cache ?? new NoOpSessionCache();
  }

  /**
   * Insert a new session row. Caller supplies the id (UUIDv7), `user_id`,
   * `absolute_expires_at` and any optional fields.
   */
  async create(input: NewSessionRow): Promise<SessionRow> {
    const [row] = await this.db.insert(sessions).values(input).returning();
    if (!row) {
      throw new Error("SessionRepository.create: insert returned no row");
    }
    await this.cache.set(row);
    return row;
  }

  /**
   * Look up a live session by the raw dashboard cookie.
   *
   * The cookie is hashed with SHA-256 and compared to `credential_hash`.
   * The raw value is never used as a query key and is never cached.
   * A second constant-time compare rejects a row whose stored hash does
   * not match the hash just computed.
   */
  async findActiveByCredential(rawCredential: string): Promise<SessionRow | null> {
    const hash = hashToken(rawCredential);
    const rows = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.credentialHash, hash),
          isNull(sessions.revokedAt),
          gt(sessions.absoluteExpiresAt, sql`now()`),
          notIdle,
        ),
      )
      .limit(1);
    const row = rows[0] ?? null;
    if (!row) return null;
    if (!tokenHashesEqual(row.credentialHash, hash)) return null;
    if (!this.isLive(row)) return null;
    await this.cache.set(row);
    return row;
  }

  /**
   * Look up a session by id. Returns null when missing, revoked, or past
   * its absolute-expiry watermark.
   *
   * Reads from the cache first; on miss, fetches from Postgres and warms
   * the cache. Always honours liveness in Postgres — a cached row that
   * has since been revoked will be re-validated on the next call only if
   * the cache is invalidated; slice 3b's Redis implementation will keep
   * cache TTL ≤ 5 minutes per FR-AUTH-6.
   */
  async findActiveById(id: string): Promise<SessionRow | null> {
    const cached = await this.cache.get(id);
    if (cached && this.isLive(cached)) return cached;

    const rows = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, id),
          isNull(sessions.revokedAt),
          gt(sessions.absoluteExpiresAt, sql`now()`),
          notIdle,
        ),
      )
      .limit(1);
    const row = rows[0] ?? null;
    if (row) await this.cache.set(row);
    return row;
  }

  /**
   * Update `last_seen_at` to now(). Returns true if a row was touched.
   * Does NOT extend `absolute_expires_at`. Only a session that is still live
   * (unrevoked, inside its absolute cap AND its idle window) is touched, so
   * activity can never revive an idle-expired session (RT-139).
   */
  async touchLastSeen(id: string): Promise<boolean> {
    const result = await this.db
      .update(sessions)
      .set({ lastSeenAt: sql`now()` })
      .where(
        and(
          eq(sessions.id, id),
          isNull(sessions.revokedAt),
          gt(sessions.absoluteExpiresAt, sql`now()`),
          notIdle,
        ),
      );
    await this.cache.invalidate(id);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Record activity on a live session (RT-139): slide `last_seen_at`, at
   * most once per {@link SESSION_TOUCH_INTERVAL_MS}. Best-effort — the
   * request was already authenticated; a failed touch only shortens the
   * idle window, never extends access.
   */
  async recordActivity(session: SessionRow): Promise<void> {
    if (Date.now() - session.lastSeenAt.getTime() < SESSION_TOUCH_INTERVAL_MS) return;
    await this.touchLastSeen(session.id).catch(() => undefined);
  }

  /**
   * Update the session's `active_tenant_id` and `active_store_id`
   * atomically. Used by the ContextController's switch / clear
   * endpoints (T153).
   *
   * Behaviour:
   *   - Both fields are written in a single UPDATE — tenant-switch
   *     passes `activeStoreId: null` to auto-clear the store
   *     (FR-CTX implicit; see context.openapi.yaml line 41).
   *   - Returns the updated row (post-UPDATE state) via `RETURNING`
   *     so callers can render the new context without a follow-up
   *     `findActiveById`.
   *   - `revoked_at IS NULL` guards against switching context on a
   *     revoked session — returns `null` in that case (caller maps
   *     to 401).
   *   - The Redis read-through cache is invalidated so the next
   *     AuthGuard / TenantContextGuard read in another request sees
   *     fresh data.
   *
   * No CHECK is performed at this layer that the store belongs to the
   * tenant — the DB CHECK constraint on the `sessions` table enforces
   * Invariant I-4. The controller validates upstream so this method
   * is never asked to write an invalid combination.
   */
  async updateActiveContext(
    id: string,
    next: {
      activeTenantId: string | null;
      activeStoreId: string | null;
    },
  ): Promise<SessionRow | null> {
    const rows = await this.db
      .update(sessions)
      .set({
        activeTenantId: next.activeTenantId,
        activeStoreId: next.activeStoreId,
      })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
      .returning();
    await this.cache.invalidate(id);
    return rows[0] ?? null;
  }

  /**
   * Server-initiated revocation (sign-out, admin revoke). Idempotent — a
   * second revoke on the same row is a no-op for the application but
   * fast-paths via `revoked_at IS NULL` so we don't overwrite a prior
   * revocation timestamp.
   */
  async revoke(id: string): Promise<boolean> {
    const result = await this.db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
    await this.cache.invalidate(id);
    return (result.rowCount ?? 0) > 0;
  }

  private isLive(row: SessionRow): boolean {
    if (row.revokedAt !== null) return false;
    if (row.absoluteExpiresAt.getTime() <= Date.now()) return false;
    if (Date.now() - row.lastSeenAt.getTime() >= SESSION_IDLE_TIMEOUT_MS) return false;
    return true;
  }
}
