/**
 * Gateway step 6 — route resolution (RT-655, RT-643 §4).
 *
 * The route comes from the static, repo-owned allowlist only; the caller never
 * chooses a route, model or provider. Everything unknown fails closed.
 */
import type {
  ModelProviderPort,
  ModelRouteDescriptor,
} from "../ports/model-provider.port";
import type { AiFeatureDefinition } from "./ai-feature";
import type { AiFallbackReason, AiGatewayDeps } from "./ai-gateway.types";

export interface ResolvedRoute {
  readonly route: ModelRouteDescriptor;
  readonly provider: ModelProviderPort;
}

type RoutingDeps = Pick<AiGatewayDeps, "routes" | "providers" | "runtime">;

function findAllowlisted(feature: AiFeatureDefinition, deps: RoutingDeps): ResolvedRoute | null {
  const route = deps.routes.find((candidate) => candidate.routeKey === feature.routeKey);
  if (route === undefined) return null;
  const provider = deps.providers.find((candidate) => candidate.providerKey === route.providerKey);
  return provider === undefined ? null : { route, provider };
}

export function resolveRoute(
  feature: AiFeatureDefinition,
  deps: RoutingDeps,
): ResolvedRoute | { readonly reason: AiFallbackReason } {
  const resolved = findAllowlisted(feature, deps);
  if (resolved === null) return { reason: "route_not_allowlisted" };
  // AD-AI-PROV-001 E-9: a synthetic-only route cannot be used in production.
  if (resolved.route.syntheticOnly && deps.runtime.isProduction()) {
    return { reason: "route_not_allowlisted" };
  }
  const declared = resolved.route.capabilities;
  if (!feature.requiredCapabilities.every((capability) => declared.has(capability))) {
    return { reason: "unsupported_capability" };
  }
  return resolved;
}
