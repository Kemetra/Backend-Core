/**
 * The operator (Console) surfaces' store scope (RT-51 D6 / RT-177, RT-191, RT-192, RT-193).
 *
 * One rule for every Console operation that addresses a store: the ERPNext
 * reconciliation surface (/api/v1/catalog/erpnext-reconciliation — the negative
 * on-hand reads RT-177, the run trigger / repair writes RT-191 and the backlog /
 * run / result reads RT-192), the 025 console sync-ops read model
 * (/api/v1/catalog/erpnext-sync-ops, RT-192) and the 032 sale-sync-ops reads and
 * repair (/api/v1/catalog/sale-sync-ops, RT-193). Their tables carry tenant-only
 * RLS, so the store scope is applied by the caller as a filter; an out-of-scope
 * store is indistinguishable from a nonexistent one.
 */
import type { PoolClient } from "pg";

import type { MembershipRepository } from "./membership.repository";
import { resolveStoreScope, type StoreScope } from "./store-scope";
import type { ResolvedContext } from "./types";

/** Roles whose scope is their membership's, not narrowed by the active store (RT-51 D6). */
const TENANT_WIDE_ROLES: ReadonlySet<string> = new Set(["owner", "tenant_admin"]);

/**
 * The stores this caller may address on an operator surface (RT-51 D6).
 *
 * `owner` / `tenant_admin` are not narrowed by the session's ACTIVE store: their
 * scope is their membership's store authority (`'all'` → tenant-wide). Their
 * membership still bounds it — a `'specific'` grant stays specific (RT-131: the
 * role never widens a membership). Every other role (`store_manager`) gets the
 * standard `resolveStoreScope` (RT-131), including the active-store narrowing.
 */
export function readScope(input: {
  readonly context: ResolvedContext;
  readonly roleCode: string | null;
}): StoreScope {
  const tenantWide = input.roleCode !== null && TENANT_WIDE_ROLES.has(input.roleCode);
  return resolveStoreScope(tenantWide ? { ...input.context, storeId: null } : input.context);
}

/**
 * The caller's store scope from its role in the tenant. `client` must run under
 * the tenant's context (`runWithTenantContext`): the role read is RLS-scoped.
 */
export async function callerStoreScope(
  client: PoolClient,
  memberships: MembershipRepository,
  input: { readonly tenantId: string; readonly context: ResolvedContext },
): Promise<StoreScope> {
  const userId = input.context.userId;
  const roleCode =
    userId !== null
      ? await memberships.findRoleCodeForUserInTenant(userId, input.tenantId, client)
      : null;
  return readScope({ context: input.context, roleCode });
}

/** Whether `storeId` (any case) is inside `scope`. */
export function inStoreScope(scope: StoreScope, storeId: string): boolean {
  return scope.kind === "tenant" || scope.storeIds.includes(storeId.toLowerCase());
}

/**
 * `scope` as a SQL filter parameter for `($n::uuid[] IS NULL OR store_id = ANY($n::uuid[]))`:
 * null when tenant-wide, else the scoped store ids (empty → no row, fail closed).
 */
export function scopeStoreIds(scope: StoreScope): readonly string[] | null {
  return scope.kind === "tenant" ? null : scope.storeIds;
}
