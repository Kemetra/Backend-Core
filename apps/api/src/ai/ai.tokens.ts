/**
 * DI tokens for the AI module — RT-655. Granular so each later ticket replaces
 * exactly one collaborator: RT-664 `AI_ENTITLEMENT`, RT-663 `AI_BUDGET`,
 * RT-647 `AI_EVIDENCE_BUILDER`, RT-657 `AI_MODEL_PROVIDERS` + `AI_ROUTE_ALLOWLIST`.
 */
export const AI_GATEWAY_DEPS = Symbol.for("ai.gatewayDeps");
export const AI_FEATURES = Symbol.for("ai.features");
export const AI_ENTITLEMENT = Symbol.for("ai.entitlement");
export const AI_BUDGET = Symbol.for("ai.budget");
export const AI_EVIDENCE_BUILDER = Symbol.for("ai.evidenceBuilder");
export const AI_ROUTE_ALLOWLIST = Symbol.for("ai.routeAllowlist");
export const AI_MODEL_PROVIDERS = Symbol.for("ai.modelProviders");
/** Groups of the granular tokens above, so the deps factory stays small. */
export const AI_POLICY_PORTS = Symbol.for("ai.policyPorts");
export const AI_ROUTING = Symbol.for("ai.routing");
export const AI_GATEWAY_RUNTIME = Symbol.for("ai.gatewayRuntime");
export const AI_GATEWAY_METRICS = Symbol.for("ai.gatewayMetrics");
