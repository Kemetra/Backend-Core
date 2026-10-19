/**
 * Runtime shape guard for `ModelResult` — RT-655.
 *
 * TypeScript types do not hold at runtime: a buggy or future vendor adapter can
 * return a recognised `kind` with a malformed payload. The gateway therefore
 * checks each variant's COMPLETE runtime shape and closed enums before it trusts
 * a result, so an out-of-set `cause` can never become an unbounded metric label
 * and an `ok` without `usage` can never reach a caller. A failed check is an
 * adapter fault (`provider_error`).
 */
import type { ModelResult, ModelUsage } from "./model-provider.port";

const UNAVAILABLE_CAUSES: ReadonlySet<unknown> = new Set([
  "timeout",
  "rate_limited",
  "provider_5xx",
  "network",
  "auth",
  "disabled",
]);
const REFUSAL_REASONS: ReadonlySet<unknown> = new Set(["provider_refusal", "safety_filter"]);
const REJECTION_CAUSES: ReadonlySet<unknown> = new Set([
  "context_too_large",
  "unsupported_capability",
]);

type Candidate = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Candidate {
  return typeof value === "object" && value !== null;
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isUsage(value: unknown): value is ModelUsage {
  return (
    isRecord(value) &&
    typeof value["reported"] === "boolean" &&
    isOptionalCount(value["inputTokens"]) &&
    isOptionalCount(value["outputTokens"]) &&
    isOptionalCount(value["cachedInputTokens"])
  );
}

function isOk(result: Candidate): boolean {
  const id = result["providerRequestId"];
  return isUsage(result["usage"]) && (id === undefined || typeof id === "string");
}

function isRefused(result: Candidate): boolean {
  const usage = result["usage"];
  return REFUSAL_REASONS.has(result["reason"]) && (usage === undefined || isUsage(usage));
}

const VARIANT_CHECKS: ReadonlyMap<unknown, (result: Candidate) => boolean> = new Map([
  ["ok", isOk],
  ["refused", isRefused],
  ["truncated", (result: Candidate) => isUsage(result["usage"])],
  ["unavailable", (result: Candidate) => UNAVAILABLE_CAUSES.has(result["cause"])],
  ["rejected_input", (result: Candidate) => REJECTION_CAUSES.has(result["cause"])],
]);

export function isModelResult(value: unknown): value is ModelResult {
  if (!isRecord(value)) return false;
  const check = VARIANT_CHECKS.get(value["kind"]);
  return check !== undefined && check(value);
}
