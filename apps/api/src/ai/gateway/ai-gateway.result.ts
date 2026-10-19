/**
 * Small result helpers shared by the gateway steps — RT-655.
 */
import type { ModelResult } from "../ports/model-provider.port";
import type { AiFallbackReason, AiGatewayResult } from "./ai-gateway.types";

export type Fallback = Extract<AiGatewayResult, { kind: "fallback" }>;

export function fallback(reason: AiFallbackReason, providerRequested = false): Fallback {
  return { kind: "fallback", reason, providerRequested };
}

/** The error CLASS only. Messages can carry prompt text or credentials and are never logged. */
export function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "non_error_throw";
}

/** Closed `outcome` label for `ai_gateway_provider_call_total`. */
export function providerOutcome(result: ModelResult | "fault"): string {
  if (result === "fault") return "error";
  return result.kind === "unavailable" ? `unavailable_${result.cause}` : result.kind;
}
