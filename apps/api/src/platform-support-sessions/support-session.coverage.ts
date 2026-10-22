/**
 * Which routes RT-414 support-session enforcement covers
 * (`x-support-session-enforcement` in platform-support-sessions.openapi.yaml):
 *
 *   - every route mounted behind `TenantContextGuard` — the session's ACTIVE
 *     tenant;
 *   - `switchActiveStore` — the active tenant;
 *   - the path-tenant routes `listMembers` and `updateTenant` — the
 *     `{tenant_id}` path segment (owner decision 6, 2026-10-12).
 *
 * Guards are matched by class NAME, not by reference: `AuthGuard` must not
 * import `TenantContextGuard` (that would close an import cycle through
 * `auth.module`).
 */
import type { ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";

/**
 * Whether an unsafe method stays admitted on a suspended tenant (read-only
 * support session): never, always, or only for a body that changes nothing
 * but `status` (reactivation, parent decision 2026-10-21).
 */
export type ReadOnlyExemption = boolean | "status-only";

export type CoveredTarget =
  | { readonly kind: "active-tenant"; readonly readOnlyExempt: ReadOnlyExemption }
  | {
      readonly kind: "path-tenant";
      readonly param: string;
      readonly readOnlyExempt: ReadOnlyExemption;
    };

const TENANT_CONTEXT_GUARD = "TenantContextGuard";

const ACTIVE_TENANT_HANDLERS: ReadonlyMap<string, CoveredTarget> = new Map([
  // Navigation inside the tenant, not a tenant write: admitted on a suspended tenant.
  ["ContextController.switchStore", { kind: "active-tenant", readOnlyExempt: true }],
]);

export const PATH_TENANT_HANDLERS: ReadonlyMap<string, CoveredTarget> = new Map([
  ["TenantsController.listMembers", { kind: "path-tenant", param: "id", readOnlyExempt: false }],
  // Reactivating a suspended tenant is a PATCH here: on a suspended tenant only
  // a status-only body is admitted; any other field is read-only refused.
  ["TenantsController.update", { kind: "path-tenant", param: "id", readOnlyExempt: "status-only" }],
]);

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Nest controller classes and handlers
type Fn = Function;

export function handlerKey(execCtx: ExecutionContext): string {
  return `${(execCtx.getClass() as Fn).name}.${(execCtx.getHandler() as Fn).name}`;
}

/** Resolve a target's read-only exemption for this request's body. */
export function readOnlyExemptFor(target: CoveredTarget, body: unknown): boolean {
  if (target.readOnlyExempt !== "status-only") return target.readOnlyExempt;
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    Object.hasOwn(body, "status")
  );
}

/** The covered target of the route, or null when RT-414 does not cover it. */
export function coveredTarget(execCtx: ExecutionContext): CoveredTarget | null {
  const key = handlerKey(execCtx);
  const named = PATH_TENANT_HANDLERS.get(key) ?? ACTIVE_TENANT_HANDLERS.get(key);
  if (named) return named;
  const guards = [
    ...((Reflect.getMetadata(GUARDS_METADATA, execCtx.getClass()) as unknown[] | undefined) ?? []),
    ...((Reflect.getMetadata(GUARDS_METADATA, execCtx.getHandler()) as unknown[] | undefined) ?? []),
  ];
  const tenantGuarded = guards.some(
    (guard) => typeof guard === "function" && (guard as Fn).name === TENANT_CONTEXT_GUARD,
  );
  return tenantGuarded ? { kind: "active-tenant", readOnlyExempt: false } : null;
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
export function routeTemplate(execCtx: ExecutionContext): string {
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
