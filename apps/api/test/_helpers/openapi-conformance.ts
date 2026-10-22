/**
 * RT-805 — the runtime-route conformance rules, separate from the route
 * helpers so the negative cases can drive them without booting the app.
 */
import { contractRouteKey, type ContractRoute } from "./openapi-routes";

function runtimeStatusViolation(route: ContractRoute, routed: boolean): string | undefined {
  const { operation } = route;
  const operationId = operation.operationId!;
  const key = contractRouteKey(route);
  const status = operation["x-runtime-status"];
  if (status === undefined) return routed ? undefined : `no registered route: ${operationId}: ${key}`;
  if (status !== "contract-only") return `unknown x-runtime-status "${status}": ${operationId}`;
  if (!operation["x-runtime-note"]?.trim()) return `contract-only without x-runtime-note: ${operationId}`;
  return routed ? `contract-only but routed, drop the marker: ${operationId}: ${key}` : undefined;
}

/**
 * RT-805 — the runtime-route conformance rules, with the contract-only set
 * derived from the `x-runtime-status` markers: every production operation
 * has a registered route, every contract-only one carries a note and has no
 * route yet, and operationIds are unique.
 */
export function conformanceViolations(contracts: ContractRoute[], runtimeRoutes: Set<string>): string[] {
  const seen = new Set<string>();
  return contracts.flatMap((route) => {
    const operationId = route.operation.operationId!;
    if (seen.has(operationId)) return [`duplicate operationId: ${operationId}`];
    seen.add(operationId);
    return runtimeStatusViolation(route, runtimeRoutes.has(contractRouteKey(route))) ?? [];
  });
}
