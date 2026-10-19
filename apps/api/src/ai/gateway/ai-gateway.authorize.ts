/**
 * Gateway step 1 — authorize (RT-655, AD-AI-ENT-001 layers 2-4).
 *
 * Proves what a resolved context can prove: a human SESSION principal inside a
 * tenant, and a store scope that covers every requested store. Role/capability
 * (`ai.<feature>:perform`, layer 3) is enforced by the future route's `@Roles`
 * guard, which runs before the gateway.
 */
import { resolveStoreScope } from "../../context/store-scope";
import type { ResolvedContext } from "../../context/types";
import type { AiFallbackReason, AiRunScope } from "./ai-gateway.types";

export interface Principal {
  readonly tenantId: string;
  readonly userId: string;
}

/**
 * Token principals (POS devices, connectors) are not AI callers. A platform
 * admin reads entitlements for support but does not consume tenant AI features
 * (AD-AI-ENT-001 D-6), so it is denied even with a tenant set.
 */
function sessionPrincipal(ctx: ResolvedContext): Principal | null {
  if (ctx.source !== "session" || ctx.isPlatformAdmin) return null;
  if (ctx.userId === null || ctx.tenantId === null) return null;
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

/**
 * D-4: refuse when ANY requested store is outside the principal's scope, never
 * narrow silently. An empty request means tenant-wide and needs tenant-wide
 * access. Unresolved store access is an empty scope (fail closed).
 */
function coversStores(ctx: ResolvedContext, storeIds: readonly string[]): boolean {
  const allowed = resolveStoreScope(ctx);
  if (allowed.kind === "tenant") return true;
  if (storeIds.length === 0) return false;
  return storeIds.every((storeId) => allowed.storeIds.includes(storeId));
}

export function authorizeScope(scope: AiRunScope): Principal | { readonly reason: AiFallbackReason } {
  const principal = sessionPrincipal(scope.ctx);
  if (principal === null) return { reason: "not_authorized" };
  return coversStores(scope.ctx, scope.storeIds) ? principal : { reason: "store_out_of_scope" };
}
