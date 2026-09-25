/**
 * Shared types for the context module — slice 9 (T151).
 *
 * Defines the request shape the guard publishes and the resolved
 * context payload the guard attaches. Kept in its own file so the
 * guard, the future ContextController (T152/T153), the future DB
 * middleware (T154/T155), and protected controllers all consume
 * the same canonical shape without forming a cycle through the
 * guard's implementation file.
 */
import type { AuthedRequest } from "../auth/auth.guard";

/**
 * The fully-resolved active context for an authenticated request.
 *
 * `tenantId === null` is reserved for platform-admin callers operating
 * without an active tenant (FR-TEN-6); every non-admin request MUST
 * resolve a non-null `tenantId` or fail at the guard.
 *
 * `storeId === null` is the normal case for tenant-level requests
 * (FR-CTX-6) — most settings, user-management, billing, etc. are
 * tenant-scoped without a store.
 *
 * `source` records which authentication path produced the context;
 * useful for audit trails and downstream "API vs dashboard" branching.
 */
export interface ResolvedContext {
  readonly userId: string | null;
  readonly tenantId: string | null;
  readonly storeId: string | null;
  readonly isPlatformAdmin: boolean;
  readonly source: "session" | "token";
}

/**
 * Express request after `TenantContextGuard` has resolved the active
 * context. The `context` field is populated on success; on failure
 * the guard throws and `context` is never observed by downstream code.
 */
export type TenantContextRequest = AuthedRequest & {
  context?: ResolvedContext;
  /** Server-resolved device binding for POS operator write requests. */
  posDeviceId?: string;
};
