/**
 * TenantsRepository — slice 12 (T131).
 *
 * Drizzle queries against `tenants`, `roles`, and `memberships`.
 *
 * RLS posture
 * -----------
 * All production calls run on a client supplied by `runWithTenantContext`.
 * Cross-tenant lists use a transaction-local bootstrap context and retain
 * an authenticated user predicate for regular users.
 *
 * What this repository owns
 * -------------------------
 *   - Reads: list (cross-tenant, user-scoped), get-by-id, list-deleted-too
 *     (platform-admin variant)
 *   - Writes: create (with role-seeding side effect), update (PATCH),
 *     soft-delete (sets deleted_at)
 *
 * What this repository does NOT own
 * --------------------------------
 *   - Authorization checks (service layer)
 *   - Membership listing for the deferred `/members` endpoint
 *   - The actual `runWithTenantContext` invocation (service layer)
 */
import { Injectable } from "@nestjs/common";
import {
  memberships,
  roles,
  tenants,
  type TenantRow,
  type TenantStatus,
} from "@data-pulse-2/db/schema";
import { newId } from "@data-pulse-2/shared";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";

/**
 * Wire-shape of a tenant row. Mirrors `TenantSummary` ∪ `Tenant` in
 * the OpenAPI contract; the controller projects to the appropriate
 * subset per endpoint.
 */
export interface TenantRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

function toRecord(row: TenantRow): TenantRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as TenantStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * Default tenant-scoped roles seeded at tenant creation. Order is
 * stable so test assertions can rely on it; values mirror the
 * `BuiltInRoleCode` enum from `@data-pulse-2/db`.
 */
export const DEFAULT_TENANT_ROLES: readonly {
  code: string;
  name: string;
}[] = [
  { code: "owner", name: "Owner" },
  { code: "tenant_admin", name: "Tenant Admin" },
  { code: "store_manager", name: "Store Manager" },
  { code: "store_staff", name: "Store Staff" },
];

@Injectable()
export class TenantsRepository {
  // ===== List queries ================================================

  /**
   * Tenants the user has an active membership in. Returns active
   * (non-deleted, non-revoked) memberships only.
   *
   * The service supplies a bootstrap-context client so RLS permits
   * cross-tenant membership reads; the user predicate limits the result.
   */
  async listForUser(connection: Pool | PoolClient, userId: string): Promise<TenantRecord[]> {
    const db = drizzle(connection);
    const rows = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        status: tenants.status,
        createdAt: tenants.createdAt,
        updatedAt: tenants.updatedAt,
        deletedAt: tenants.deletedAt,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(
          eq(memberships.userId, userId),
          isNull(memberships.revokedAt),
          isNull(memberships.deletedAt),
          isNull(tenants.deletedAt),
        ),
      );
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status as TenantStatus,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      deletedAt: r.deletedAt,
    }));
  }

  /**
   * Every tenant in the system, used by the platform-admin list view.
   * Excludes soft-deleted tenants by default; pass `includeDeleted: true`
   * to surface them too (used by the platform-admin GET-by-id flow
   * for restoration UX, NOT by the list endpoint).
   */
  async listAll(
    connection: Pool | PoolClient,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<TenantRecord[]> {
    const db = drizzle(connection);
    const where = opts.includeDeleted ? undefined : isNull(tenants.deletedAt);
    const rows = where
      ? await db.select().from(tenants).where(where)
      : await db.select().from(tenants);
    return rows.map(toRecord);
  }

  /**
   * Read-by-id under platform-admin RLS context — the path that needs to
   * see soft-deleted rows. Returns `null` if no row matches the id.
   * Caller decides whether to filter `deleted_at` based on actor.
   */
  async findByIdAdmin(
    connection: Pool | PoolClient,
    tenantId: string,
  ): Promise<TenantRecord | null> {
    const db = drizzle(connection);
    const rows = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  // ===== Per-tenant operations (inside runWithTenantContext) ========

  /**
   * Read-by-id within a tenant-scoped transaction. RLS enforces
   * `id = current_setting('app.current_tenant')::uuid OR is_platform_admin`.
   * For a regular user, this returns the row only if `app.current_tenant`
   * matches the row's id. Returns `null` for cross-tenant or deleted.
   */
  async findById(
    client: PoolClient,
    tenantId: string,
  ): Promise<TenantRecord | null> {
    const db = drizzle(client);
    const rows = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), isNull(tenants.deletedAt)))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Insert a new tenant row. Caller-supplied `id` so the controller
   * can mint UUIDv7 once and reuse it for the tenant + role seeding
   * within the same transaction.
   */
  async create(
    client: PoolClient,
    input: { id: string; slug: string; name: string },
  ): Promise<TenantRecord> {
    const db = drizzle(client);
    const rows = await db
      .insert(tenants)
      .values({
        id: input.id,
        slug: input.slug,
        name: input.name,
      })
      .returning();
    if (!rows[0]) {
      throw new Error("TenantsRepository.create: insert returned no row");
    }
    return toRecord(rows[0]);
  }

  /**
   * Seed the default tenant-scoped roles for a freshly-created tenant.
   * Atomic with `create` when called inside the same `runWithTenantContext`
   * transaction.
   */
  async seedDefaultRoles(
    client: PoolClient,
    tenantId: string,
  ): Promise<void> {
    const db = drizzle(client);
    const rows = DEFAULT_TENANT_ROLES.map((r) => ({
      id: newId(),
      tenantId,
      code: r.code,
      name: r.name,
      isBuiltIn: true,
    }));
    await db.insert(roles).values(rows);
  }

  /**
   * PATCH update. Only writes the fields supplied. Returns `null` if
   * the row no longer exists / is invisible under current RLS.
   */
  async update(
    client: PoolClient,
    tenantId: string,
    next: { name?: string | undefined; status?: "active" | "suspended" | undefined },
  ): Promise<TenantRecord | null> {
    const db = drizzle(client);
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (next.name !== undefined) set["name"] = next.name;
    if (next.status !== undefined) set["status"] = next.status;
    const rows = await db
      .update(tenants)
      .set(set)
      .where(and(eq(tenants.id, tenantId), isNull(tenants.deletedAt)))
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Soft-delete: sets `deleted_at = now()`. Idempotent — a second
   * delete on the same row is a no-op (because the row is filtered
   * by `deleted_at IS NULL` in the WHERE).
   */
  async softDelete(
    client: PoolClient,
    tenantId: string,
  ): Promise<boolean> {
    const db = drizzle(client);
    const result = await db
      .update(tenants)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(tenants.id, tenantId), isNull(tenants.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }
}
