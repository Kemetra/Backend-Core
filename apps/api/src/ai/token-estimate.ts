/**
 * Pre-call input-size estimate (RT-643 §4/§7: "enforced BEFORE the call").
 *
 * Deliberately provider-neutral and cheap: about four characters per token
 * over the system text plus the serialized evidence pack. It is a guard, not a
 * bill: real usage comes back in `ModelUsage`, and cost attribution is the
 * usage ledger's job (RT-663). Over-estimating is the safe direction.
 */
import type { ModelRequest } from "./ports/model-provider.port";

const CHARS_PER_TOKEN = 4;

export function estimateInputTokens(
  request: Pick<ModelRequest, "system" | "evidencePack">,
): number {
  const chars = request.system.length + JSON.stringify(request.evidencePack).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
