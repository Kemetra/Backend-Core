/**
 * `@Roles()` / `@RolesFromParam()` / `@PlatformAdminOnly()` — slice US5 (T201).
 *
 * Decorator family that publishes authorization metadata for `RolesGuard`
 * to read via `Reflector`. Three flavors cover the routes this codebase
 * needs:
 *
 *   1. `@Roles("owner", "tenant_admin")`
 *      Tenant context lives on `request.context.tenantId` (the common
 *      case — routes that mount `TenantContextGuard`).
 *
 *   2. `@RolesFromParam("id", "owner", "tenant_admin")`
 *      Path-as-context routes like `PATCH /api/v1/tenants/:id` where
 *      `TenantContextGuard` is intentionally NOT mounted (see
 *      `tenants.service.ts` header). The guard reads tenant id from
 *      `request.params[<key>]` instead.
 *
 *   3. `@PlatformAdminOnly()`
 *      Operations that only platform admins may perform (e.g.
 *      `POST /tenants`, `DELETE /tenants/:id`). Distinguished from the
 *      other two because failure is **403** (not 404) — platform-admin
 *      status is self-knowable via `GET /context/me`, so a forbidden
 *      response leaks no side-channel info.
 *
 * Default-deny posture
 * --------------------
 * `RolesGuard` treats absent metadata as deny (FR-AUTHZ default-deny).
 * Any handler the guard runs against MUST carry one of these decorators
 * or be wrapped in a future `@Public()` annotation. This is enforced by
 * the guard itself; the decorator just publishes the metadata.
 */
import { SetMetadata, type CustomDecorator } from "@nestjs/common";

/**
 * Per-tenant role codes seeded by `TenantsService.create` (see
 * `tenants.service.ts:65` and data-model.md §6 line 170). The catalog
 * is closed in v1; custom roles ship with `roles.is_built_in = false`
 * later.
 */
export type RoleCode = "owner" | "tenant_admin" | "store_manager" | "store_staff";

/**
 * Where `RolesGuard` should look for the active tenant id.
 *
 *   - `"context"`     — `request.context.tenantId` (default; assumes
 *                       `TenantContextGuard` ran upstream).
 *   - `"param:<key>"` — `request.params[<key>]` (path-as-context).
 *
 * Rendered as a string-literal union so `tenantFrom` is checkable at the
 * type level without a parser.
 */
export type TenantSource = "context" | `param:${string}`;

/**
 * Shape published under `ROLES_METADATA_KEY`. The guard consumes this
 * verbatim — keeping it a small, stable object means decorator changes
 * (e.g. adding store-scope, permissions) are additive.
 */
export interface RolesMetadata {
  /**
   * Roles that satisfy this gate. The membership's role must be in
   * this set. Empty `any` is legal but useless — `@PlatformAdminOnly`
   * is the right tool for "no tenant role allows this".
   */
  readonly any: readonly RoleCode[];
  /** See `TenantSource`. Defaults to `"context"` for `@Roles()`. */
  readonly tenantFrom: TenantSource;
  /**
   * `true` when produced by `@PlatformAdminOnly()`. The guard short-
   * circuits and returns 403 (not 404) for non-admins, so the failure
   * shape differs from `@Roles()`. Carried as a flag (rather than a
   * separate metadata key) so future combinators — e.g. "platform admin
   * OR tenant role X" — stay representable in one object.
   */
  readonly platformAdminOnly: boolean;
  /**
   * HTTP status to use when the caller fails the role check
   * (no membership OR role not in `any`).
   *
   *   - `404` (default) — FR-ISO-4 posture. Appropriate when the
   *     resource id is part of the request (e.g., path-as-context
   *     `/tenants/:id`): we must NOT distinguish "wrong tenant" from
   *     "doesn't exist", or attackers can enumerate.
   *
   *   - `403` — appropriate when the caller is acting *within* their
   *     active tenant and existence is not a secret. Example:
   *     `POST /api/v1/stores` — the active tenant is already known to
   *     the caller; the only question the response answers is "may
   *     you create here?" Returning 404 would be misleading.
   *
   * Independent of `platformAdminOnly`, which is hard-wired 403 (the
   * actor's platform-admin status is self-knowable via `/context/me`).
   */
  readonly denyAs: 403 | 404;
}

/**
 * Optional trailing options object on `@Roles(...)`. Currently only
 * carries `denyAs`; future fields go here without breaking existing
 * call sites. Detected via the `denyAs` property at the type level.
 */
export interface RolesOptions {
  readonly denyAs?: 403 | 404;
}

function isOptions(value: unknown): value is RolesOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    "denyAs" in (value as Record<string, unknown>)
  );
}

/** Reflector key. Namespaced to avoid collision with future Nest libs. */
export const ROLES_METADATA_KEY = "dp2:roles";

/**
 * Allow callers whose tenant-membership role is in `codes`. Tenant id
 * is read from `request.context.tenantId` (i.e. the route mounts
 * `TenantContextGuard`).
 *
 * Platform-admin callers always pass — see `RolesGuard` for the bypass
 * order.
 *
 * Optional trailing options:
 *   `@Roles("owner", "tenant_admin", { denyAs: 403 })`
 * defaults to `{ denyAs: 404 }` (FR-ISO-4). Use `403` only when the
 * caller is acting within their active tenant and existence is not a
 * secret (see `RolesMetadata.denyAs` for the full rationale).
 */
export function Roles(...codes: RoleCode[]): CustomDecorator;
export function Roles(
  ...args: [...RoleCode[], RolesOptions]
): CustomDecorator;
export function Roles(
  ...args: Array<RoleCode | RolesOptions>
): CustomDecorator {
  const last = args.at(-1);
  const opts: RolesOptions = isOptions(last) ? last : {};
  const codes = (
    isOptions(last) ? args.slice(0, -1) : args
  ) as RoleCode[];
  return SetMetadata(ROLES_METADATA_KEY, {
    any: codes,
    tenantFrom: "context",
    platformAdminOnly: false,
    denyAs: opts.denyAs ?? 404,
  } satisfies RolesMetadata);
}

/**
 * Same as `@Roles()` but reads tenant id from `request.params[paramKey]`
 * instead of `request.context`. For path-as-context routes that don't
 * mount `TenantContextGuard` (e.g. `/api/v1/tenants/:id`).
 *
 * Path-as-context routes are FR-ISO-4-sensitive by construction (the
 * tenant id IS the secret being protected), so `denyAs` is hard-wired
 * to `404`. There is intentionally no `denyAs` option here.
 */
export const RolesFromParam = (
  paramKey: string,
  ...codes: RoleCode[]
): CustomDecorator =>
  SetMetadata(ROLES_METADATA_KEY, {
    any: codes,
    tenantFrom: `param:${paramKey}` as const,
    platformAdminOnly: false,
    denyAs: 404,
  } satisfies RolesMetadata);

/**
 * Allow only platform admins. Failure is 403 (not 404) because the
 * actor can determine their own platform-admin status via
 * `GET /context/me`, so distinguishing "forbidden" from "missing"
 * leaks nothing.
 *
 * Tenant id is irrelevant — no membership lookup happens at all.
 */
export const PlatformAdminOnly = (): CustomDecorator =>
  SetMetadata(ROLES_METADATA_KEY, {
    any: [],
    tenantFrom: "context",
    platformAdminOnly: true,
    denyAs: 403,
  } satisfies RolesMetadata);
