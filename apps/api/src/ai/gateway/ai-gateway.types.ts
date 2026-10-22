/**
 * Types for the AI gateway skeleton — RT-655 (RT-643 §2/§5, AD-AI-ENT-001).
 *
 * The gateway sits ABOVE `ModelProviderPort` and is provider-agnostic. Every
 * collaborator it needs is a small port so later tickets replace one at a time
 * without touching the gateway: RT-664 binds the real entitlement port (the
 * `ai-entitlements` check, reserve and settle on the RT-663 usage ledger),
 * RT-647 supplies the evidence-pack builder, RT-657 adds a vendor adapter and
 * an allowlisted route.
 */
import type { ResolvedContext } from "../../context/types";
import type { AiFeatureDefinition } from "./ai-feature";
import type {
  EvidencePack,
  ModelProviderPort,
  ModelRouteDescriptor,
  ModelUsage,
} from "../ports/model-provider.port";

/**
 * The closed set of reasons a run ends in the deterministic fallback.
 * The entitlement/budget/system codes are AD-AI-ENT-001's closed reason set;
 * the rest are the RT-643 §5 failure conditions. Used verbatim as the
 * `outcome` metric label, so adding a member is a cardinality review.
 */
export const AI_FALLBACK_REASONS = [
  // authorization (layers 2-4)
  "not_authorized",
  "store_out_of_scope",
  "unknown_feature",
  // entitlement (layer 6)
  "tenant_inactive",
  "not_entitled",
  "trial_expired",
  "grace_read_only",
  "feature_disabled_tenant",
  "entitlement_unavailable",
  // kill switch (layer 0, evaluated at the ticket's step 3)
  "feature_disabled_system",
  // budget (layer 7)
  "quota_exhausted",
  "spend_cap_reached",
  "free_credit_exhausted",
  // evidence and routing
  "evidence_unavailable",
  "route_not_allowlisted",
  "unsupported_capability",
  "context_too_large",
  // provider conditions
  "provider_timeout",
  "provider_unavailable",
  "provider_refused",
  "provider_truncated",
  "provider_rejected_input",
  "provider_error",
  // output validation
  "output_schema_invalid",
  "output_unknown_evidence_ref",
  // an unexpected throw from a feature hook or dependency: still a fallback
  "internal_error",
] as const;
export type AiFallbackReason = (typeof AI_FALLBACK_REASONS)[number];

export type AiEntitlementDenyReason = Extract<
  AiFallbackReason,
  | "not_authorized"
  | "tenant_inactive"
  | "not_entitled"
  | "trial_expired"
  | "grace_read_only"
  | "feature_disabled_tenant"
  | "entitlement_unavailable"
>;

export type AiBudgetDenyReason = Extract<
  AiFallbackReason,
  "quota_exhausted" | "spend_cap_reached" | "free_credit_exhausted" | "entitlement_unavailable"
>;

export type AiGatewayResult<T = unknown> =
  | {
      readonly kind: "ok";
      /** The VALIDATED output only; never the raw provider output. */
      readonly output: T;
      readonly evidenceRefs: readonly string[];
      readonly routeKey: string;
      readonly usage: ModelUsage;
    }
  | {
      readonly kind: "fallback";
      readonly reason: AiFallbackReason;
      /** True only when a request actually reached the provider port. */
      readonly providerRequested: boolean;
    };

/** What the caller asks for. The caller never picks a route, model or provider. */
export interface AiRunScope {
  /** The resolved request context (`TenantContextGuard`); AI runs as the caller. */
  readonly ctx: ResolvedContext;
  /**
   * Stores the answer will cover. Empty means tenant-wide, which only a
   * principal with tenant-wide store access may request (D-4: refuse, never
   * silently narrow).
   */
  readonly storeIds: readonly string[];
  /** Opaque, no PII (Constitution §XIV). */
  readonly correlationId: string;
  /** Feature-specific, already-validated parameters for the evidence builder. */
  readonly params?: Readonly<Record<string, unknown>>;
  /**
   * The request's `Idempotency-Key` (RT-664, D-3): the usage reservation is
   * unique per (tenant, feature, key), so a retry is counted once. A run
   * without one cannot reserve and fails closed (`entitlement_unavailable`).
   */
  readonly idempotencyKey?: string;
}

export interface AiPolicyInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly featureId: string;
  readonly storeIds: readonly string[];
}

export type AiEntitlementDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: AiEntitlementDenyReason };

export type AiReserveDenyReason = AiEntitlementDenyReason | "quota_exhausted";

export interface AiReserveInput extends AiPolicyInput {
  /** The caller's context: the port re-checks layers 1-6 inside the reservation transaction. */
  readonly ctx: ResolvedContext;
  readonly idempotencyKey: string;
  /** v1 customer meters count requests (D-3): always 1. */
  readonly units: number;
  readonly correlationId: string;
}

/**
 * A reservation (layer 7, Option A). Only the call that took it may run the
 * request it pays for: `runnable: false` is a replay of the key (another call
 * holds, or already settled, the reservation), which must not reach the
 * provider, so concurrent same-key calls make one provider call.
 */
export type AiReservation =
  | { readonly allowed: true; readonly reservationId: string; readonly entitlementVersion: number; readonly runnable: boolean }
  | { readonly allowed: false; readonly reason: AiReserveDenyReason };

/** The usage ledger's terminal outcomes (0055). Only `ok` is charged (D-8). */
export const AI_USAGE_OUTCOMES = [
  "ok",
  "provider_refused",
  "output_truncated",
  "output_invalid",
  "provider_unavailable",
  "input_rejected",
  "not_attempted",
] as const;
export type AiUsageOutcome = (typeof AI_USAGE_OUTCOMES)[number];

/** Run metadata for the ledger's terminal row (AI-09). Never prompt or completion text. */
export interface AiRunTelemetry {
  readonly requestId?: string;
  readonly routeKey?: string;
  readonly promptTemplateId?: string;
  readonly promptTemplateVersion?: string;
  readonly outputSchemaId?: string;
  readonly providerKey?: string;
  readonly modelId?: string;
  readonly evidenceRefIds?: readonly string[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly tokenCountSource?: "reported" | "estimated";
  readonly providerRequestId?: string;
}

export interface AiUsageSettlement {
  readonly tenantId: string;
  readonly reservationId: string;
  readonly outcome: AiUsageOutcome;
  readonly telemetry: AiRunTelemetry;
}

/**
 * Entitlement port (AD-AI-ENT-001 layers 1, 6 and the quota of layer 7),
 * bound to the `ai-entitlements` module (RT-664).
 *
 *   check   — layers 1 and 6, read-only, before the budget pre-check;
 *   reserve — re-checks layers 1 and 6 and reserves the units (Option A),
 *             after the kill switch and the budget pre-check, before any
 *             evidence is read or request built;
 *   settle  — commits (`ok`) or releases (anything else) the reservation
 *             after the run; a failed settle is left to the TTL sweeper.
 *
 * A throw is treated as `entitlement_unavailable` (fail closed).
 */
export interface AiEntitlementPort {
  check(input: AiPolicyInput): Promise<AiEntitlementDecision>;
  reserve(input: AiReserveInput): Promise<AiReservation>;
  settle(settlement: AiUsageSettlement): Promise<void>;
  /** The sweeper's TTL: every allowlisted route's timeout must be shorter. */
  readonly reservationTtlMs: number;
}

export type AiBudgetDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: AiBudgetDenyReason };

/**
 * Budget pre-check port (AD-AI-ENT-001 layer 7): the internal spend cap and
 * the platform free-credit pool, checked before the quota reservation. It
 * writes nothing; the quota itself is the entitlement port's `reserve`. No
 * spend cap or credit pool is sized yet (RT-645), so the default fails
 * closed. A throw fails closed.
 */
export interface AiBudgetPort {
  check(input: AiPolicyInput & { readonly routeKey: string }): Promise<AiBudgetDecision>;
}

export interface AiEvidenceBuildInput {
  readonly ctx: ResolvedContext;
  readonly featureId: string;
  readonly storeIds: readonly string[];
  readonly correlationId: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * Evidence-pack hook (RT-647 supplies real builders). Must read only through
 * the existing tenant/store-scoped repositories (`withTenant`/RLS). An empty
 * or failed build ends in a fallback; no request is ever sent without evidence.
 */
export interface AiEvidencePackBuilder {
  build(input: AiEvidenceBuildInput): Promise<EvidencePack>;
}

/**
 * Process-level switches, read per call (the `isPosReturnsEnabled` convention)
 * so AI can be switched off without a redeploy of core flows (AI-14).
 */
export interface AiGatewayRuntime {
  /** The kill switch. Defaults to disabled: AI runs only when explicitly enabled. */
  isEnabled(): boolean;
  isProduction(): boolean;
}

/** Bounded-label metric sink (see `ai-gateway.metrics.ts`). No tenant/store/user. */
export interface AiGatewayMetrics {
  recordRun(attrs: { feature: string; outcome: string }): void;
  recordProviderCall(attrs: { provider: string; route: string; outcome: string }): void;
}

/** The slice of a pino logger the gateway uses. Never handed prompt or completion text. */
export interface AiGatewayLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface AiGatewayDeps {
  readonly features: readonly AiFeatureDefinition[];
  readonly entitlement: AiEntitlementPort;
  readonly budget: AiBudgetPort;
  readonly evidence: AiEvidencePackBuilder;
  /** Static, repo-owned allowlist. Empty by default. */
  readonly routes: readonly ModelRouteDescriptor[];
  readonly providers: readonly ModelProviderPort[];
  readonly runtime: AiGatewayRuntime;
  readonly metrics: AiGatewayMetrics;
  readonly logger?: AiGatewayLogger;
}
