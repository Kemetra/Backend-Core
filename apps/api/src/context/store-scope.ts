/**
 * Store scope — the one rule for "which stores may this request touch?"
 * (RT-131; the same semantics #606 gave inventory, whose follow-up is RT-61).
 *
 * Store authority comes from the caller's MEMBERSHIP, never from the absence
 * of an active store. `ctx.storeId` is copied from
 * `sessions.active_store_id`, which is NULL by default (sign-in never sets
 * it and a tenant switch clears it). Reading that NULL as "tenant-wide"
 * handed every `store_access_kind = 'specific'` member every store in the
 * tenant (RT-120 B-1).
 *
 *   - active store set                  → that store only (TenantContextGuard
 *                                          has already proven it is reachable)
 *   - no active store, kind 'all'       → tenant-wide (platform admins included)
 *   - no active store, kind 'specific'  → exactly the granted stores
 *   - store access not resolved         → no store (fail closed)
 *
 * "Not resolved" covers every principal TenantContextGuard did not resolve a
 * membership for (bearer tokens) and any hand-built context.
 */
import type { ResolvedContext } from "./types";

/** The stores a single request may read or act on. */
export type StoreScope =
  | { readonly kind: "tenant" }
  | { readonly kind: "stores"; readonly storeIds: readonly string[] };

export function resolveStoreScope(ctx: ResolvedContext): StoreScope {
  if (ctx.storeId !== null) return { kind: "stores", storeIds: [ctx.storeId] };
  const access = ctx.storeAccess;
  if (access?.kind === "all") return { kind: "tenant" };
  if (access?.kind === "specific") {
    return { kind: "stores", storeIds: access.storeIds };
  }
  return { kind: "stores", storeIds: [] };
}
