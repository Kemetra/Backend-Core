/**
 * AiGateway — RT-655 (RT-643 F-2). The provider-agnostic gateway above
 * `ModelProviderPort`.
 *
 * `run(featureId, scope)` follows the ticket's order and is DENY-BY-DEFAULT:
 *
 *   1. authorize (resolved session principal + store scope; D-4 refuse)
 *   2. entitlement          (deny-all stub until RT-664)
 *   3. kill switch          (defaults off)
 *   4. budget pre-check
 *   5. evidence-pack hook
 *   6. route resolution     (static allowlist; empty by default)
 *   7. port.generate        (one attempt, gateway-owned timeout)
 *   8. Zod output validation + evidence-ref membership
 *   9. deterministic fallback for every failure (RT-643 §5)
 *
 * Steps 1-4 complete before ANY evidence is read or provider request is built
 * ("deny before spend"); the first deny ends the run and later layers are never
 * consulted, so an unauthorized caller learns nothing about plan or system
 * state. An unknown or unavailable state is a deny.
 *
 * Role/capability (`ai.<feature>:perform`, AD-AI-ENT-001 layer 3) is enforced by
 * the HTTP guards of the future route (`@Roles`), which run before this call;
 * the gateway enforces what a resolved context can prove: a human session
 * principal inside the tenant, and the requested store scope.
 *
 * Retries: none. RT-643 §5 allows at most one for idempotent read summaries;
 * RT-655 does not require it, so the gateway makes exactly one attempt.
 *
 * Logging discipline (AD-AI-PROV-001 E-5): only business-class fields are
 * logged. Prompt, system text, evidence, completions, raw output and error
 * MESSAGES never reach the logger; adapter faults log the error class only.
 */
import { Inject, Injectable } from "@nestjs/common";

import { resolveStoreScope } from "../../context/store-scope";
import { estimateInputTokens } from "../token-estimate";
import type {
  EvidencePack,
  ModelProviderPort,
  ModelRequest,
  ModelResult,
  ModelRouteDescriptor,
} from "../ports/model-provider.port";
import { AI_GATEWAY_DEPS } from "../ai.tokens";
import { assertStrictOutputSchema, type AiFeatureDefinition } from "./ai-feature";
import {
  AI_FALLBACK_REASONS,
  type AiFallbackReason,
  type AiGatewayDeps,
  type AiGatewayResult,
  type AiPolicyInput,
  type AiRunScope,
} from "./ai-gateway.types";

type Fallback = Extract<AiGatewayResult, { kind: "fallback" }>;
type Principal = { readonly tenantId: string; readonly userId: string };
type ResolvedRoute = { readonly route: ModelRouteDescriptor; readonly provider: ModelProviderPort };

/** What a run observed, for the one summary log line and metric. */
interface RunTrace {
  feature: string;
  routeKey: string | null;
  faultClass: string | null;
}

const MODEL_RESULT_KINDS: ReadonlySet<string> = new Set([
  "ok",
  "refused",
  "truncated",
  "unavailable",
  "rejected_input",
]);

const FALLBACK_REASON_SET: ReadonlySet<string> = new Set(AI_FALLBACK_REASONS);

function fallback(reason: AiFallbackReason, providerRequested = false): Fallback {
  return { kind: "fallback", reason, providerRequested };
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "non_error_throw";
}

function isModelResult(value: unknown): value is ModelResult {
  return (
    typeof value === "object" &&
    value !== null &&
    MODEL_RESULT_KINDS.has((value as { kind?: unknown }).kind as string)
  );
}

function providerOutcome(result: ModelResult | "fault"): string {
  if (result === "fault") return "error";
  return result.kind === "unavailable" ? `unavailable_${result.cause}` : result.kind;
}

@Injectable()
export class AiGateway {
  private readonly features: ReadonlyMap<string, AiFeatureDefinition>;

  constructor(@Inject(AI_GATEWAY_DEPS) private readonly deps: AiGatewayDeps) {
    const features = new Map<string, AiFeatureDefinition>();
    for (const feature of deps.features) {
      if (features.has(feature.featureId)) {
        throw new Error(`Duplicate AI feature "${feature.featureId}"`);
      }
      assertStrictOutputSchema(feature);
      features.set(feature.featureId, feature);
    }
    this.features = features;
  }

  async run<T = unknown>(featureId: string, scope: AiRunScope): Promise<AiGatewayResult<T>> {
    const trace: RunTrace = { feature: "unknown", routeKey: null, faultClass: null };
    const result = (await this.execute(featureId, scope, trace)) as AiGatewayResult<T>;
    this.report(trace, scope, result);
    return result;
  }

  private async execute(
    featureId: string,
    scope: AiRunScope,
    trace: RunTrace,
  ): Promise<AiGatewayResult> {
    // 1. authorize
    const principal = this.authorize(scope);
    if ("reason" in principal) return fallback(principal.reason);
    const feature = this.features.get(featureId);
    if (feature === undefined) return fallback("unknown_feature");
    trace.feature = feature.featureId;

    // 2-4. entitlement, kill switch, budget — all before any evidence read
    const policy: AiPolicyInput = {
      tenantId: principal.tenantId,
      userId: principal.userId,
      featureId: feature.featureId,
      storeIds: scope.storeIds,
    };
    const denied = await this.denyBeforeSpend(policy, feature);
    if (denied !== null) return fallback(denied);

    // 5. evidence-pack hook
    const pack = await this.buildEvidence(feature, scope);
    if (pack === null) return fallback("evidence_unavailable");

    // 6. route resolution (+ pre-call size guard)
    const routed = this.resolveRoute(feature);
    if ("reason" in routed) return fallback(routed.reason);
    trace.routeKey = routed.route.routeKey;
    const request = this.buildRequest(feature, routed.route, pack, scope);
    if (estimateInputTokens(request) > routed.route.maxInputTokens) {
      return fallback("context_too_large");
    }

    // 7. port.generate (one attempt)
    const outcome = await this.callProvider(routed, request, trace);
    this.deps.metrics.recordProviderCall({
      provider: routed.provider.providerKey,
      route: routed.route.routeKey,
      outcome: providerOutcome(outcome),
    });
    if (outcome === "fault") return fallback("provider_error", true);

    // 8-9. validate or fall back
    return this.interpret(outcome, feature, routed.route, pack);
  }

  /** Step 1. A resolved human session principal inside the tenant, and a store scope that covers the request. */
  private authorize(scope: AiRunScope): Principal | { reason: AiFallbackReason } {
    const { ctx, storeIds } = scope;
    // AD-AI-ENT-001 D-6: a platform admin reads entitlements for support but does
    // not consume tenant AI features, so it is denied here even with a tenant set.
    if (ctx.source !== "session" || ctx.userId === null || ctx.tenantId === null || ctx.isPlatformAdmin) {
      return { reason: "not_authorized" };
    }
    const allowed = resolveStoreScope(ctx);
    const covered =
      allowed.kind === "tenant" ||
      (storeIds.length > 0 && storeIds.every((storeId) => allowed.storeIds.includes(storeId)));
    return covered ? { tenantId: ctx.tenantId, userId: ctx.userId } : { reason: "store_out_of_scope" };
  }

  /** Steps 2-4. The first deny ends evaluation; a throw or unknown state fails closed. */
  private async denyBeforeSpend(
    policy: AiPolicyInput,
    feature: AiFeatureDefinition,
  ): Promise<AiFallbackReason | null> {
    const entitlement = await this.settle(() => this.deps.entitlement.check(policy));
    if (entitlement?.allowed !== true) return this.denyReason(entitlement);

    if (!this.deps.runtime.isEnabled()) return "feature_disabled_system";

    const budget = await this.settle(() =>
      this.deps.budget.check({ ...policy, routeKey: feature.routeKey }),
    );
    if (budget?.allowed !== true) return this.denyReason(budget);
    return null;
  }

  /** A throwing port yields null, which the caller reads as `entitlement_unavailable`. */
  private async settle<T>(operation: () => Promise<T>): Promise<T | null> {
    try {
      return await operation();
    } catch {
      return null;
    }
  }

  /** A deny with a missing or out-of-set reason is an unknown state: fail closed. */
  private denyReason(decision: { allowed: boolean; reason?: string } | null): AiFallbackReason {
    const reason = decision?.reason;
    return reason !== undefined && FALLBACK_REASON_SET.has(reason)
      ? (reason as AiFallbackReason)
      : "entitlement_unavailable";
  }

  /** Step 5. Null (no request) when the build fails or yields no evidence. */
  private async buildEvidence(
    feature: AiFeatureDefinition,
    scope: AiRunScope,
  ): Promise<EvidencePack | null> {
    const pack = await this.settle(() =>
      this.deps.evidence.build({
        ctx: scope.ctx,
        featureId: feature.featureId,
        storeIds: scope.storeIds,
        correlationId: scope.correlationId,
        params: scope.params ?? {},
      }),
    );
    return pack !== null && Array.isArray(pack.items) && pack.items.length > 0 ? pack : null;
  }

  /** Step 6. The route comes from the static allowlist only; the caller never chooses. */
  private resolveRoute(feature: AiFeatureDefinition): ResolvedRoute | { reason: AiFallbackReason } {
    const route = this.deps.routes.find((candidate) => candidate.routeKey === feature.routeKey);
    const provider = route
      ? this.deps.providers.find((candidate) => candidate.providerKey === route.providerKey)
      : undefined;
    if (route === undefined || provider === undefined) return { reason: "route_not_allowlisted" };
    if (route.syntheticOnly && this.deps.runtime.isProduction()) {
      return { reason: "route_not_allowlisted" };
    }
    if (!feature.requiredCapabilities.every((capability) => route.capabilities.has(capability))) {
      return { reason: "unsupported_capability" };
    }
    return { route, provider };
  }

  private buildRequest(
    feature: AiFeatureDefinition,
    route: ModelRouteDescriptor,
    pack: EvidencePack,
    scope: AiRunScope,
  ): ModelRequest {
    return {
      route,
      promptTemplateId: feature.promptTemplateId,
      promptTemplateVersion: feature.promptTemplateVersion,
      system: feature.renderSystemPrompt(),
      evidencePack: pack,
      outputSchemaId: feature.outputSchemaId,
      correlationId: scope.correlationId,
    };
  }

  /**
   * Step 7. The gateway owns the timeout: it races the call against a timer and
   * aborts the signal on expiry, so a hung or signal-ignoring adapter cannot
   * stall the run. The timer is always cleared, a late settle is ignored, and a
   * throw or a malformed return is a `fault` (OPTIONAL_DEGRADE covers
   * programmer errors too). Never retried.
   */
  private async callProvider(
    routed: ResolvedRoute,
    request: ModelRequest,
    trace: RunTrace,
  ): Promise<ModelResult | "fault"> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ModelResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "unavailable", cause: "timeout" });
      }, routed.route.timeoutMs);
    });
    const call = Promise.resolve().then(() => routed.provider.generate(request, controller.signal));
    // Promise.race subscribes to `call`, so a rejection that arrives after the
    // timeout already won is handled (covered by the late-rejection test).
    try {
      const result = await Promise.race([call, timeout]);
      if (isModelResult(result)) return result;
      trace.faultClass = "invalid_model_result";
      return "fault";
    } catch (error) {
      trace.faultClass = errorClass(error);
      return "fault";
    } finally {
      clearTimeout(timer);
    }
  }

  /** Steps 8-9. Only a validated output whose refs all came from the pack is returned. */
  private interpret(
    result: ModelResult,
    feature: AiFeatureDefinition,
    route: ModelRouteDescriptor,
    pack: EvidencePack,
  ): AiGatewayResult {
    switch (result.kind) {
      case "refused":
        return fallback("provider_refused", true);
      case "truncated":
        return fallback("provider_truncated", true);
      case "rejected_input":
        return fallback("provider_rejected_input", true);
      case "unavailable":
        return fallback(
          result.cause === "timeout" ? "provider_timeout" : "provider_unavailable",
          true,
        );
      case "ok":
        return this.validate(result, feature, route, pack);
    }
  }

  private validate(
    result: Extract<ModelResult, { kind: "ok" }>,
    feature: AiFeatureDefinition,
    route: ModelRouteDescriptor,
    pack: EvidencePack,
  ): AiGatewayResult {
    const parsed = feature.outputSchema.safeParse(result.rawOutput);
    if (!parsed.success) return fallback("output_schema_invalid", true);

    let refs: readonly string[];
    try {
      refs = feature.extractEvidenceRefs(parsed.data);
    } catch {
      return fallback("output_schema_invalid", true);
    }
    const known = new Set(pack.items.map((item) => item.ref));
    if (!refs.every((ref) => known.has(ref))) return fallback("output_unknown_evidence_ref", true);

    return {
      kind: "ok",
      output: parsed.data,
      evidenceRefs: refs,
      routeKey: route.routeKey,
      usage: result.usage,
    };
  }

  /** One metric and one log line per run; business-class fields only (E-5). */
  private report(trace: RunTrace, scope: AiRunScope, result: AiGatewayResult): void {
    const outcome = result.kind === "ok" ? "ok" : result.reason;
    this.deps.metrics.recordRun({ feature: trace.feature, outcome });

    const logger = this.deps.logger;
    if (logger === undefined) return;
    if (trace.faultClass !== null) {
      logger.warn(
        {
          event: "ai.gateway.fault",
          reason: "provider_error",
          err_class: trace.faultClass,
          feature: trace.feature,
          route: trace.routeKey,
          correlation_id: scope.correlationId,
        },
        "ai gateway provider fault",
      );
    }
    logger.info(
      {
        event: "ai.gateway.run",
        feature: trace.feature,
        route: trace.routeKey,
        outcome,
        provider_requested: result.kind === "ok" || result.providerRequested,
        correlation_id: scope.correlationId,
      },
      "ai gateway run",
    );
  }
}
