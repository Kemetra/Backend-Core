/**
 * MembershipRepository — slice 9 (T151).
 *
 * Focused query helper for `TenantContextGuard`. Answers exactly the
 * three questions the guard needs:
 *
 *   1. Is the caller a platform admin?
 *      (`users.is_platform_admin = true`)
 *   2. Does this user have an active membership in this tenant?
 *      (returns the membership's `storeAccessKind`, or `null` if no
 *      active membership exists)
 *   3. For a `'specific'` membership, can this user access this store
 *      WITHIN the active tenant?
 *      (`store_access` row exists AND store is in the tenant)
 *      For an `'all'` membership: the store must merely belong to the
 *      active tenant.
 *
 * Why a separate repository (not inline in the guard)
 * ---------------------------------------------------
 *   - Mirrors the established pattern (`SessionRepository`,
 *     `AuthTokenRepository`) — every other repository in this codebase
 *     lives in its module's folder, takes a `pg.Pool`, exposes typed
 *     methods.
 *   - Keeps the guard focused on policy. Tests for the guard fake the
 *     repository at the class boundary and never touch SQL.
 *   - When membership lookups grow (Redis caching for FR-AUTH-6's
 *     ≤5min revocation propagation, e.g.), the changes land here
 *     without rippling through guard tests.
 *
 * RLS posture
 * -----------
 * The guard's own queries run on a plain `pg.Pool` connection without
 * `runWithTenantContext`. Same posture as `SessionRepository` and
 * `AuthTokenRepository` — these tables are accessed by the auth/context
 * stack BEFORE a tenant context is established (chicken-and-egg). The
 * RLS policies on `memberships` and `store_access` are still in force
 * for normal application traffic; this is the deliberately scoped
 * exception, gated behind the guard's narrow query surface.
 */
import { Injectable } from "@nestjs/common";
import {
  memberships,
  roles,
  storeAccess,
  stores,
  tenants,
  users,
  type StoreAccessKind,
} from "@data-pulse-2/db/schema";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNull } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";

/**
 * Active membership snapshot returned by `findActiveMembership`. We
 * deliberately do NOT return the entire `memberships` row — the guard
 * only needs the access-kind to decide which store-validation branch
 * to take.
 */
export interface ActiveMembership {
  readonly membershipId: string;
  readonly storeAccessKind: StoreAccessKind;
}

/**
 * Membership row decorated for the `ContextResponse.memberships[]`
 * payload. Joins `memberships` → `tenants` and `roles`, plus an
 * inline aggregation of `store_access` rows for `kind='specific'`.
 */
export interface MembershipSummary {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly roleCode: string;
  readonly storeAccessKind: StoreAccessKind;
  /**
   * For `kind='all'` this is `[]` — semantically "every store in the
   * tenant"; the dashboard treats `kind='all'` as a wildcard rather
   * than enumerating. For `kind='specific'`, the explicit list of
   * granted store IDs.
   */
  readonly accessibleStoreIds: readonly string[];
}

/**
 * Wire-shape for `GET /api/v1/tenants/:id/members`. Matches the
 * `MembershipDetail` schema in `tenants.openapi.yaml`.
 */
export interface MembershipDetail {
  readonly membershipId: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string | null;
  };
  readonly roleCode: string;
  readonly storeAccessKind: StoreAccessKind;
  /** Empty array when `storeAccessKind = 'all'`. */
  readonly accessibleStoreIds: readonly string[];
  readonly revokedAt: Date | null;
}

/** Tenant decoration for the active-tenant slot of `ContextResponse`. */
export interface TenantSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** Store decoration for the active-store slot of `ContextResponse`. */
export interface StoreSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

@Injectable()
export class MembershipRepository {
  private readonly db: NodePgDatabase;

  constructor(pool: Pool) {
    this.db = drizzle(pool);
  }

  /**
   * Return `true` iff the user exists, is not soft-deleted, and is
   * marked as a platform admin.
   *
   * Used by the guard to bypass per-tenant membership validation for
   * platform admins (FR-TEN-6).
   *
   * Queries only the `users` table, which has no RLS policy in the
   * foundation schema — safe to call on the plain pool without a GUC.
   */
  async isPlatformAdmin(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ isPlatformAdmin: users.isPlatformAdmin })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    return rows[0]?.isPlatformAdmin ?? false;
  }

  /**
   * Return the user's active membership in `tenantId`, or `null` if
   * none exists. "Active" means:
   *   - membership row exists,
   *   - `revoked_at IS NULL`,
   *   - `deleted_at IS NULL`.
   *
   * Callers translate `null` into a 404 (not 403) per FR-ISO-4 — the
   * absence of a membership must look identical to "tenant doesn't
   * exist" from outside the system.
   *
   * @param client — Optional `PoolClient` from `runWithTenantContext`.
   *   When provided the query runs inside the caller's GUC-scoped
   *   transaction so RLS is satisfied. When absent (unit tests, legacy
   *   callers) falls back to `this.db` (plain pool — caller is
   *   responsible for ensuring the plain pool has the necessary
   *   privileges, e.g. a superuser admin pool in test seeding).
   */
  async findActiveMembership(
    userId: string,
    tenantId: string,
    client?: PoolClient,
  ): Promise<ActiveMembership | null> {
    const db = client ? drizzle(client) : this.db;
    const rows = await db
      .select({
        membershipId: memberships.id,
        storeAccessKind: memberships.storeAccessKind,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.tenantId, tenantId),
          isNull(memberships.revokedAt),
          isNull(memberships.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      membershipId: row.membershipId,
      storeAccessKind: row.storeAccessKind as StoreAccessKind,
    };
  }

  /**
   * Returns true iff `storeId` is reachable from `(membershipId, tenantId)`
   * given the supplied access kind:
   *   - `'all'`  → store exists, is not soft-deleted, and belongs to the
   *                active tenant.
   *   - `'specific'` → all of the above AND a `store_access` row exists
   *                    for `(membershipId, storeId, tenantId)`.
   *
   * `false` is the cross-tenant / cross-store leak rejection signal;
   * the guard translates it into a 404 per FR-ISO-4.
   *
   * @param client — Optional `PoolClient` from `runWithTenantContext`.
   *   Same semantics as `findActiveMembership`.
   */
  async canAccessStore(
    membershipId: string,
    tenantId: string,
    storeId: string,
    kind: StoreAccessKind,
    client?: PoolClient,
  ): Promise<boolean> {
    const db = client ? drizzle(client) : this.db;

    // Step 1: confirm the store belongs to this tenant (and exists).
    const storeRows = await db
      .select({ id: stores.id })
      .from(stores)
      .where(
        and(
          eq(stores.id, storeId),
          eq(stores.tenantId, tenantId),
          isNull(stores.deletedAt),
        ),
      )
      .limit(1);
    if (!storeRows[0]) return false;
    if (kind === "all") return true;

    // Step 2 (only for 'specific'): require a store_access grant.
    const grantRows = await db
      .select({ membershipId: storeAccess.membershipId })
      .from(storeAccess)
      .where(
        and(
          eq(storeAccess.membershipId, membershipId),
          eq(storeAccess.storeId, storeId),
          eq(storeAccess.tenantId, tenantId),
        ),
      )
      .limit(1);
    return grantRows.length > 0;
  }

  /**
   * The store IDs a `'specific'` membership is granted within `tenantId`
   * (non-deleted stores only). `TenantContextGuard` publishes them as
   * `ResolvedContext.storeAccess` so store-scoped routes can authorize
   * against the target's store without an active store (RT-131).
   *
   * @param client — Optional `PoolClient` from `runWithTenantContext`.
   *   Same semantics as `findActiveMembership`.
   */
  async listGrantedStoreIds(
    membershipId: string,
    tenantId: string,
    client?: PoolClient,
  ): Promise<readonly string[]> {
    const db = client ? drizzle(client) : this.db;
    const rows = await db
      .select({ storeId: storeAccess.storeId })
      .from(storeAccess)
      .innerJoin(stores, eq(stores.id, storeAccess.storeId))
      .where(
        and(
          eq(storeAccess.membershipId, membershipId),
          eq(storeAccess.tenantId, tenantId),
          eq(stores.tenantId, tenantId),
          isNull(stores.deletedAt),
        ),
      );
    return rows.map((r) => r.storeId);
  }

  /**
   * List every active membership the user has, decorated with the
   * tenant name, role code, and accessible-store IDs (for
   * `kind='specific'`).
   *
   * Used by `GET /api/v1/context/me` to populate the `memberships[]`
   * array. We issue one query per membership for `accessible_store_ids`
   * — at typical scale (a user belongs to ≤ 5 tenants, ≤ tens of
   * stores per membership) this is bounded and cache-friendly. A
   * future Redis cache (FR-AUTH-6) will fold this into a single
   * lookup.
   *
   * @param client — Optional `PoolClient` from `runWithTenantContext`.
   *   Same semantics as `findActiveMembership`.
   */
  async listForUser(
    userId: string,
    client?: PoolClient,
  ): Promise<readonly MembershipSummary[]> {
    const db = client ? drizzle(client) : this.db;
    const baseRows = await this.activeMembershipRows(db, userId);

    const summaries: MembershipSummary[] = [];
    for (const row of baseRows) {
      const kind = row.storeAccessKind as StoreAccessKind;
      let accessible: readonly string[] = [];
      if (kind === "specific") {
        const grantRows = await db
          .select({ storeId: storeAccess.storeId })
          .from(storeAccess)
          .innerJoin(stores, eq(stores.id, storeAccess.storeId))
          .where(
            and(
              eq(storeAccess.membershipId, row.membershipId),
              isNull(stores.deletedAt),
            ),
          );
        accessible = grantRows.map((r) => r.storeId);
      }
      summaries.push({
        tenantId: row.tenantId,
        tenantName: row.tenantName,
        roleCode: row.roleCode,
        storeAccessKind: kind,
        accessibleStoreIds: accessible,
      });
    }
    return summaries;
  }

  /**
   * The same active memberships as `listForUser`, without the per-membership
   * `accessible_store_ids` queries: one query. Used by sign-in (RT-343), whose
   * response carries no store ids.
   *
   * @param client — Optional `PoolClient` from `runWithTenantContext`.
   */
  async listTenantRolesForUser(
    userId: string,
    client?: PoolClient,
  ): Promise<readonly Omit<MembershipSummary, "accessibleStoreIds">[]> {
    const db = client ? drizzle(client) : this.db;
    const rows = await this.activeMembershipRows(db, userId);
    return rows.map((row) => ({
      tenantId: row.tenantId,
      tenantName: row.tenantName,
      roleCode: row.roleCode,
      storeAccessKind: row.storeAccessKind as StoreAccessKind,
    }));
  }

  /** The user's unrevoked, undeleted memberships in undeleted tenants. */
  private activeMembershipRows(db: NodePgDatabase, userId: string) {
    return db
      .select({
        membershipId: memberships.id,
        tenantId: memberships.tenantId,
        tenantName: tenants.name,
        roleCode: roles.code,
        storeAccessKind: memberships.storeAccessKind,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(
        and(
          eq(memberships.userId, userId),
          isNull(memberships.revokedAt),
          isNull(memberships.deletedAt),
          isNull(tenants.deletedAt),
        ),
      );
  }

  /**
   * Tenant decoration for the active-tenant slot of `ContextResponse`.
   * Returns `null` when the tenant doesn't exist or is soft-deleted —
   * caller treats that as "no active context" (a session whose
   * `active_tenant_id` points at a now-deleted tenant should
   * gracefully resolve to `null` rather than fail).
   *
   * @param client — Optional `PoolClient` from `runWithTenantContext`.
   *   Same semantics as `findActiveMembership`.
   */
  async findTenantSummary(
    tenantId: string,
    client?: PoolClient,
  ): Promise<TenantSummary | null> {
    const db = client ? drizzle(client) : this.db;
    const rows = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
      })
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), isNull(tenants.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Store decoration for the active-store slot of `ContextResponse`.
   * Returns `null` for missing or soft-deleted stores. Same rationale
   * as `findTenantSummary` — the controller already validated access
   * before writing the active store, but a stale ID can survive a
   * soft-delete; rendering null is the graceful path.
   *
   * @param client — Optional `PoolClient` from `runWithTenantContext`.
   *   Same semantics as `findActiveMembership`.
   */
  async findStoreSummary(
    storeId: string,
    tenantId: string,
    client?: PoolClient,
  ): Promise<StoreSummary | null> {
    const db = client ? drizzle(client) : this.db;
    const rows = await db
      .select({
        id: stores.id,
        code: stores.code,
        name: stores.name,
      })
      .from(stores)
      .where(
        and(
          eq(stores.id, storeId),
          eq(stores.tenantId, tenantId),
          isNull(stores.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List every non-deleted, non-revoked membership in `tenantId`,
   * decorated with the user's profile, role code, and accessible-store
   * IDs for `kind='specific'` memberships.
   *
   * `client` MUST come from `runWithTenantContext(pool, { tenantId, ... })`
   * so that the `memberships_tenant_isolation` RLS policy is satisfied
   * by the `app.current_tenant` GUC. Passing a plain `Pool` connection
   * would cause the RLS predicate to fail and return an empty result.
   *
   * N+1 for store_access is bounded by the number of memberships in a
   * tenant (typically small in v1). A future Redis-backed aggregation
   * (FR-AUTH-6) will collapse this.
   */
  async listForTenant(
    client: PoolClient,
    tenantId: string,
  ): Promise<readonly MembershipDetail[]> {
    const db = drizzle(client);

    const baseRows = await db
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        userEmail: users.email,
        userDisplayName: users.displayName,
        roleCode: roles.code,
        storeAccessKind: memberships.storeAccessKind,
        revokedAt: memberships.revokedAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          isNull(memberships.deletedAt),
          isNull(memberships.revokedAt),
          isNull(users.deletedAt),
        ),
      );

    const details: MembershipDetail[] = [];
    for (const row of baseRows) {
      const kind = row.storeAccessKind as StoreAccessKind;
      let accessible: readonly string[] = [];
      if (kind === "specific") {
        const grantRows = await db
          .select({ storeId: storeAccess.storeId })
          .from(storeAccess)
          .innerJoin(stores, eq(stores.id, storeAccess.storeId))
          .where(
            and(
              eq(storeAccess.membershipId, row.membershipId),
              isNull(stores.deletedAt),
            ),
          );
        accessible = grantRows.map((r) => r.storeId);
      }
      details.push({
        membershipId: row.membershipId,
        user: {
          id: row.userId,
          email: row.userEmail,
          displayName: row.userDisplayName ?? null,
        },
        roleCode: row.roleCode,
        storeAccessKind: kind,
        accessibleStoreIds: accessible,
        revokedAt: row.revokedAt ?? null,
      });
    }
    return details;
  }

  /**
   * Look up the role code (e.g., `'tenant_admin'`, `'owner'`) for a
   * user's active membership in a given tenant. Returns `null` if no
   * active membership exists.
   *
   * Used by `TenantsService` to authorize `PATCH /tenants/:id` —
   * inline pending the `RolesGuard` / `@Roles()` refactor in
   * T200/T201, which will collapse this lookup into decorator
   * metadata.
   */
  async findRoleCodeForUserInTenant(
    userId: string,
    tenantId: string,
    client?: PoolClient,
  ): Promise<string | null> {
    const db = client ? drizzle(client) : this.db;
    const rows = await db
      .select({ code: roles.code })
      .from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.tenantId, tenantId),
          isNull(memberships.revokedAt),
          isNull(memberships.deletedAt),
        ),
      )
      .limit(1);
    return rows[0]?.code ?? null;
  }

  /**
   * Public-facing user summary for the `ContextResponse.user` slot.
   * Returns `null` for missing or soft-deleted users — defensive,
   * since the AuthGuard already validated the principal.
   */
  async findUserSummary(userId: string): Promise<{
    readonly id: string;
    readonly email: string;
    readonly displayName: string | null;
    readonly isPlatformAdmin: boolean;
  } | null> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isPlatformAdmin: users.isPlatformAdmin,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }
}
