/**
 * TenantContextGuard — slice 9 (T151).
 *
 * Resolves the active **tenant** + **store** context for an
 * authenticated request and publishes it as `request.context`.
 *
 * Composition
 * -----------
 * Designed to run AFTER `AuthGuard` in the guard pipeline:
 *
 *     @UseGuards(AuthGuard, TenantContextGuard)
 *
 * `AuthGuard` populates `request.principal`. This guard reads that
 * field and resolves the active tenant / store via the appropriate
 * source for each principal kind:
 *
 *   - `kind === "session"` — `SessionRepository.findActiveById(...)`,
 *     then `session.activeTenantId` / `session.activeStoreId`.
 *   - `kind === "token"` — `principal.tenantId` (baked at issuance);
 *     storeId from `principal` if/when tokens carry one (today the
 *     `Principal` type only exposes `tenantId`, so storeId resolves
 *     to `null` for tokens — a future slice can add it).
 *
 * Validation
 * ----------
 * For session principals (the common dashboard path):
 *
 *   - **No `principal`**         → `UnauthorizedException`.
 *   - **No active tenant**       → `UnauthorizedException`. The caller
 *                                  has authenticated but hasn't picked
 *                                  a tenant yet (FR-CTX-1).
 *   - **No active membership**   → `NotFoundException` (FR-ISO-4 — do
 *                                  not leak that the tenant exists).
 *   - **Cross-tenant store**     → `NotFoundException`.
 *   - **Cross-store policy**     → `NotFoundException` (membership has
 *                                  `kind='specific'`, no `store_access`
 *                                  row).
 *
 * Platform admins (`users.is_platform_admin = true`) bypass the
 * membership check (FR-TEN-6); they may have an active tenant set
 * without a membership row. Store-access validation still applies if
 * `activeStoreId` is set, falling back to the `'all'` branch.
 *
 * Token principals
 * ----------------
 * Tokens carry a tenant binding from issuance. We do NOT re-validate
 * the tenant per-request in this slice; if the tenant was deleted, the
 * eventual DB middleware (T155) sets `app.current_tenant` to the
 * deleted UUID and RLS naturally returns no rows — defence in depth.
 *
 * A token with `principal.tenantId === null` fails closed with
 * `UnauthorizedException` (RT-132 D6 / RT-149). Platform authority
 * comes only from a session user with `users.is_platform_admin =
 * true`; a bearer token never implies it, so token contexts always
 * resolve with `isPlatformAdmin: false`.
 *
 * What this guard does NOT do
 * ---------------------------
 *   - Set the Postgres GUCs (`app.current_tenant`,
 *     `app.is_platform_admin`). That's the DB middleware's job (T155).
 *   - Wrap downstream handlers in `runInContext(...)`. That's the
 *     companion interceptor's job (also T155). The guard exposes
 *     `runInContext` / `getResolvedContext` from `context.als.ts` so
 *     the interceptor can bridge `request.context` into the ALS once
 *     it lands.
 *   - Audit context switches. That's `ContextController` (T152/T153).
 */
import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Principal } from "../auth/auth.guard";
import { PG_POOL } from "../auth/auth.module";
import { SessionRepository } from "../auth/session.repository";
import {
  recordCrossTenantRejection,
  recordTenantContextFailure,
} from "../observability/metrics/api.metrics";
import { recordDbRlsContextFailure } from "../observability/metrics/db.metrics";
import { MembershipRepository } from "./membership.repository";
import type {
  ResolvedContext,
  StoreAccess,
  TenantContextRequest,
} from "./types";

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(SessionRepository)
    private readonly sessions: SessionRepository,
    @Inject(MembershipRepository)
    private readonly memberships: MembershipRepository,
    /**
     * Optional: when present, membership lookups inside `resolveSession`
     * run inside `runWithTenantContext({ tenantId: NIL_UUID,
     * isPlatformAdmin: true })` so RLS is satisfied even when the app
     * pool is a non-superuser (`app_test` in tests, the production
     * `app_role` in production). The nil UUID avoids the
     * `invalid input syntax for type uuid: ""` error that occurs when
     * `tenantId: null` maps to an empty GUC string that the `::uuid`
     * cast cannot parse. Omitting this param (unit tests that stub the
     * repo) falls back to the plain `this.db` surface.
     */
    @Optional() @Inject(PG_POOL) private readonly pool?: Pool,
  ) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const request = execCtx.switchToHttp().getRequest<TenantContextRequest>();
    const principal = request.principal;
    if (!principal) throw unauthorized();

    try {
      const resolved = await this.resolve(principal);
      request.context = resolved;
      return true;
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Cross-tenant or cross-store rejection: the session's active
        // tenant/store context was established but the membership or store
        // access check failed. Both signals increment together per
        // signals.md §1 note: "both increment together for the same incident."
        // No tenant/store IDs in labels (FR-B-006).
        const route = routeTemplate(execCtx);
        recordCrossTenantRejection({ route });
        recordTenantContextFailure({ reason: "cross_tenant" });
      }
      throw err;
    }
  }

  /**
   * Top-level dispatch on principal kind. Public-on-class so tests can
   * call it directly without going through the Nest `ExecutionContext`
   * shim.
   */
  async resolve(principal: Principal): Promise<ResolvedContext> {
    if (principal.kind === "token") {
      return this.resolveToken(principal);
    }
    return this.resolveSession(principal);
  }

  private resolveToken(
    principal: Extract<Principal, { kind: "token" }>,
  ): ResolvedContext {
    // RT-132 D6: a null-tenant bearer token carries no tenant and no
    // platform authority — fail closed rather than resolve a context.
    if (principal.tenantId === null) throw unauthorized();
    return {
      userId: principal.userId,
      tenantId: principal.tenantId,
      // Token store binding (002 FR-POS-AUTH-4): pos_operator tokens are issued
      // bound to a specific (tenant_id, store_id) at sign-in, and AuthGuard now
      // propagates storeId from auth_tokens.store_id into the Principal. For
      // dashboard_api / pos scopes the column is null and we pass through.
      storeId: principal.storeId,
      isPlatformAdmin: false,
      source: "token",
    };
  }

  private async resolveSession(
    principal: Extract<Principal, { kind: "session" }>,
  ): Promise<ResolvedContext> {
    const session = await this.sessions.findActiveById(principal.sessionId);
    // AuthGuard already validated the session; treat a now-missing/expired
    // row as an unauthenticated edge case (TOCTOU between guards).
    if (!session) throw unauthorized();
    if (!session.activeTenantId) throw unauthorized();

    const tenantId = session.activeTenantId;
    const storeId = session.activeStoreId;

    // `isPlatformAdmin` queries only `users` — no RLS, safe on plain pool.
    const isPlatformAdmin = await this.memberships.isPlatformAdmin(
      principal.userId,
    );

    // RT-131: the membership's store authority, published so store-scoped
    // routes never infer it from a null active store. Platform admins are
    // tenant-wide (FR-TEN-6).
    let storeAccess: StoreAccess = { kind: "all" };

    if (!isPlatformAdmin) {
      // FR-CTX-2: validate active membership.
      // FR-CTX-3: validate active-store reachability if set.
      // Both queries touch RLS-protected tables (`memberships`,
      // `store_access`, `stores`). Run them inside a platform-admin GUC
      // context when a pool is available so non-superuser app roles can
      // satisfy the RLS predicates.
      await this.withBootstrapCtx(async (client) => {
        const membership = await this.memberships.findActiveMembership(
          principal.userId,
          tenantId,
          client,
        );
        if (!membership) throw notFound();

        if (storeId !== null) {
          const ok = await this.memberships.canAccessStore(
            membership.membershipId,
            tenantId,
            storeId,
            membership.storeAccessKind,
            client,
          );
          if (!ok) throw notFound();
        }

        if (membership.storeAccessKind === "specific") {
          storeAccess = {
            kind: "specific",
            storeIds: await this.memberships.listGrantedStoreIds(
              membership.membershipId,
              tenantId,
              client,
            ),
          };
        }
      });
    } else if (storeId !== null) {
      // Platform admin with an active store: only validate the store
      // belongs to the active tenant (no membership/access policy
      // applies to platform admins). The repo's 'all' branch does
      // exactly that check; we pass a synthetic membershipId because
      // 'all' never references it.
      await this.withBootstrapCtx(async (client) => {
        const ok = await this.memberships.canAccessStore(
          "00000000-0000-0000-0000-000000000000",
          tenantId,
          storeId,
          "all",
          client,
        );
        if (!ok) throw notFound();
      });
    }

    return {
      userId: principal.userId,
      tenantId,
      storeId,
      isPlatformAdmin,
      source: "session",
      storeAccess,
    };
  }

  /**
   * Run `work` inside a platform-admin GUC context so RLS-protected
   * membership/store tables are readable by a non-superuser app role.
   *
   * Uses `runWithTenantContext(pool, { tenantId: null,
   * isPlatformAdmin: true }, work)` — the null tenantId maps to `""`
   * which fails the UUID cast in the RLS predicate, but the
   * `is_platform_admin = 'true'` OR-branch satisfies it regardless.
   *
   * Falls back to a plain async-passthrough when `this.pool` is
   * undefined (unit-test callers that construct the guard without a
   * pool and stub the repository). In that scenario the `PoolClient`
   * parameter will be `undefined` and `MembershipRepository` falls
   * back to `this.db` — which is fine because unit tests stub the
   * repository entirely.
   */
  private async withBootstrapCtx(
    work: (client: PoolClient | undefined) => Promise<void>,
  ): Promise<void> {
    if (!this.pool) {
      // Unit-test path: no real pool, repository is stubbed.
      return work(undefined);
    }
    // Use the nil UUID (all-zeros) rather than null so the `::uuid` cast
    // in RLS policies succeeds. `tenant_id = '00000000-…'` evaluates to
    // `false` for every real tenant; access is granted via the
    // `is_platform_admin = 'true'` OR-branch. Passing null would set the
    // GUC to "" which throws `invalid input syntax for type uuid: ""`.
    //
    // `return await` (not bare `return`) so that promise rejections are
    // caught by the try-catch below. Without `await`, a rejected promise
    // propagates after the try frame has exited.
    try {
      return await runWithTenantContext(
        this.pool,
        { tenantId: "00000000-0000-0000-0000-000000000000", isPlatformAdmin: true },
        (client) => work(client),
      );
    } catch (err) {
      // Application-level rejections (NotFoundException, UnauthorizedException)
      // originate from the work function and are not DB/RLS bootstrap failures.
      // Only non-HttpException errors indicate a real DB-layer failure:
      // connection refused, GUC cast error, pool exhaustion, etc. (T476).
      if (!(err instanceof HttpException)) {
        recordDbRlsContextFailure();
      }
      throw err;
    }
  }
}

/**
 * Extract the route template from an ExecutionContext using NestJS
 * decorator metadata. Returns the controller + handler path in the form
 * `/api/v1/tenants/:id/members`, or `"unknown"` when metadata is absent
 * (e.g., in unit tests with stub controllers).
 *
 * Uses `route` template (not rendered URL) per signals.md §6: rendered
 * paths carry tenant/store IDs which are forbidden as metric labels
 * (FR-B-006). The template `/:id` is safe; the value `/:uuid` is not.
 */
function routeTemplate(execCtx: ExecutionContext): string {
  try {
    // `reflect-metadata` is loaded by NestJS at bootstrap; Reflect.getMetadata
    // is available in all NestJS guard/interceptor call sites.
    const controllerPath =
      (Reflect.getMetadata("path", execCtx.getClass()) as string | undefined) ?? "";
    const handlerPath =
      (Reflect.getMetadata("path", execCtx.getHandler()) as string | undefined) ?? "";
    const joined = `/${controllerPath}/${handlerPath}`.replace(/\/+/g, "/");
    // Trim trailing slash so "/api/v1/tenants/" becomes "/api/v1/tenants".
    return joined.replace(/\/$/, "") || "unknown";
  } catch {
    return "unknown";
  }
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}

function notFound(): NotFoundException {
  // 404 (not 403) per FR-ISO-4: error responses must NOT distinguish
  // "resource exists in another tenant" from "resource does not exist".
  return new NotFoundException("Not Found");
}
