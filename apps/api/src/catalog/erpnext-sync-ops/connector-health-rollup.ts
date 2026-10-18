/**
 * RT-563 — rollup of the 020 connector-health read model into the 025 sync-ops
 * `connector_health` DomainSummary. Pure: takes the per-instance liveness
 * verdicts (already derived at read by 020) and returns the domain summary.
 *
 * Rules (never optimistic):
 *   - no instances, or only disabled ones      -> not_available
 *   - any active instance stale / never_seen   -> attention
 *   - every active instance healthy            -> ok
 * `headlineCount` is the number of active instances that are not healthy.
 */
import type { LivenessVerdict } from "../../connector-health/connector-health.liveness";
import type { DomainSummary } from "./erpnext-sync-ops.read-model.service";

export function rollupConnectorHealth(
  verdicts: readonly LivenessVerdict[],
): DomainSummary {
  if (verdicts.length === 0) {
    return {
      domain: "connector_health",
      status: "not_available",
      headlineCount: null,
      detail: "No connector instances registered",
    };
  }
  const active = verdicts.filter((v) => v !== "disabled");
  if (active.length === 0) {
    return {
      domain: "connector_health",
      status: "not_available",
      headlineCount: null,
      detail: "All connector instances are disabled",
    };
  }
  const stale = active.filter((v) => v === "stale").length;
  const neverSeen = active.filter((v) => v === "never_seen").length;
  const unhealthy = stale + neverSeen;
  if (unhealthy === 0) {
    return {
      domain: "connector_health",
      status: "ok",
      headlineCount: 0,
      detail: `All ${active.length} active connector instance(s) healthy`,
    };
  }
  return {
    domain: "connector_health",
    status: "attention",
    headlineCount: unhealthy,
    detail: `${unhealthy} of ${active.length} connector instance(s) not healthy (${stale} stale, ${neverSeen} never seen)`,
  };
}
