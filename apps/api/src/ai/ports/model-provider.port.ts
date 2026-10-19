/**
 * model-provider.port.ts — RT-655 (RT-643 F-2, §2 of the RT-643 draft).
 *
 * The provider-NEUTRAL seam between the Backend-Core AI gateway and whatever
 * generates tokens. Mirrors `auth/identity-provider.port.ts`:
 *
 *   - No vendor type crosses this line. A future adapter (RT-657) translates a
 *     `ModelRequest` into its own wire format and maps the answer back into a
 *     `ModelResult`; nothing vendor-typed is returned.
 *   - No retries inside the adapter (the `email.adapter.ts` precedent). The
 *     gateway makes exactly one attempt per run.
 *   - Expected provider conditions (refusal, truncation, timeout, 429/5xx,
 *     network, auth, oversized input) are RETURNED as `ModelResult` variants,
 *     never thrown. An adapter throws only on programmer error.
 *   - Credentials never leave the adapter. This module has no network,
 *     credential or SDK reference.
 *
 * This port is internal and is not an OpenAPI contract. Any Console-facing AI
 * route goes contract-first through packages/contracts/openapi/** [GATED].
 *
 * Authority split (AI-01, AI-03, AD-AI-PROV-001 D-3): Backend-Core owns
 * authorization, entitlement, budget, evidence, prompt templates, output
 * validation, audit and fallback. The adapter is only a translation layer.
 */

/** What a route declares it can do. Verified by the conformance suite, never assumed. */
export type ModelCapability =
  | "text_generation"
  | "structured_output_native"
  | "tool_calling"
  | "streaming"
  | "explicit_refusal_signal"
  | "usage_reporting"
  | "prompt_caching";

/**
 * A resolved route: chosen by Backend-Core routing from a static, repo-owned
 * allowlist, never by the caller and never by a tenant (RT-643 §4).
 */
export interface ModelRouteDescriptor {
  /** e.g. "sync_doctor.explain_sale@v1" */
  readonly routeKey: string;
  /** "fake" | "recorded" | a future approved vendor key. A discriminator only. */
  readonly providerKey: string;
  /** Pinned exact model version. No "latest" aliases. */
  readonly modelId: string;
  readonly capabilities: ReadonlySet<ModelCapability>;
  /** Enforced by the gateway BEFORE the call (estimate) and by adapters. */
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  /** Enforced by the gateway; an adapter also honours the AbortSignal. */
  readonly timeoutMs: number;
  /** Declared processing region; must satisfy deployment policy (AD-AI-PROV-001 D-7). */
  readonly dataRegion: string;
  /** A synthetic-only route cannot be used in production (AD-AI-PROV-001 E-9). */
  readonly syntheticOnly: boolean;
}

export type EvidenceFieldValue = string | number | boolean | null;

/** One authorized, minimized, redacted fact. `ref` is what the model may cite. */
export interface EvidenceItem {
  readonly ref: string;
  readonly fields: Readonly<Record<string, EvidenceFieldValue>>;
}

/**
 * The deterministic, authorized evidence the model summarizes (AI-05, AI-06).
 * Built by Backend-Core before the call; the model never gets a DB handle.
 * Domain text inside `fields` is untrusted data (AI-11).
 */
export interface EvidencePack {
  readonly items: readonly EvidenceItem[];
}

export interface ModelRequest {
  readonly route: ModelRouteDescriptor;
  /** Versioned, repo-owned template id. */
  readonly promptTemplateId: string;
  readonly promptTemplateVersion: string;
  /** Rendered from the template; never tenant-authored. */
  readonly system: string;
  readonly evidencePack: EvidencePack;
  /** Zod schema id + version. Backend-Core validates; the adapter does not. */
  readonly outputSchemaId: string;
  /** Opaque, no PII (Constitution §XIV). */
  readonly correlationId: string;
}

/** What the provider reported. May be partial; `reported:false` means estimated. */
export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reported: boolean;
}

export type ModelUnavailableCause =
  | "timeout"
  | "rate_limited"
  | "provider_5xx"
  | "network"
  | "auth"
  | "disabled";

export type ModelResult =
  | { readonly kind: "ok"; readonly rawOutput: unknown; readonly usage: ModelUsage; readonly providerRequestId?: string }
  | { readonly kind: "refused"; readonly reason: "provider_refusal" | "safety_filter"; readonly usage?: ModelUsage }
  /** Hit max tokens. Treated as a failure by the gateway; never partially used. */
  | { readonly kind: "truncated"; readonly usage: ModelUsage }
  | { readonly kind: "unavailable"; readonly cause: ModelUnavailableCause }
  | { readonly kind: "rejected_input"; readonly cause: "context_too_large" | "unsupported_capability" };

export interface ModelProviderPort {
  readonly providerKey: string;
  /**
   * One attempt. Never retries. Never throws for an expected provider
   * condition: return the matching `ModelResult` variant. Throws only on
   * programmer error (the gateway degrades that to a fallback too).
   */
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
}
