/**
 * Closed sets of the AI entitlements runtime — RT-664, mirroring
 * `ai-entitlements.openapi.yaml` (RT-662) and migration 0055 (RT-663).
 */

/** `AiEntitlementState` (RT-644 §4.3). */
export const AI_ENTITLEMENT_STATES = ["none", "trial", "active", "grace", "expired", "cancelled"] as const;
export type AiEntitlementState = (typeof AI_ENTITLEMENT_STATES)[number];

export type MeterWindow = "day" | "month";
export type MeterScope = "tenant" | "store";

/** Layer 6 refusals (D-1, D-5, D-7). */
export type EntitlementDenyReason = "not_entitled" | "trial_expired" | "grace_read_only" | "feature_disabled_tenant";

/** Layer 7 refusals. Spend cap and free credit come from the gateway budget port. */
export type QuotaDenyReason = "quota_exhausted";

/** `AiCheckDenyReasonCode`: every reason a `check` may deny with. */
export type AiCheckDenyReason =
  | "not_authorized"
  | "tenant_inactive"
  | "feature_disabled_system"
  | "policy_denied"
  | EntitlementDenyReason
  | QuotaDenyReason
  | "spend_cap_reached"
  | "free_credit_exhausted"
  | "entitlement_unavailable";

/**
 * The ledger's terminal outcomes (0055 `ai_usage_ledger_outcome_valid`).
 * Only `ok` is committed (charged); every other outcome is a release (D-8).
 */
export const AI_USAGE_OUTCOMES = [
  "ok",
  "provider_refused",
  "output_truncated",
  "output_invalid",
  "provider_unavailable",
  "input_rejected",
  "not_attempted",
  "reservation_expired",
] as const;
export type AiUsageOutcome = (typeof AI_USAGE_OUTCOMES)[number];
