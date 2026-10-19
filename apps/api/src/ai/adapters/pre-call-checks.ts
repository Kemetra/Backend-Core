/**
 * Checks every adapter performs BEFORE it consults its provider (RT-643 §9.1:
 * "oversized context -> rejected_input pre-call"; timeout via AbortSignal).
 * Shared so the fake, the recorded adapter and any future vendor adapter
 * behave identically and the conformance suite can hold them to one contract.
 */
import { estimateInputTokens } from "../token-estimate";
import type { ModelRequest, ModelResult } from "../ports/model-provider.port";

/** The result to return without consulting the provider, or null to proceed. */
export function preCallResult(request: ModelRequest, signal: AbortSignal): ModelResult | null {
  if (signal.aborted) return { kind: "unavailable", cause: "timeout" };
  if (estimateInputTokens(request) > request.route.maxInputTokens) {
    return { kind: "rejected_input", cause: "context_too_large" };
  }
  return null;
}
