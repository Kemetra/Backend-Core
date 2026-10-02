/**
 * RolesGuard — slice US5 (T201).
 *
 * Authorization primitive that consumes `@Roles()`, `@RolesFromParam()`,
 * and `@PlatformAdminOnly()` metadata (see `roles.decorator.ts`) and
 * decides whether the caller's principal + active tenant satisfy the
 * gate.
 *
 * Composition
 * -----------
 * Designed to run AFTER `AuthGuard` (and, on routes that use it, AFTER
 * `TenantContextGuard`):
 *
 *   @UseGuards(AuthGuard, TenantContextGuard, RolesGuard)
 *   @Roles("owner", "tenant_admin")
 *   @Patch(...)
 *
 * For path-as-context routes the chain is just:
 *
 *   @UseGuards(AuthGuard, RolesGuard)
 *   @RolesFromParam("id", "owner", "tenant_admin")
 *
 * Why no module wiring yet
 * ------------------------
 * This slice introduces the primitive only — no controller mounts it.
 * The retrofit of inline checks in `TenantsService` is intentionally a
 * separate PR. When the first controller actually applies it, that PR
 * will register the guard as a provider on the relevant module.
 *
 * Decision matrix
 * ---------------
 * The guard runs in this exact order; the first match wins.
 *
 *   1. No `RolesMetadata` on the route                 → 403 (default deny).
 *      Fail-closed posture: a handler with no decorator is unauthorized
 *      to everyone, including platform admins. Forces the team to opt in
 *      explicitly via `@Roles()` / `@PlatformAdminOnly()` / (future)
 *      `@Public()`.
 *
 *   2. No `request.principal`                          → 401.
 *      AuthGuard didn't run, or ran and failed silently. Either way,
 *      this is a wiring bug surfaced as Unauthorized — the correct
 *      shape for "no caller identity attached".
 *
 *   3. `@PlatformAdminOnly()` + caller is platform admin → allow.
 *      `@PlatformAdminOnly()` + caller is NOT             → 403.
 *      403 (not 404) per FR-ISO-4 split documented in
 *      `tenants.service.ts:23-29` — platform-admin status is
 *      self-knowable, so a forbidden response leaks no side-channel.
 *
 *   4. Platform-admin bypass for `@Roles` / `@RolesFromParam`.
 *      Platform authority comes ONLY from a session principal whose
 *      user has `users.is_platform_admin = true` (RT-132 D6 / RT-149).
 *      Token principals never get the bypass — whatever their scope,
 *      tenant binding (including `tenantId === null`) or user; they
 *      fall through to the tenant/membership checks below and fail
 *      closed there.
 *        a. session + `request.context?.isPlatformAdmin === true` → allow.
 *        b. session + `MembershipRepository.isPlatformAdmin(userId)` → allow.
 *           This covers path-as-context routes that don't mount
 *           `TenantContextGuard` (so 4a is unavailable).
 *
 *   5. Resolve tenant id from `RolesMetadata.tenantFrom`:
 *        - `"context"`     → `request.context?.tenantId`
 *                            null/undefined → 403 ("active tenant
 *                            required"). The caller authenticated but
 *                            hasn't picked a tenant; this is distinct
 *                            from "wrong tenant".
 *        - `"param:<key>"` → `request.params[<key>]`
 *                            null/undefined → 403 (route wiring bug —
 *                            decorator names a param the path doesn't
 *                            expose).
 *
 *   6. Extract user id from principal:
 *        - sessions always carry `userId`.
 *        - tokens may have `userId === null` (device-bound tokens). A
 *          userless token attempting a role-gated route is mapped to
 *          404 — same shape as "no membership" — to avoid leaking
 *          tenant existence.
 *
 *   7. `MembershipRepository.findRoleCodeForUserInTenant(userId, tenantId)`:
 *        - `null` or role NOT in `metadata.any`:
 *            - `metadata.denyAs === 404` (default)  → `NotFoundException`
 *               No active membership / wrong role rides the same shape
 *               as cross-tenant per FR-ISO-4. Use this for path-as-
 *               context routes where the tenant id IS a secret being
 *               protected (e.g. `PATCH /tenants/:id`).
 *            - `metadata.denyAs === 403`           → `ForbiddenException`
 *               Use when the caller is acting within their already-
 *               resolved active tenant and existence is not a secret
 *               (e.g. `POST /api/v1/stores`). Returning 404 there would
 *               be misleading.
 *        - role in `metadata.any`          → allow.
 *
 * No state, no caching, no ALS bridging. The guard is pure policy on
 * top of `request.principal`, `request.context`, and a single
 * repository call.
 */
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Pool, PoolClient } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db";

import type { Principal } from "./auth.guard";
import { PG_POOL } from "./auth.module";
import { MembershipRepository } from "../context/membership.repository";
import type { TenantContextRequest } from "../context/types";
import {
  ROLES_METADATA_KEY,
  type RoleCode,
  type RolesMetadata,
} from "./roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(MembershipRepository)
    private readonly memberships: MembershipRepository,
    /**
     * Optional: when present, the role-membership lookup runs inside
     * `runWithTenantContext({ tenantId: NIL_UUID, isPlatformAdmin: true })`
     * so `memberships`/`roles` RLS predicates resolve to the
     * platform-admin OR-branch (the alternative — running on a plain
     * non-superuser pool — throws `invalid input syntax for type uuid: ""`
     * because `current_setting('app.current_tenant', true)` returns ''
     * when unset and the RLS `::uuid` cast fails). Omitting this param
     * (unit tests that stub the repo) preserves the legacy plain-pool
     * fast path inside `MembershipRepository` itself.
     */
    @Optional() @Inject(PG_POOL) private readonly pool?: Pool,
  ) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.getAllAndOverride<
      RolesMetadata | undefined
    >(ROLES_METADATA_KEY, [execCtx.getHandler(), execCtx.getClass()]);

    // (1) Default deny.
    if (!metadata) throw forbidden("Forbidden");

    const request = execCtx.switchToHttp().getRequest<TenantContextRequest>();
    const principal = request.principal;

    // (2) No identity attached.
    if (!principal) throw unauthorized();

    // (3) Platform-admin-only branch.
    if (metadata.platformAdminOnly) {
      const isAdmin = await this.isPlatformAdmin(principal, request);
      if (isAdmin) return true;
      throw forbidden("Platform admin role required.");
    }

    // (4) Platform-admin bypass for @Roles / @RolesFromParam.
    if (await this.isPlatformAdmin(principal, request)) return true;

    // (5) Resolve tenant id.
    const tenantId = resolveTenantId(metadata, request);
    if (!tenantId) {
      throw forbidden(
        metadata.tenantFrom === "context"
          ? "Active tenant required."
          : "Tenant id missing from request path.",
      );
    }

    // (6) User id from principal.
    const userId = principal.userId;
    if (!userId) throw denied(metadata);

    // (7) Membership + role check. Runs in a platform-admin GUC context
    // so `memberships`/`roles` RLS predicates are satisfied on a
    // non-superuser pool (`app_test` in tests, `app_role` in prod).
    const role = await this.withBootstrapCtx((client) =>
      this.memberships.findRoleCodeForUserInTenant(userId, tenantId, client),
    );
    if (!role) throw denied(metadata);
    if (!isAcceptedRole(role, metadata.any)) throw denied(metadata);
    return true;
  }

  /**
   * Run `work` inside a platform-admin GUC context so RLS-protected
   * `memberships`/`roles` lookups succeed on a non-superuser app role.
   *
   * Uses the nil UUID (all-zeros) as `tenantId` rather than null so the
   * `::uuid` cast in the RLS predicate succeeds; access is granted via
   * the `is_platform_admin = 'true'` OR-branch. Falls back to a plain
   * passthrough (no client) when `this.pool` is absent — unit tests
   * that construct the guard directly stub the repository entirely.
   */
  private async withBootstrapCtx<T>(
    work: (client: PoolClient | undefined) => Promise<T>,
  ): Promise<T> {
    if (!this.pool) {
      return work(undefined);
    }
    return runWithTenantContext(
      this.pool,
      { tenantId: "00000000-0000-0000-0000-000000000000", isPlatformAdmin: true },
      (client) => work(client),
    );
  }

  /**
   * Platform-admin probe (see decision matrix #4). Session principals
   * only (RT-132 D6): a bearer token — including one with a null
   * tenant — never implies platform authority.
   *   - explicit context flag (TenantContextGuard already resolved it), or
   *   - fallback DB lookup for path-as-context routes.
   */
  private async isPlatformAdmin(
    principal: Principal,
    request: TenantContextRequest,
  ): Promise<boolean> {
    if (principal.kind !== "session") return false;
    if (request.context?.isPlatformAdmin === true) return true;
    return this.memberships.isPlatformAdmin(principal.userId);
  }
}

function resolveTenantId(
  metadata: RolesMetadata,
  request: TenantContextRequest,
): string | null {
  if (metadata.tenantFrom === "context") {
    return request.context?.tenantId ?? null;
  }
  // tenantFrom = `param:<key>` — extract the param name after the colon.
  const paramKey = metadata.tenantFrom.slice("param:".length);
  if (paramKey.length === 0) return null;
  const params = request.params as Record<string, string | undefined> | undefined;
  const value = params?.[paramKey];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

function isAcceptedRole(actual: string, accepted: readonly RoleCode[]): boolean {
  for (const code of accepted) {
    if (code === actual) return true;
  }
  return false;
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}

function forbidden(message: string): ForbiddenException {
  return new ForbiddenException(message);
}

function notFound(): NotFoundException {
  // 404 (not 403) for cross-tenant or wrong-role per FR-ISO-4: the
  // existence of the resource at this access level must look identical
  // to "doesn't exist".
  return new NotFoundException("Not Found");
}

/**
 * Translate a role-check failure to either 403 or 404 based on the
 * decorator's `denyAs` field. See `RolesMetadata.denyAs` and the
 * decision-matrix step 7 in the class docstring.
 */
function denied(
  metadata: RolesMetadata,
): ForbiddenException | NotFoundException {
  if (metadata.denyAs === 403) {
    return new ForbiddenException("Insufficient role.");
  }
  return notFound();
}
