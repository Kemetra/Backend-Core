/**
 * Pre-call input-size estimate (RT-643 §4/§7: "enforced BEFORE the call").
 *
 * Deliberately provider-neutral and cheap, and CONSERVATIVE: it assumes at
 * least one token per two UTF-8 bytes of the system text plus the serialized
 * evidence pack. That over-estimates English (about four bytes per token) and
 * still bounds Arabic (two bytes per character, often one or two characters
 * per token), emoji and UUID / hex text, which tokenize far denser than four
 * characters per token. It is a guard, not a bill: real usage comes back in
 * `ModelUsage` and cost attribution is the usage ledger's job (RT-663).
 * Over-estimating is the safe direction; a route sets `maxInputTokens` with
 * this bound in mind.
 */
import type { ModelRequest } from "./ports/model-provider.port";

const BYTES_PER_TOKEN = 2;

export function estimateInputTokens(
  request: Pick<ModelRequest, "system" | "evidencePack">,
): number {
  const text = request.system + JSON.stringify(request.evidencePack);
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}
