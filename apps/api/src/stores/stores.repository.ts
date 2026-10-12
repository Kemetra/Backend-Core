/**
 * StoresRepository — slice US2 (T134).
 *
 * Drizzle queries against `stores`. Every method runs against a
 * `PoolClient` obtained via `runWithTenantContext` in the service
 * layer; RLS is in force, so no manual `tenant_id` predicate is
 * needed in the WHERE clauses (`stores_tenant_isolation` filters
 * cross-tenant rows automatically).
 *
 * Why all methods take `client: PoolClient` (not `pool: Pool`)
 * -----------------------------------------------------------
 * Stores are always operated on within an active tenant. Unlike
 * `TenantsRepository` (which has list-style queries that intentionally
 * cross tenant boundaries — "list every tenant the user belongs to"),
 * the stores domain has no such cross-tenant flow. Every query is
 * tenant-scoped, so every method requires a tenant-bound client.
 *
 * What this repository owns
 * -------------------------
 *   - `listInTenant`      — list all live stores in the active tenant
 *   - `findById`          — read one by id (RLS makes cross-tenant null)
 *   - `create`            — insert (caller mints `id`)
 *   - `update`            — PATCH (returns null if invisible/missing)
 *   - `softDelete`        — sets `deleted_at = now()`; idempotent
 *   - `findByIdForUpdate` — read one by id with the row locked (spec 038)
 *   - `describeZone`      — a zone's offset and business date now, or
 *                           null when PostgreSQL does not know it
 *   - `countOpenShifts`   — server-known open shifts at a store
 *   - `insertTimezoneChangedAudit` — the in-transaction audit row
 *
 * What this repository does NOT own
 * --------------------------------
 *   - Authorization (RolesGuard / StoresService)
 *   - Membership-based store-access checks (StoresService consults
 *     `MembershipRepository.canAccessStore` for `kind='specific'`)
 *   - The `runWithTenantContext` invocation itself (StoresService)
 */
import { Injectable } from "@nestjs/common";
import { newId } from "@data-pulse-2/shared";
import { stores, type StoreRow } from "@data-pulse-2/db/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PoolClient } from "pg";

/**
 * Wire-shape for a store row. Mirrors the OpenAPI `Store` schema; the
 * controller projects it to snake_case for the response body.
 */
/** A zone as PostgreSQL resolves it at the transaction's `now()`. */
export interface ZoneFacts {
  /** The transaction timestamp the facts were computed at. */
  readonly now: Date;
  readonly utcOffsetMinutes: number;
  /** `YYYY-MM-DD`: today's business date in the zone. */
  readonly businessDate: string;
}

export interface StoreRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly timezone: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

function toRecord(row: StoreRow): StoreRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    timezone: row.timezone,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

@Injectable()
export class StoresRepository {
  /**
   * List active (non-deleted) stores. RLS scopes the result to the
   * caller's active tenant; platform admins with no `app.current_tenant`
   * GUC set will see nothing here (and a service-level branch should
   * arguably reject the call upstream — see `StoresService.list`).
   */
  async listInTenant(client: PoolClient): Promise<StoreRecord[]> {
    const db = drizzle(client);
    const rows = await db
      .select()
      .from(stores)
      .where(isNull(stores.deletedAt));
    return rows.map(toRecord);
  }

  /**
   * Read by id. Returns `null` when the row is invisible under RLS
   * (cross-tenant) or has been soft-deleted.
   */
  async findById(
    client: PoolClient,
    storeId: string,
  ): Promise<StoreRecord | null> {
    const db = drizzle(client);
    const rows = await db
      .select()
      .from(stores)
      .where(and(eq(stores.id, storeId), isNull(stores.deletedAt)))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Insert a new store. The caller mints `id` and supplies `tenantId`
   * explicitly (taken from `request.context.tenantId`). RLS still
   * applies on INSERT — supplying a `tenantId` that doesn't match the
   * GUC would be silently rejected by the policy; the service layer
   * trusts the guard to have aligned them.
   *
   * Code uniqueness within a tenant is enforced by the partial unique
   * index `stores_tenant_code_uidx`; a duplicate raises `23505` which
   * the service maps to a `ConflictException` (409).
   */
  async create(
    client: PoolClient,
    input: {
      id: string;
      tenantId: string;
      code: string;
      name: string;
      /** Omitted means the column default `UTC`. */
      timezone?: string | undefined;
    },
  ): Promise<StoreRecord> {
    const db = drizzle(client);
    const rows = await db
      .insert(stores)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        code: input.code,
        name: input.name,
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      })
      .returning();
    if (!rows[0]) {
      throw new Error("StoresRepository.create: insert returned no row");
    }
    return toRecord(rows[0]);
  }

  /**
   * PATCH update. Only writes fields that are explicitly supplied.
   * Returns `null` if the row doesn't exist, has been soft-deleted,
   * or is invisible under RLS — caller maps that to 404.
   *
   * `tenantId` is intentionally NOT a writable field — FR-STORE-4
   * forbids cross-tenant reassignment, and the Zod schema rejects
   * the key at the boundary anyway.
   */
  async update(
    client: PoolClient,
    storeId: string,
    next: {
      name?: string | undefined;
      isActive?: boolean | undefined;
      timezone?: string | undefined;
    },
  ): Promise<StoreRecord | null> {
    const db = drizzle(client);
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (next.name !== undefined) set["name"] = next.name;
    if (next.isActive !== undefined) set["isActive"] = next.isActive;
    if (next.timezone !== undefined) set["timezone"] = next.timezone;
    const rows = await db
      .update(stores)
      .set(set)
      .where(and(eq(stores.id, storeId), isNull(stores.deletedAt)))
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Soft-delete: sets `deleted_at = now()`. Idempotent — second call
   * on the same id is a no-op (the WHERE filter excludes already-
   * deleted rows). Returns whether a row was actually mutated, but
   * the controller maps to 204 either way: the contract treats
   * DELETE as idempotent (404 only for cross-tenant / never-existed).
   */
  async softDelete(
    client: PoolClient,
    storeId: string,
  ): Promise<boolean> {
    const db = drizzle(client);
    const result = await db
      .update(stores)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(stores.id, storeId), isNull(stores.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Existence probe scoped to the active tenant: returns `true` iff
   * a row with `(id = storeId, deleted_at IS NULL)` is visible under
   * the current RLS context. Used by the service to distinguish
   * "store doesn't exist in this tenant" (→ 404) from "the
   * MembershipRepository.canAccessStore branch denied" (also 404).
   *
   * Same RLS semantics as `findById`, but doesn't materialize the row.
   */
  async existsInTenant(
    client: PoolClient,
    storeId: string,
  ): Promise<boolean> {
    const db = drizzle(client);
    const rows = await db
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.id, storeId), isNull(stores.deletedAt)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Read by id with the row locked `FOR UPDATE` until the transaction
   * ends. A zone change holds this lock across its checks and write, so a
   * concurrent change waits, and a shift open (which reads the zone
   * `FOR SHARE`) cannot slip between the open-shift check and the write.
   */
  async findByIdForUpdate(
    client: PoolClient,
    storeId: string,
  ): Promise<StoreRecord | null> {
    const db = drizzle(client);
    const rows = await db
      .select()
      .from(stores)
      .where(and(eq(stores.id, storeId), isNull(stores.deletedAt)))
      .limit(1)
      .for("update");
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * The zone's UTC offset and today's business date at the transaction's
   * `now()`, or `null` when `pg_timezone_names` has no such name (stage 2
   * of the validation in `timezone.ts`). Two calls in one transaction see
   * the same `now()`.
   */
  async describeZone(
    client: PoolClient,
    timezone: string,
  ): Promise<ZoneFacts | null> {
    const result = await client.query<{
      now: Date;
      utc_offset_minutes: number;
      business_date: string;
    }>(
      `SELECT now() AS now,
              (EXTRACT(EPOCH FROM utc_offset) / 60)::int AS utc_offset_minutes,
              (now() AT TIME ZONE name)::date::text AS business_date
         FROM pg_timezone_names
        WHERE name = $1`,
      [timezone],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      now: row.now,
      utcOffsetMinutes: row.utc_offset_minutes,
      businessDate: row.business_date,
    };
  }

  /**
   * Shifts at the store the server knows to be open. RLS on `shifts`
   * scopes the count to the active tenant. A shift opened on a POS that
   * has not synced is not counted (preview caveat
   * `offline_shifts_not_visible`).
   */
  async countOpenShifts(
    client: PoolClient,
    storeId: string,
  ): Promise<number> {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM shifts
        WHERE store_id = $1 AND lifecycle_state = 'open'`,
      [storeId],
    );
    return result.rows[0]?.n ?? 0;
  }

  /**
   * The `store.timezone.changed` audit row, written on the caller's
   * transaction so it commits or rolls back with the change (decision
   * 214's auditability).
   */
  async insertTimezoneChangedAudit(
    client: PoolClient,
    input: {
      tenantId: string;
      storeId: string;
      actorUserId: string | null;
      requestId: string | null;
      action: string;
      from: string;
      to: string;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
         (id, actor_user_id, tenant_id, store_id, action,
          target_type, target_id, request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, 'store', $4, $6, $7::jsonb)`,
      [
        newId(),
        input.actorUserId,
        input.tenantId,
        input.storeId,
        input.action,
        input.requestId,
        JSON.stringify({ store_id: input.storeId, from: input.from, to: input.to }),
      ],
    );
  }
}
