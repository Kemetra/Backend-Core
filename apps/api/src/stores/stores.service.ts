/**
 * StoresService — slice US2 (T134).
 *
 * Implements the five store-CRUD endpoints from
 * `specs/001-foundation-auth-tenant-store/contracts/stores.openapi.yaml`.
 *
 * Active-tenant context (NOT path-as-context)
 * -------------------------------------------
 * Every store route is scoped to the caller's **active tenant**, which
 * `TenantContextGuard` resolves into `request.context.tenantId` before
 * this service is reached. The controller passes that resolved
 * `ResolvedContext` straight in; we never read it from the path or
 * derive it from the principal here.
 *
 * Authorization layering
 * ----------------------
 *   - Authentication: `AuthGuard` (controller class-level).
 *   - Active tenant: `TenantContextGuard` (controller class-level) —
 *     a missing active tenant turns into 401 BEFORE this service runs.
 *   - Tenant role gating for write operations: `RolesGuard` per-method
 *     on the controller. POST uses `denyAs: 403` (insufficient role
 *     within an already-resolved active tenant); PATCH/DELETE use the
 *     default `denyAs: 404` (FR-ISO-4 — wrong-role looks like
 *     not-found alongside cross-tenant). All three are filtered before
 *     this service runs.
 *
 * Store-access policy on `read`
 * -----------------------------
 * `GET /stores/:id` is NOT a pure role gate. A `kind='specific'`
 * member (typically `store_staff`) is allowed in their tenant generally
 * but only sees stores they have a `store_access` row for. That check
 * is data-shaped, not role-shaped — the guard can't express it
 * cleanly — so it lives here, calling
 * `MembershipRepository.canAccessStore`. Platform admins and
 * `kind='all'` members skip the check entirely.
 *
 * Error contract
 * --------------
 *   - 401 (no active tenant)             → TenantContextGuard
 *   - 403 (POST insufficient role)       → RolesGuard (denyAs: 403)
 *   - 404 (PATCH/DELETE wrong role / cross-tenant / unknown id) →
 *     RolesGuard for the role branches; this service for the data
 *     branches (RLS-filtered null + the `kind='specific'` no-access
 *     case).
 *   - 409 (duplicate code in tenant)     → maps `23505` on
 *     `stores_tenant_code_uidx` to `ConflictException`.
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
import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";
import type { ResolvedContext } from "../context/types";
import {
  StoresRepository,
  type StoreRecord,
} from "./stores.repository";

/**
 * Same indirection seam used by `TenantsService`: production passes
 * the real `runWithTenantContext`; tests inject a passthrough that
 * fabricates a `PoolClient`-shaped object so orchestration logic can
 * be exercised without a real Postgres pool.
 */
type TenantTxRunner = <T>(
  pool: Pool,
  ctx: TenantContext,
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

/**
 * Translate a `ResolvedContext` into the `TenantContext` shape the
 * `runWithTenantContext` middleware accepts. The two types are
 * intentionally distinct:
 *
 *   - `ResolvedContext` carries everything the API resolved about the
 *     request (userId, storeId, source, ...).
 *   - `TenantContext` carries only what RLS needs (tenantId,
 *     isPlatformAdmin).
 *
 * This function is the one boundary between them. Throwing here would
 * be wrong — the guard already rejected callers without an active
 * tenant; so we trust `ctx.tenantId` is non-null and assert via the
 * NotFoundException fallback if it isn't.
 */
function txCtx(ctx: ResolvedContext): TenantContext {
  return {
    tenantId: ctx.tenantId,
    // RT-142: these are ordinary tenant-context routes, so they act as the
    // SELECTED tenant even for a platform admin. Passing the admin flag into
    // the GUC would enable RLS's platform-admin branch and let list / read /
    // update / delete reach every tenant's stores. Cross-tenant work stays
    // explicit: a platform admin switches the active tenant first. A missing
    // tenant (tokenless edge) sees nothing — fail closed.
    isPlatformAdmin: false,
  };
}

@Injectable()
export class StoresService {
  private readonly tx: TenantTxRunner;

  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
    private readonly stores: StoresRepository,
    private readonly memberships: MembershipRepository,
    /** Optional injected runner for tests. Production callers omit it. */
    @Optional() tx?: TenantTxRunner,
  ) {
    this.tx = tx ?? runWithTenantContext;
  }

  // ===== LIST =======================================================

  /**
   * `GET /api/v1/stores`. Lists all live stores in the active tenant.
   * RLS filters cross-tenant rows; the repository's WHERE clause adds
   * the `deleted_at IS NULL` predicate.
   *
   * `list` is intentionally NOT store-access-gated — within your
   * active tenant you see every store. The store-access policy
   * (kind='specific' + store_access rows) controls which stores you
   * can *operate on* (read details, switch active context to), not
   * the high-level catalog.
   */
  async list(ctx: ResolvedContext): Promise<StoreRecord[]> {
    return this.tx(this.pool, txCtx(ctx), (client) =>
      this.stores.listInTenant(client),
    );
  }

  // ===== CREATE =====================================================

  /**
   * `POST /api/v1/stores`. RolesGuard already verified the caller is
   * `owner` or `tenant_admin` (denyAs: 403 — see controller).
   *
   * Atomically: inserts one `stores` row inside `runWithTenantContext`.
   * Code uniqueness within the tenant is enforced by the partial
   * unique index `stores_tenant_code_uidx` on `(tenant_id, lower(code))
   * WHERE deleted_at IS NULL`. A duplicate raises 23505 which we
   * surface as 409.
   */
  async create(
    ctx: ResolvedContext,
    input: { code: string; name: string },
  ): Promise<StoreRecord> {
    if (!ctx.tenantId) {
      // Defensive: TenantContextGuard should have already rejected
      // callers without an active tenant. The class invariant on
      // `TenantContext` requires `tenantId !== null` for non-admin
      // writes; surface as 404 (defensive) rather than crash.
      throw notFound();
    }
    const storeId = newId();
    try {
      return await this.tx(this.pool, txCtx(ctx), async (client) => {
        return this.stores.create(client, {
          id: storeId,
          tenantId: ctx.tenantId as string,
          code: input.code,
          name: input.name,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err, "stores_tenant_code_uidx")) {
        throw new ConflictException("Store code already in use.");
      }
      throw err;
    }
  }

  // ===== READ =======================================================

  /**
   * `GET /api/v1/stores/:store_id`. Two-stage check:
   *
   *   1. **Store-access policy** — for `kind='specific'` members, the
   *      caller must have an explicit `store_access` row. Platform
   *      admins and `kind='all'` members skip this. Failure is 404.
   *
   *   2. **RLS-scoped lookup** — `findById` runs inside
   *      `runWithTenantContext`, so cross-tenant ids return null
   *      regardless of step (1). Null → 404.
   *
   * Step (1) is needed even though step (2) would also block bad
   * cross-store reads, because `kind='specific'` members in their
   * own tenant pass RLS but should still be denied — the secret being
   * protected here is "which stores you have access to", not "which
   * tenant you're in".
   */
  async read(
    ctx: ResolvedContext,
    storeId: string,
  ): Promise<StoreRecord> {
    if (!ctx.tenantId) throw notFound();

    // Both stages run inside ONE `runWithTenantContext` with the
    // caller's resolved tenant context. That satisfies RLS on
    // `memberships`, `store_access`, AND `stores` via the standard
    // tenant-isolation predicate (no bootstrap nil-UUID hack needed
    // because the caller has a real active tenant). Sharing a
    // transaction also gives the access check and the row read a
    // consistent snapshot.
    return this.tx(this.pool, txCtx(ctx), async (client) => {
      // Stage 1: store-access policy for non-admin, non-token callers.
      // Token principals don't have memberships in this slice — we let
      // them through to RLS. Platform-admin sessions skip the check.
      if (!ctx.isPlatformAdmin && ctx.source === "session" && ctx.userId) {
        const membership = await this.memberships.findActiveMembership(
          ctx.userId,
          ctx.tenantId as string,
          client,
        );
        if (!membership) {
          // No active membership in this tenant. Should be impossible
          // if TenantContextGuard ran (it requires an active membership
          // for non-admin sessions), but defensively map to 404.
          throw notFound();
        }
        const ok = await this.memberships.canAccessStore(
          membership.membershipId,
          ctx.tenantId as string,
          storeId,
          membership.storeAccessKind,
          client,
        );
        if (!ok) throw notFound();
      }

      // Stage 2: RLS-scoped read.
      const row = await this.stores.findById(client, storeId);
      if (!row) throw notFound();
      return row;
    });
  }

  // ===== UPDATE =====================================================

  /**
   * `PATCH /api/v1/stores/:store_id`. RolesGuard already verified the
   * caller is `owner` or `tenant_admin` (default denyAs: 404 — wrong
   * role looks like not-found per FR-ISO-4).
   *
   * RLS scopes the UPDATE to the active tenant, so cross-tenant ids
   * silently affect 0 rows; the repository returns null and we map
   * to 404. Same shape handles concurrent-soft-delete races.
   */
  async update(
    ctx: ResolvedContext,
    storeId: string,
    next: {
      name?: string | undefined;
      is_active?: boolean | undefined;
    },
  ): Promise<StoreRecord> {
    return this.tx(this.pool, txCtx(ctx), async (client) => {
      const row = await this.stores.update(client, storeId, {
        name: next.name,
        isActive: next.is_active,
      });
      if (!row) throw notFound();
      return row;
    });
  }

  // ===== DELETE =====================================================

  /**
   * `DELETE /api/v1/stores/:store_id`. RolesGuard already verified
   * `owner`/`tenant_admin`. Soft-delete is idempotent — a second call
   * on the same id is also 204. Cross-tenant ids would normally be
   * silently filtered by RLS (0 rows updated → still 204), but the
   * contract specifies 404 for "not found / no access". We probe
   * existence inside the same RLS context to distinguish:
   *
   *   - Store visible in active tenant → soft-delete (or no-op if
   *                                       already deleted) → 204.
   *   - Store NOT visible (cross-tenant or never existed) → 404.
   *
   * The probe runs inside the same `runWithTenantContext` transaction
   * as the soft-delete, so the existence check and the UPDATE see a
   * consistent snapshot.
   */
  async softDelete(
    ctx: ResolvedContext,
    storeId: string,
  ): Promise<void> {
    await this.tx(this.pool, txCtx(ctx), async (client) => {
      const exists = await this.stores.existsInTenant(client, storeId);
      if (!exists) {
        // Either cross-tenant (RLS filtered) or already soft-deleted.
        // For idempotency on already-soft-deleted, we can't easily
        // distinguish from "never existed in this tenant" without a
        // separate query, so we 404 here. The integration spec asserts
        // that a SECOND DELETE call right after a successful first
        // call returns 404, which matches the contract's 204/404 split
        // (204 for "I deleted it now"; 404 for "you can't see it").
        throw notFound();
      }
      await this.stores.softDelete(client, storeId);
    });
  }
}

function notFound(): NotFoundException {
  return new NotFoundException("Not Found");
}

/**
 * Detect a Postgres unique-constraint violation (`SQLSTATE 23505`) on
 * a specific constraint name.
 *
 * Drizzle wraps the underlying `pg` error in a `DrizzleQueryError`
 * whose `.cause` carries the `pg.DatabaseError` with `code='23505'` and
 * the constraint name. We recurse one level into `.cause` so wrapping
 * doesn't defeat the check. The wrapped error's `.message` also
 * includes the constraint name (Drizzle prints "Failed query: …" with
 * the original error appended), so the message-substring branch is a
 * belt-and-suspenders fallback for driver versions that flatten the
 * cause chain.
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
  return (
    typeof e.message === "string" && e.message.includes(constraintName)
  );
}
