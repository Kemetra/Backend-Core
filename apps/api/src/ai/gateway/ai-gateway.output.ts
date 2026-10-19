/**
 * Gateway steps 8-9 — interpret the provider result (RT-655, RT-643 §5/§9.1).
 *
 * Backend-Core is always authoritative: every output is re-validated against a
 * strict Zod schema, every cited evidence ref must be in the pack that was
 * sent, and only the validated object is returned. Anything else becomes a
 * deterministic fallback that carries no provider output, usage or evidence.
 */
import type {
  EvidencePack,
  ModelResult,
  ModelRouteDescriptor,
} from "../ports/model-provider.port";
import type { AiFeatureDefinition } from "./ai-feature";
import { fallback } from "./ai-gateway.result";
import type { AiGatewayResult } from "./ai-gateway.types";

type OkResult = Extract<ModelResult, { kind: "ok" }>;

/** The refs the validated output cites, or null if the feature hook misbehaves. */
function citedRefs(feature: AiFeatureDefinition, output: unknown): readonly string[] | null {
  let refs: unknown;
  try {
    refs = feature.extractEvidenceRefs(output);
  } catch {
    return null;
  }
  const wellFormed = Array.isArray(refs) && refs.every((ref) => typeof ref === "string");
  return wellFormed ? (refs as readonly string[]) : null;
}

function validateOk(
  result: OkResult,
  feature: AiFeatureDefinition,
  route: ModelRouteDescriptor,
  pack: EvidencePack,
): AiGatewayResult {
  const parsed = feature.outputSchema.safeParse(result.rawOutput);
  if (!parsed.success) return fallback("output_schema_invalid", true);

  const refs = citedRefs(feature, parsed.data);
  if (refs === null) return fallback("output_schema_invalid", true);

  const known = new Set(pack.items.map((item) => item.ref));
  if (!refs.every((ref) => known.has(ref))) return fallback("output_unknown_evidence_ref", true);

  return {
    kind: "ok",
    output: parsed.data,
    evidenceRefs: refs,
    routeKey: route.routeKey,
    usage: result.usage,
  };
}

export function interpretResult(
  result: ModelResult,
  feature: AiFeatureDefinition,
  route: ModelRouteDescriptor,
  pack: EvidencePack,
): AiGatewayResult {
  switch (result.kind) {
    case "refused":
      return fallback("provider_refused", true);
    case "truncated":
      return fallback("provider_truncated", true);
    case "rejected_input":
      return fallback("provider_rejected_input", true);
    case "unavailable":
      return fallback(result.cause === "timeout" ? "provider_timeout" : "provider_unavailable", true);
    case "ok":
      return validateOk(result, feature, route, pack);
  }
}
