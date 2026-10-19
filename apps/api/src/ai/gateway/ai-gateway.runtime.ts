/**
 * AI gateway process switches — RT-655.
 *
 * The kill switch is `AI_GATEWAY_ENABLED` and DEFAULTS OFF (AD-AI-PROV-001
 * E-9, AI-14): AI generation is denied (`feature_disabled_system`) unless the
 * API runs with the flag set to "1", "true" or "yes" (case-insensitive,
 * trimmed). Read per call, the `isPosReturnsEnabled` convention, so flipping
 * it takes effect without a restart of any core flow.
 */
import type { AiGatewayRuntime } from "./ai-gateway.types";

function isEnabledFlag(): boolean {
  const raw = (process.env["AI_GATEWAY_ENABLED"] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function readAiGatewayRuntime(): AiGatewayRuntime {
  return {
    isEnabled: isEnabledFlag,
    isProduction: () => process.env["NODE_ENV"] === "production",
  };
}
