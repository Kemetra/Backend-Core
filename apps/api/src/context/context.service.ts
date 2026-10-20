/**
 * ContextService — slice 11 (T153).
 *
 * Orchestrates active tenant / store switching for an authenticated
 * session, plus the read-side `GET /context/me` payload. Conforms to
 * `specs/001-foundation-auth-tenant-store/contracts/context.openapi.yaml`.
 *
 * Cross-cutting policies (FR-CTX, FR-ISO-4)
 * ----------------------------------------
 *   - **Cross-tenant / cross-store rejections are 404, never 403.**
 *     `NotFoundException` makes "wrong tenant" indistinguishable from
 *     "doesn't exist" — defeats tenant-enumeration side channels
 *     (FR-ISO-4).
 *   - **No active tenant when switching store → 409**
 *     (`ConflictException`). The OpenAPI contract dedicates this
 *     status to the "must switch tenant first" UX.
 *   - **Tenant switch auto-clears active store.**
 *     [contracts/context.openapi.yaml line 41]: "Active tenant
 *     switched. Active store is cleared."
 *   - **Token principals cannot switch context.** Tokens carry their
 *     tenant binding from issuance (PR #19 design); changing it
 *     server-side would silently void the issuer's contract.
 *     `BadRequestException` with a clear diagnostic.
 *
 * Design seams
 * ------------
 *   - Reads/writes session active-context via `SessionRepository`.
 *     `updateActiveContext` returns `null` on revoked/missing
 *     sessions; we map to `UnauthorizedException` (TOCTOU).
 *   - Validates membership / store-access via `MembershipRepository`.
 *     Reuses `findActiveMembership` and `canAccessStore` from PR #19;
 *     `listForUser`, `findTenantSummary`, `findStoreSummary`,
 *     `findUserSummary` are this slice's additions.
 *   - Platform-admin sessions bypass the per-tenant membership check
 *     (FR-TEN-6). `active_role_code` is `null` for platform admins
 *     unless they happen to have a normal membership too.
 *   - RT-414: a platform admin enters a tenant they are NOT a member of
 *     only through `openSupportSession`. `switchTenant` refuses that case
 *     with 403 `support_session_required`, and ends any live support
 *     session of the auth session (`tenant_switched`) before switching.
 *     `switchStore` for a non-member platform admin goes through
 *     `SupportSessionGate` (one `platform.cross_tenant.accessed` row).
 *     `support_session` on the response is the caller's live support
 *     session for the active tenant, or null.
 *
 * What this service does NOT do
 * -----------------------------
 *   - Audit context switches. The interceptor / emitter for that
 *     lands with US6 (T230+). The header here documents the seam.
 *   - Auto-set active tenant on first sign-in for users with exactly
 *     one membership. Spec §6.6 mentions this but it's an
 *     `AuthService`-layer decision, deferred.
 *   - Run inside `runRequestScopedTenantContext`. The context
 *     endpoints are intentionally NOT tenant-guarded (you must be
 *     able to switch FROM no-context); they read auxiliary tables
 *     directly via `MembershipRepository`'s plain-Pool surface.
 */
import {
  BadRequestException,
  ConflictException,
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
  SupportSessionGate,
  supportSessionRefusal,
} from "../platform-support-sessions/support-session.gate";
import {
  endSupportSessions,
  readLiveSupportSession,
} from "../platform-support-sessions/support-session.lifecycle";
import {
  toSupportSessionSummary,
  type SupportSessionSummaryBody,
} from "../platform-support-sessions/support-session.store";
import {
  MembershipRepository,
  type MembershipSummary,
  type StoreSummary,
  type TenantSummary,
} from "./membership.repository";

/**
 * Shape returned by every endpoint of this controller. Mirrors
 * `ContextResponse` from `context.openapi.yaml`. Snake-case keys
 * because that's the wire shape; the controller hands this back
 * verbatim.
 */
export interface ContextResponseBody {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly display_name: string | null;
    readonly is_platform_admin: boolean;
  };
  readonly active_tenant: TenantSummary | null;
  readonly active_store: StoreSummary | null;
  readonly active_role_code: string | null;
  readonly memberships: ReadonlyArray<{
    readonly tenant_id: string;
    readonly tenant_name: string;
    readonly role_code: string;
    readonly store_access_kind: MembershipSummary["storeAccessKind"];
    readonly accessible_store_ids: readonly string[];
  }>;
  /** RT-414: the caller's live support session for the active tenant, or null. */
  readonly support_session: SupportSessionSummaryBody | null;
}

const SWITCH_STORE_ROUTE = "/api/v1/context/store";

/** Domain aliases for ids (UUIDs). */
type UserId = string;
type TenantId = string;
type AuthSessionId = string;

@Injectable()
export class ContextService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly memberships: MembershipRepository,
    /**
     * Optional: when present, RLS-protected membership/store lookups run
     * inside `runWithTenantContext({ tenantId: null, isPlatformAdmin: true })`
     * so a non-superuser app role can read those tables. Omitting it
     * (unit tests that construct `ContextService` directly) falls back to
     * the plain-pool surface of `MembershipRepository` — those callers
     * always stub the repo anyway.
     */
    @Optional() @Inject(PG_POOL) private readonly pool?: Pool,
  ) {}

  // ----- READ -------------------------------------------------------

  async getActiveContext(principal: Principal): Promise<ContextResponseBody> {
    if (principal.kind === "session") {
      return this.getActiveContextForSession(principal);
    }
    return this.getActiveContextForToken(principal);
  }

  // ----- SWITCH TENANT ---------------------------------------------

  async switchTenant(
    principal: Principal,
    tenantId: string,
    requestId: string | null = null,
  ): Promise<ContextResponseBody> {
    if (principal.kind !== "session") {
      throw tokenCannotSwitch();
    }

    // Validate the user has an active membership in the requested
    // tenant — UNLESS they're a platform admin (FR-TEN-6).
    // `isPlatformAdmin` queries only `users` — safe on plain pool.
    const isPlatformAdmin = await this.memberships.isPlatformAdmin(
      principal.userId,
    );
    if (!isPlatformAdmin) {
      await this.withBootstrapCtx(async (client) => {
        const membership = await this.memberships.findActiveMembership(
          principal.userId,
          tenantId,
          client,
        );
        if (!membership) throw notFound();
      });
    } else {
      await this.assertPlatformAdminMayEnter(principal.userId, tenantId);
    }

    await this.endSupportSessionOnSwitch(principal.sessionId, requestId);

    const updated = await this.sessions.updateActiveContext(
      principal.sessionId,
      { activeTenantId: tenantId, activeStoreId: null },
    );
    if (!updated) throw unauthorized();

    return this.buildResponse(principal.userId, tenantId, null, null);
  }

  // ----- SWITCH STORE ----------------------------------------------

  async switchStore(
    principal: Principal,
    storeId: string,
    requestId: string | null = null,
  ): Promise<ContextResponseBody> {
    if (principal.kind !== "session") {
      throw tokenCannotSwitch();
    }

    const session = await this.sessions.findActiveById(principal.sessionId);
    if (!session) throw unauthorized();
    if (!session.activeTenantId) {
      throw new ConflictException(
        "No active tenant set. Switch tenant before switching store.",
      );
    }
    const tenantId = session.activeTenantId;

    // `isPlatformAdmin` queries only `users` — safe on plain pool.
    const isPlatformAdmin = await this.memberships.isPlatformAdmin(
      principal.userId,
    );

    if (!isPlatformAdmin) {
      await this.withBootstrapCtx(async (client) => {
        const membership = await this.memberships.findActiveMembership(
          principal.userId,
          tenantId,
          client,
        );
        if (!membership) throw notFound();
        const allowed = await this.memberships.canAccessStore(
          membership.membershipId,
          tenantId,
          storeId,
          membership.storeAccessKind,
          client,
        );
        if (!allowed) throw notFound();
      });
    } else {
      await this.admitPlatformAdminStoreSwitch(principal, tenantId, requestId);
      // Platform admin: only the store-belongs-to-tenant check
      // applies. The 'all' branch of canAccessStore does exactly
      // that; the synthetic membershipId is unused for kind='all'.
      await this.withBootstrapCtx(async (client) => {
        const allowed = await this.memberships.canAccessStore(
          "00000000-0000-0000-0000-000000000000",
          tenantId,
          storeId,
          "all",
          client,
        );
        if (!allowed) throw notFound();
      });
    }

    const updated = await this.sessions.updateActiveContext(
      principal.sessionId,
      { activeTenantId: tenantId, activeStoreId: storeId },
    );
    if (!updated) throw unauthorized();

    return this.buildResponse(principal.userId, tenantId, storeId, principal.sessionId);
  }

  // ----- CLEAR STORE ------------------------------------------------

  async clearStore(principal: Principal): Promise<ContextResponseBody> {
    if (principal.kind !== "session") {
      throw tokenCannotSwitch();
    }
    const session = await this.sessions.findActiveById(principal.sessionId);
    if (!session) throw unauthorized();

    // Idempotent: if already null, the UPDATE is still issued so the
    // response reflects the current state. The DB write is cheap.
    const updated = await this.sessions.updateActiveContext(
      principal.sessionId,
      {
        activeTenantId: session.activeTenantId,
        activeStoreId: null,
      },
    );
    if (!updated) throw unauthorized();

    return this.buildResponse(
      principal.userId,
      session.activeTenantId,
      null,
      principal.sessionId,
    );
  }

  // ----- INTERNALS --------------------------------------------------

  /**
   * Platform admin switching tenant: the tenant must exist (a typo'd UUID
   * would otherwise set a non-existent active tenant), and — RT-414 — the
   * admin must be a member: a non-member enters only through a support
   * session.
   */
  private async assertPlatformAdminMayEnter(userId: UserId, tenantId: TenantId): Promise<void> {
    await this.withBootstrapCtx(async (client) => {
      const tenantSummary = await this.memberships.findTenantSummary(tenantId, client);
      if (!tenantSummary) throw notFound();
      const member = await this.memberships.hasLiveMembership(userId, tenantId, client);
      if (!member) throw supportSessionRefusal("support_session_required");
    });
  }

  /** RT-414: a tenant switch ends any live support session of this auth session. */
  private async endSupportSessionOnSwitch(
    authSessionId: AuthSessionId,
    requestId: string | null,
  ): Promise<void> {
    if (!this.pool) return;
    await endSupportSessions(this.pool, { authSessionId }, "tenant_switched", requestId);
  }

  /**
   * RT-414: `switchActiveStore` is a covered route. A non-member platform
   * admin needs an active support session for the active tenant; it stays
   * admitted on a suspended tenant (navigation, not a tenant write).
   */
  private async admitPlatformAdminStoreSwitch(
    principal: Extract<Principal, { kind: "session" }>,
    tenantId: TenantId,
    requestId: string | null,
  ): Promise<void> {
    const member = await this.withBootstrapCtx((client) =>
      this.memberships.hasLiveMembership(principal.userId, tenantId, client),
    );
    if (member) return;
    if (!this.pool) throw supportSessionRefusal("support_session_required");
    await new SupportSessionGate(this.pool).enforce(tenantId, {
      authSessionId: principal.sessionId,
      userId: principal.userId,
      method: "POST",
      route: SWITCH_STORE_ROUTE,
      requestId,
      readOnlyExempt: true,
    });
  }

  private async getActiveContextForSession(
    principal: Extract<Principal, { kind: "session" }>,
  ): Promise<ContextResponseBody> {
    const session = await this.sessions.findActiveById(principal.sessionId);
    if (!session) throw unauthorized();
    return this.buildResponse(
      principal.userId,
      session.activeTenantId,
      session.activeStoreId,
      principal.sessionId,
    );
  }

  private async getActiveContextForToken(
    principal: Extract<Principal, { kind: "token" }>,
  ): Promise<ContextResponseBody> {
    // Tokens carry a fixed tenantId (or null for platform-scoped).
    // No session row exists; we render whatever the token claims.
    const userId = principal.userId;
    if (!userId) {
      // Platform-scoped tokens with no user (rare) — surface a stub
      // payload that's still contract-shaped. The user object's
      // fields are placeholders; downstream callers shouldn't lean
      // on `/me` for token-only flows.
      const activeTenant = principal.tenantId
        ? await this.withBootstrapCtx((client) =>
            this.memberships.findTenantSummary(principal.tenantId!, client),
          )
        : null;
      return {
        user: {
          id: "",
          email: "",
          display_name: null,
          is_platform_admin: true,
        },
        active_tenant: activeTenant,
        active_store: null,
        active_role_code: null,
        memberships: [],
        support_session: null,
      };
    }
    return this.buildResponse(userId, principal.tenantId, null, null);
  }

  private async buildResponse(
    userId: string,
    activeTenantId: string | null,
    activeStoreId: string | null,
    /** The auth session whose support session to report; null for none. */
    authSessionId: string | null,
  ): Promise<ContextResponseBody> {
    // `findUserSummary` queries only `users` (no RLS) — safe on plain
    // pool, run in parallel with the RLS-gated `listForUser`.
    const [user, summaries] = await Promise.all([
      this.memberships.findUserSummary(userId),
      this.withBootstrapCtx((client) =>
        this.memberships.listForUser(userId, client),
      ),
    ]);
    if (!user) throw unauthorized();

    // `findTenantSummary` and `findStoreSummary` touch RLS-protected
    // tables. Each gets its own bootstrap-context call (separate pool
    // connections, safe to run in parallel).
    const [activeTenant, activeStore] = await Promise.all([
      activeTenantId
        ? this.withBootstrapCtx((client) =>
            this.memberships.findTenantSummary(activeTenantId, client),
          )
        : Promise.resolve(null),
      activeStoreId && activeTenantId
        ? this.withBootstrapCtx((client) =>
            this.memberships.findStoreSummary(activeStoreId, activeTenantId, client),
          )
        : Promise.resolve(null),
    ]);

    const activeMembership = activeTenantId
      ? summaries.find((m) => m.tenantId === activeTenantId)
      : undefined;

    const supportSession =
      user.isPlatformAdmin && authSessionId !== null && activeTenantId !== null
        ? await this.supportSessionFor(authSessionId, activeTenantId)
        : null;

    return {
      user: {
        id: user.id,
        email: user.email,
        display_name: user.displayName,
        is_platform_admin: user.isPlatformAdmin,
      },
      active_tenant: activeTenant,
      active_store: activeStore,
      active_role_code: activeMembership?.roleCode ?? null,
      memberships: summaries.map((m) => ({
        tenant_id: m.tenantId,
        tenant_name: m.tenantName,
        role_code: m.roleCode,
        store_access_kind: m.storeAccessKind,
        accessible_store_ids: m.accessibleStoreIds,
      })),
      support_session: supportSession,
    };
  }

  private async supportSessionFor(
    authSessionId: AuthSessionId,
    activeTenantId: TenantId,
  ): Promise<SupportSessionSummaryBody | null> {
    if (!this.pool) return null;
    const live = await readLiveSupportSession(this.pool, authSessionId);
    if (!live || live.tenantId !== activeTenantId) return null;
    return toSupportSessionSummary(live);
  }

  /**
   * Run `work` inside a platform-admin GUC context so RLS-protected
   * membership/store/tenant tables are readable by a non-superuser app
   * role.
   *
   * Uses `runWithTenantContext(pool, { tenantId: NIL_UUID,
   * isPlatformAdmin: true }, work)`. The nil UUID (all-zeros) is a
   * valid UUID that matches no real tenant, so `tenant_id = NIL_UUID`
   * evaluates to `false` for every row and the
   * `is_platform_admin = 'true'` OR-branch grants access. Using
   * `tenantId: null` would set the GUC to `""`, causing
   * `invalid input syntax for type uuid: ""` when the RLS predicate
   * attempts the `::uuid` cast — PostgreSQL does not short-circuit `OR`
   * before evaluating sub-expressions that throw.
   *
   * Falls back to calling `work(undefined)` when `this.pool` is absent
   * (unit tests). In that scenario `MembershipRepository` methods fall
   * back to `this.db` — which is correct since unit tests stub the repo.
   */
  private async withBootstrapCtx<T>(
    work: (client: PoolClient | undefined) => Promise<T>,
  ): Promise<T> {
    if (!this.pool) {
      return work(undefined);
    }
    // Use the nil UUID (all-zeros) rather than null/empty-string so the
    // `::uuid` cast in RLS policies succeeds. The comparison
    // `tenant_id = '00000000-…'` evaluates to `false` for every real
    // tenant, so access is granted exclusively via the
    // `is_platform_admin = 'true'` OR-branch. Passing null would set the
    // GUC to "" which throws `invalid input syntax for type uuid: ""` at
    // the cast site before PostgreSQL can short-circuit the OR.
    return runWithTenantContext(
      this.pool,
      { tenantId: "00000000-0000-0000-0000-000000000000", isPlatformAdmin: true },
      (client) => work(client),
    );
  }
}

function notFound(): NotFoundException {
  // 404 (not 403) per FR-ISO-4 — error responses must NOT distinguish
  // "resource exists in another tenant" from "resource does not exist".
  return new NotFoundException("Not Found");
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}

function tokenCannotSwitch(): BadRequestException {
  return new BadRequestException(
    "Tokens cannot switch context. Token tenant/store binding is fixed " +
      "at issuance — issue a new token instead.",
  );
}
