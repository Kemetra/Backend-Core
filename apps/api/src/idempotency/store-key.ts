/**
 * Replay-store key composition (RT-82 K1 / RT-155).
 *
 * The key binds the route TEMPLATE plus the resolved path params, so one
 * resource's stored response is never replayed for another (`:saleRef`,
 * `:id`, `:storeId`, …). A different resource misses and runs its own
 * handler, with its own authorization and provenance checks.
 *
 *   no params:  `${method}:${template}:${clientId}:${key}`   (unchanged bytes)
 *   params:     `${method}:${template}:${canonicalJson(params)}:${clientId}:${key}`
 *
 * Template + params, not the rendered URL: Express matching tolerates case,
 * trailing-slash and encoding variants, so the rendered URL can differ for
 * the same operation. `canonicalJson` sorts the param names, and a template
 * never contains `{`, so the segment is unambiguous.
 *
 * Tenant is a separate partition on the store and is not part of this string.
 * Metric `route` labels stay on the template (strategy.md §14.1).
 */
import { canonicalJson } from "./canonical-json";

export type RouteParams = Readonly<Record<string, unknown>> | undefined;

/** Canonical params segment, or `""` when the route has no resolved params. */
export function paramsSegment(params: RouteParams): string {
  if (!params) return "";
  const json = canonicalJson(params);
  return json === "{}" ? "" : json;
}

export function composeStoreKey(
  method: string,
  routePath: string,
  cId: string,
  headerKey: string,
  params?: RouteParams,
): string {
  const segment = paramsSegment(params);
  const route = segment === "" ? routePath : `${routePath}:${segment}`;
  return `${method}:${route}:${cId}:${headerKey}`;
}
