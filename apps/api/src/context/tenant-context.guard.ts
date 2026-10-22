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
 * membership-role check (FR-TEN-6); they may have an active tenant set
 * without a membership row. Store-access validation still applies if
 * `activeStoreId` is set, falling back to the `'all'` branch.
 *
 * Support sessions (RT-414)
 * -------------------------
 * A platform admin with NO live membership in the active tenant (whatever
 * the tenant's status) is admitted only through an `active` support session
 * for exactly that tenant (`SupportSessionGate`): otherwise 403
 * `support_session_required` / `support_session_expired` /
 * `support_session_read_only` (a suspended tenant). Each such request writes
 * one `platform.cross_tenant.accessed` row. A platform admin who IS a member
 * resolves exactly as before. Without a pool (unit tests) the non-member case
 * fails closed with `support_session_required`.
 *
 * Token principals
 * ----------------
 * Tokens carry a tenant binding from issuance. A `dashboard_api` token is
 * re-checked per request against its tenant's status (RT-669): a token of
 * a suspended, pending or soft-deleted tenant fails with the same
 * `UnauthorizedException` an invalid token gets. Other bearer scopes are
 * not re-checked here (POS scopes are refused on the device path, RT-213).
 *
 * Tenant status (RT-669)
 * ----------------------
 * A session of a non-platform-admin whose active tenant is not active
 * (`status = 'active' AND deleted_at IS NULL`) fails the membership check:
 * `findActiveMembership` applies the rule, so the refusal is the existing
 * non-disclosing 404. Platform admins are exempt so they can enter and
 * reactivate the tenant.
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
import { assignRequestId } from "../common/request-id.interceptor";
import { recordDbRlsContextFailure } from "../observability/metrics/db.metrics";
import { routeTemplate } from "../platform-support-sessions/support-session.coverage";
import {
  SupportSessionGate,
  supportSessionRefusal,
} from "../platform-support-sessions/support-session.gate";
import { MembershipRepository } from "./membership.repository";
import type {
  ResolvedContext,
  StoreAccess,
  TenantContextRequest,
} from "./types";

/** The request facts the RT-414 audit row records (never the concrete path). */
export interface RequestAccess {
  readonly method: string;
  readonly route: string;
  /** Assigns the request id on first use (only a support-session row needs it). */
  readonly requestId: () => string | null;
}

export { routeTemplate };

const UNKNOWN_ACCESS: RequestAccess = { method: "GET", route: "unknown", requestId: () => null };

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
      const resolved = await this.resolve(principal, {
        method: request.method ?? "GET",
        route: routeTemplate(execCtx),
        requestId: () => assignRequestId(request, execCtx.switchToHttp().getResponse()),
      });
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
  async resolve(
    principal: Principal,
    access: RequestAccess = UNKNOWN_ACCESS,
  ): Promise<ResolvedContext> {
    if (principal.kind === "token") {
      return this.resolveToken(principal);
    }
    return this.resolveSession(principal, access);
  }

  private async resolveToken(
    principal: Extract<Principal, { kind: "token" }>,
  ): Promise<ResolvedContext> {
    // RT-132 D6: a null-tenant bearer token carries no tenant and no
    // platform authority — fail closed rather than resolve a context.
    if (principal.tenantId === null) throw unauthorized();
    // RT-669: a console token of a non-active tenant reads as an invalid token.
    if (principal.scope === "dashboard_api") {
      const tenantId = principal.tenantId;
      let active = false;
      await this.withBootstrapCtx(async (client) => {
        active = await this.memberships.isTenantActive(tenantId, client);
      });
      if (!active) throw unauthorized();
    }
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
    access: RequestAccess,
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
    } else {
      await this.admitPlatformAdmin(principal, tenantId, storeId, access);
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
   * Platform admin: RT-414 first (a member passes as before; a non-member
   * needs an active support session for `tenantId`, and the gate records the
   * request), then, with an active store, only the store-belongs-to-tenant
   * check (no membership/access policy applies to platform admins). The
   * repo's 'all' branch does exactly that check; the synthetic membershipId
   * is never referenced by 'all'.
   */
  private async admitPlatformAdmin(
    principal: Extract<Principal, { kind: "session" }>,
    tenantId: string,
    storeId: string | null,
    access: RequestAccess,
  ): Promise<void> {
    let member = false;
    await this.withBootstrapCtx(async (client) => {
      member = await this.memberships.hasLiveMembership(principal.userId, tenantId, client);
    });
    if (!member) await this.enforceSupportSession(principal, tenantId, access);
    if (storeId === null) return;
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

  private async enforceSupportSession(
    principal: Extract<Principal, { kind: "session" }>,
    tenantId: string,
    access: RequestAccess,
  ): Promise<void> {
    if (!this.pool) throw supportSessionRefusal("support_session_required");
    await new SupportSessionGate(this.pool).enforce(tenantId, {
      authSessionId: principal.sessionId,
      userId: principal.userId,
      method: access.method,
      route: access.route,
      requestId: access.requestId(),
    });
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

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}

function notFound(): NotFoundException {
  // 404 (not 403) per FR-ISO-4: error responses must NOT distinguish
  // "resource exists in another tenant" from "resource does not exist".
  return new NotFoundException("Not Found");
}
