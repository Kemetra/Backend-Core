/**
 * Types for the AI gateway skeleton — RT-655 (RT-643 §2/§5, AD-AI-ENT-001).
 *
 * The gateway sits ABOVE `ModelProviderPort` and is provider-agnostic. Every
 * collaborator it needs is a small port so later tickets replace one at a time
 * without touching the gateway: RT-664 replaces the deny-all entitlement stub,
 * RT-663 supplies the budget/usage ledger, RT-647 supplies the evidence-pack
 * builder, RT-657 adds a vendor adapter and an allowlisted route.
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

/**
 * Entitlement port (AD-AI-ENT-001 layer 6). RT-664 supplies the real
 * `ai-entitlements` implementation; until then the module binds a deny-all stub.
 * A throw is treated as `entitlement_unavailable` (fail closed).
 */
export interface AiEntitlementPort {
  check(input: AiPolicyInput): Promise<AiEntitlementDecision>;
}

export type AiBudgetDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: AiBudgetDenyReason };

/**
 * Budget pre-check port (AD-AI-ENT-001 layer 7). Check only: the reserve /
 * commit ledger and usage rows belong to RT-663, which owns the one AI usage
 * store (D-6); this skeleton writes no usage rows. A throw fails closed.
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
