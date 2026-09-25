/**
 * TenantsService — slice 12 (T131).
 *
 * Implements the five tenant-CRUD endpoints from
 * `specs/001-foundation-auth-tenant-store/contracts/tenants.openapi.yaml`.
 *
 * Path-as-context (not ALS-as-context)
 * ------------------------------------
 * Tenant ID for `:id`-routes comes from the URL path, NOT from
 * `request.context.tenantId`. The TenantContextGuard / ALS
 * pipeline (PRs #19/#20) is for store-scoped and active-tenant-scoped
 * operations; tenant-admin work on a specific tenant ID is
 * fundamentally different — the path IS the context. This service
 * therefore calls `runWithTenantContext` directly with the path
 * tenant id, NOT `runRequestScopedTenantContext`.
 *
 * Authorization model
 * -------------------
 * Role-based authorization moved to `RolesGuard` + decorators on
 * `TenantsController` (PR following T200/T201). The guard owns:
 *
 *   - Platform-admin-only gating for `POST /tenants` and
 *     `DELETE /tenants/:id` (`@PlatformAdminOnly()`, 403 on deny).
 *   - Tenant role-set gating for `PATCH /tenants/:id`
 *     (`@RolesFromParam("id", "owner", "tenant_admin")`, 404 on
 *     deny per FR-ISO-4).
 *
 * Methods on this service are reached only after the guard has
 * authorized the caller. The remaining principal-driven branches in
 * `list` / `read` / `update` are NOT authz — they pick the **data
 * path** (admin sees all, member sees own) and the **RLS context**
 * for `runWithTenantContext` (`is_platform_admin` GUC).
 *
 * Error contract (FR-ISO-4 split — enforced by the guard for write
 * routes, by this service for read/list visibility):
 *   - **403** for platform-admin-only operations (`POST`, `DELETE`).
 *     The caller can determine their own platform-admin status via
 *     `GET /context/me`, so a 403 leaks no side-channel info.
 *   - **404** for tenant-membership operations (`GET /:id`,
 *     `PATCH /:id`). Distinguishing "wrong tenant" from "doesn't
 *     exist" would defeat tenant-enumeration defenses.
 *
 * Soft-delete visibility
 * ----------------------
 * The OpenAPI contract is silent on whether platform admins see
 * soft-deleted tenants on GET. Decision: yes. Rationale: restoration
 * UX requires it; the RLS policy already permits cross-tenant reads
 * for `is_platform_admin = 'true'`. Regular users never see
 * soft-deleted rows.
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";
import {
  runWithTenantContext,
  type TenantContext,
} from "@data-pulse-2/db";
import type { Principal } from "../auth/auth.guard";
import { PG_POOL } from "../auth/auth.module";
import {
  MembershipRepository,
  type MembershipDetail,
} from "../context/membership.repository";
import {
  TenantsRepository,
  type TenantRecord,
} from "./tenants.repository";

/**
 * The function the service calls to enter a tenant-scoped transaction.
 * Defaults to the real `runWithTenantContext` from `@data-pulse-2/db`;
 * tests inject a passthrough that fabricates a `PoolClient`-shaped
 * object so the orchestration logic can be exercised without a real
 * Postgres pool.
 */
type TenantTxRunner = <T>(
  pool: Pool,
  ctx: TenantContext,
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

@Injectable()
export class TenantsService {
  private readonly tx: TenantTxRunner;

  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
    private readonly tenants: TenantsRepository,
    private readonly memberships: MembershipRepository,
    /**
     * Optional injected runner for tests. Production callers omit it.
     */
    @Optional() tx?: TenantTxRunner,
  ) {
    this.tx = tx ?? runWithTenantContext;
  }

  // ===== LIST =======================================================

  /**
   * `GET /api/v1/tenants`. Behaviour depends on actor:
   *   - Platform admin → all non-deleted tenants.
   *   - Regular user   → tenants the user has an active membership in.
   *
   * Token principals: a token bound to a single tenant returns just
   * that tenant when found; platform-scoped tokens follow the
   * platform-admin path. Unbound user-less tokens return an empty list.
   */
  async list(principal: Principal): Promise<TenantRecord[]> {
    const userId = await this.resolveActingUserId(principal);
    if (await this.isPlatformAdmin(principal, userId)) {
      return this.tx(
        this.pool,
        { tenantId: null, isPlatformAdmin: true },
        (client) => this.tenants.listAll(client),
      );
    }
    if (!userId) return [];
    // This cross-tenant read is constrained by the authenticated user ID.
    // RLS needs a transaction-local bootstrap context to see memberships.
    return this.tx(
      this.pool,
      { tenantId: null, isPlatformAdmin: true },
      (client) => this.tenants.listForUser(client, userId),
    );
  }

  // ===== CREATE =====================================================

  /**
   * `POST /api/v1/tenants`. Platform-admin only (Q1 default A) — gated
   * by `@PlatformAdminOnly()` on the controller, so this service trusts
   * the caller has already been authorized.
   *
   * Atomically:
   *   1. Insert the tenants row (RLS bypassed via is_platform_admin GUC,
   *      which is sound because only platform admins reach this method).
   *   2. Seed default tenant-scoped roles (owner / tenant_admin /
   *      store_manager / store_staff). All 4 rows + tenant row commit
   *      in one transaction.
   *
   * Slug uniqueness is enforced by the DB partial unique index
   * `tenants_slug_active_uidx` on `lower(slug)` where
   * `deleted_at IS NULL`. A duplicate raises `23505` which we map to
   * `ConflictException` (409).
   *
   * Note: `principal` is accepted for symmetry with the other methods
   * and for future audit-emit hooks; the current implementation does
   * not branch on it.
   */
  async create(
    _principal: Principal,
    input: { slug: string; name: string },
  ): Promise<TenantRecord> {
    const tenantId = newId();
    try {
      return await this.tx(
        this.pool,
        { tenantId, isPlatformAdmin: true },
        async (client) => {
          const tenant = await this.tenants.create(client, {
            id: tenantId,
            slug: input.slug,
            name: input.name,
          });
          await this.tenants.seedDefaultRoles(client, tenantId);
          return tenant;
        },
      );
    } catch (err) {
      if (isUniqueViolation(err, "tenants_slug_active_uidx")) {
        throw new ConflictException("Slug already in use.");
      }
      throw err;
    }
  }

  // ===== READ =======================================================

  /**
   * `GET /api/v1/tenants/:id`. Returns 404 (not 403) for non-access:
   *   - tenant doesn't exist
   *   - tenant exists but caller is not a platform admin and has no
   *     active membership
   *   - tenant exists, caller is a regular user, but tenant is
   *     soft-deleted (platform admins still see soft-deleted rows
   *     so they can restore)
   */
  async read(
    principal: Principal,
    tenantId: string,
  ): Promise<TenantRecord> {
    const userId = await this.resolveActingUserId(principal);
    const isAdmin = await this.isPlatformAdmin(principal, userId);

    if (isAdmin) {
      const row = await this.tx(
        this.pool,
        { tenantId, isPlatformAdmin: true },
        (client) => this.tenants.findByIdAdmin(client, tenantId),
      );
      if (!row) throw notFound();
      return row;
    }

    if (!userId) throw notFound();
    const role = await this.tx(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      (client) => this.memberships.findRoleCodeForUserInTenant(userId, tenantId, client),
    );
    if (!role) throw notFound();

    return this.tx(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const row = await this.tenants.findById(client, tenantId);
        if (!row) throw notFound();
        return row;
      },
    );
  }

  // ===== UPDATE =====================================================

  /**
   * `PATCH /api/v1/tenants/:id`. Authorization is handled by
   * `RolesGuard` on the controller (`@RolesFromParam("id", "owner",
   * "tenant_admin")`); cross-tenant and insufficient-role attempts are
   * rejected as 404 there per FR-ISO-4 before this service runs.
   *
   * The `isPlatformAdmin` lookup that remains is **not** authz — it
   * selects the RLS context for `runWithTenantContext`. Platform
   * admins commit with `app.is_platform_admin = 'true'` (RLS bypass);
   * tenant members commit with the GUC unset (RLS scopes the UPDATE
   * to their tenant). Removing this would leave the tenant-member path
   * unable to satisfy the `tenants` UPDATE policy.
   *
   * The `if (!row) throw notFound()` after the UPDATE handles a
   * narrow race: a concurrent soft-delete between the guard's
   * membership check and this UPDATE.
   */
  async update(
    principal: Principal,
    tenantId: string,
    next: { name?: string | undefined; status?: "active" | "suspended" | undefined },
  ): Promise<TenantRecord> {
    const userId = await this.resolveActingUserId(principal);
    const isAdmin = await this.isPlatformAdmin(principal, userId);

    return this.tx(
      this.pool,
      { tenantId, isPlatformAdmin: isAdmin },
      async (client) => {
        const row = await this.tenants.update(client, tenantId, next);
        if (!row) throw notFound();
        return row;
      },
    );
  }

  // ===== DELETE =====================================================

  /**
   * `DELETE /api/v1/tenants/:id`. Platform-admin only — gated by
   * `@PlatformAdminOnly()` on the controller. Returns void; controller
   * maps to 204.
   *
   * `principal` is accepted for symmetry / future audit hooks.
   */
  async softDelete(
    _principal: Principal,
    tenantId: string,
  ): Promise<void> {
    await this.tx(
      this.pool,
      { tenantId, isPlatformAdmin: true },
      async (client) => {
        await this.tenants.softDelete(client, tenantId);
      },
    );
  }

  // ===== LIST MEMBERS ===============================================

  /**
   * `GET /api/v1/tenants/:id/members`. Returns all non-deleted,
   * non-revoked memberships in `tenantId`.
   *
   * Authorization is handled by `RolesGuard` on the controller
   * (`@RolesFromParam("id", "owner", "tenant_admin")`); callers that
   * reach this method are already confirmed as tenant_admin/owner or
   * platform admin.
   *
   * Runs inside `runWithTenantContext` so the RLS policy
   * `memberships_tenant_isolation` is satisfied via the
   * `app.current_tenant` GUC. Platform admins use
   * `isPlatformAdmin: true` to also satisfy the
   * `app.is_platform_admin` bypass clause.
   */
  async listMembers(
    principal: Principal,
    tenantId: string,
  ): Promise<readonly MembershipDetail[]> {
    const userId = await this.resolveActingUserId(principal);
    const isAdmin = await this.isPlatformAdmin(principal, userId);

    return this.tx(
      this.pool,
      { tenantId, isPlatformAdmin: isAdmin },
      async (client) => {
        return this.memberships.listForTenant(client, tenantId);
      },
    );
  }

  // ===== INTERNALS ==================================================

  /**
   * Returns the user id behind the principal, or `null` for tokens
   * that don't carry one. Sessions ALWAYS have a userId.
   */
  private async resolveActingUserId(
    principal: Principal,
  ): Promise<string | null> {
    if (principal.kind === "session") return principal.userId;
    return principal.userId; // may be null for device-bound tokens
  }

  /**
   * Resolve platform-admin status. Token principals with
   * `tenantId === null` are platform-scoped (PR #19 design); session
   * principals consult the `users.is_platform_admin` flag via
   * `MembershipRepository`.
   */
  private async isPlatformAdmin(
    principal: Principal,
    userId: string | null,
  ): Promise<boolean> {
    if (principal.kind === "token" && principal.tenantId === null) {
      return true;
    }
    if (!userId) return false;
    return this.memberships.isPlatformAdmin(userId);
  }

}

function notFound(): NotFoundException {
  return new NotFoundException("Not Found");
}

/**
 * Detect a Postgres unique-constraint violation (`SQLSTATE 23505`) on
 * a specific constraint name. Used to map slug duplicates to 409.
 *
 * Drizzle wraps the underlying `pg` error in a `DrizzleQueryError` whose
 * `.cause` carries the `pg.DatabaseError` with `code='23505'` and the
 * constraint name. We recurse one level into `.cause` so the wrapping
 * doesn't defeat the check.
 */
function isUniqueViolation(err: unknown, constraintName: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    code?: string;
    constraint?: string;
    message?: string;
    cause?: unknown;
  };
  if (e.code === "23505") {
    if (e.constraint === constraintName) return true;
    if (typeof e.message === "string" && e.message.includes(constraintName)) {
      return true;
    }
  }
  if (e.cause && typeof e.cause === "object") {
    return isUniqueViolation(e.cause, constraintName);
  }
  return typeof e.message === "string" && e.message.includes(constraintName);
}
