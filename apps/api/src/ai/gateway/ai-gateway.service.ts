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
 * state. An unknown or unavailable state is a deny. The step logic lives in
 * `ai-gateway.authorize.ts`, `.routing.ts` and `.output.ts`; this class
 * orchestrates them.
 *
 * Every failure ends in a fallback: `run()` never rejects. An unexpected throw
 * from a feature hook or a dependency becomes `internal_error`.
 *
 * Retries: none. RT-643 §5 allows at most one for idempotent read summaries;
 * RT-655 does not require it, so the gateway makes exactly one attempt.
 *
 * Logging discipline (AD-AI-PROV-001 E-5): only business-class fields are
 * logged. Prompt, system text, evidence, completions, raw output and error
 * MESSAGES never reach the logger; faults log the error class only.
 */
import { Inject, Injectable } from "@nestjs/common";

import { estimateInputTokens } from "../token-estimate";
import type {
  EvidencePack,
  ModelRequest,
  ModelResult,
} from "../ports/model-provider.port";
import { isModelResult } from "../ports/model-result-guard";
import { AI_GATEWAY_DEPS } from "../ai.tokens";
import { assertStrictOutputSchema, type AiFeatureDefinition } from "./ai-feature";
import { authorizeScope, type Principal } from "./ai-gateway.authorize";
import { interpretResult } from "./ai-gateway.output";
import { errorClass, fallback, providerOutcome, type Fallback } from "./ai-gateway.result";
import { resolveRoute, type ResolvedRoute } from "./ai-gateway.routing";
import {
  AI_FALLBACK_REASONS,
  type AiFallbackReason,
  type AiGatewayDeps,
  type AiGatewayResult,
  type AiPolicyInput,
  type AiRunScope,
} from "./ai-gateway.types";

/** What a run observed, for the one summary log line and metric. */
interface RunTrace {
  feature: string;
  routeKey: string | null;
  faultClass: string | null;
  providerRequested: boolean;
}

const FALLBACK_REASON_SET: ReadonlySet<string> = new Set(AI_FALLBACK_REASONS);

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
    const trace: RunTrace = {
      feature: "unknown",
      routeKey: null,
      faultClass: null,
      providerRequested: false,
    };
    let result: AiGatewayResult;
    try {
      result = await this.execute(featureId, scope, trace);
    } catch (error) {
      trace.faultClass = errorClass(error);
      result = fallback("internal_error", trace.providerRequested);
    }
    this.report(trace, scope, result);
    return result as AiGatewayResult<T>;
  }

  private async execute(
    featureId: string,
    scope: AiRunScope,
    trace: RunTrace,
  ): Promise<AiGatewayResult> {
    const gated = await this.gate(featureId, scope, trace);
    return gated.kind === "fallback" ? gated : this.generate(gated.feature, scope, trace);
  }

  /** Steps 1-4: everything that must pass before any evidence is read. */
  private async gate(
    featureId: string,
    scope: AiRunScope,
    trace: RunTrace,
  ): Promise<Fallback | { readonly kind: "gated"; readonly feature: AiFeatureDefinition }> {
    const principal = authorizeScope(scope);
    if ("reason" in principal) return fallback(principal.reason);
    const feature = this.features.get(featureId);
    if (feature === undefined) return fallback("unknown_feature");
    trace.feature = feature.featureId;

    const denied = await this.denyBeforeSpend(this.policyInput(principal, feature, scope), feature);
    return denied === null ? { kind: "gated", feature } : fallback(denied);
  }

  private policyInput(
    principal: Principal,
    feature: AiFeatureDefinition,
    scope: AiRunScope,
  ): AiPolicyInput {
    return {
      tenantId: principal.tenantId,
      userId: principal.userId,
      featureId: feature.featureId,
      storeIds: scope.storeIds,
    };
  }

  /** Steps 5-9: evidence, route, one provider attempt, validation. */
  private async generate(
    feature: AiFeatureDefinition,
    scope: AiRunScope,
    trace: RunTrace,
  ): Promise<AiGatewayResult> {
    const pack = await this.buildEvidence(feature, scope);
    if (pack === null) return fallback("evidence_unavailable");

    const routed = resolveRoute(feature, this.deps);
    if ("reason" in routed) return fallback(routed.reason);
    trace.routeKey = routed.route.routeKey;

    const request = this.buildRequest(feature, routed, pack, scope);
    if (estimateInputTokens(request) > routed.route.maxInputTokens) {
      return fallback("context_too_large");
    }

    trace.providerRequested = true;
    const outcome = await this.callProvider(routed, request, trace);
    this.deps.metrics.recordProviderCall({
      provider: routed.provider.providerKey,
      route: routed.route.routeKey,
      outcome: providerOutcome(outcome),
    });
    if (outcome === "fault") return fallback("provider_error", true);
    return interpretResult(outcome, feature, routed.route, pack);
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
    return budget?.allowed === true ? null : this.denyReason(budget);
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

  private buildRequest(
    feature: AiFeatureDefinition,
    routed: ResolvedRoute,
    pack: EvidencePack,
    scope: AiRunScope,
  ): ModelRequest {
    return {
      route: routed.route,
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
   * stall the run. The timer is always cleared and a late settle is ignored
   * (Promise.race subscribes to `call`, so a rejection that arrives after the
   * timeout already won is handled). A throw or a malformed result is a
   * `fault` (OPTIONAL_DEGRADE covers programmer errors too). Never retried.
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
    try {
      const result: unknown = await Promise.race([call, timeout]);
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

  /**
   * One metric and one log line per run; business-class fields only (E-5).
   * Observability must never change or fail a run, so a throwing metric sink or
   * logger is contained here.
   */
  private report(trace: RunTrace, scope: AiRunScope, result: AiGatewayResult): void {
    const outcome = result.kind === "ok" ? "ok" : result.reason;
    try {
      this.deps.metrics.recordRun({ feature: trace.feature, outcome });
      this.log(trace, scope, result, outcome);
    } catch {
      // intentionally contained: see the method comment
    }
  }

  private log(trace: RunTrace, scope: AiRunScope, result: AiGatewayResult, outcome: string): void {
    const logger = this.deps.logger;
    if (logger === undefined) return;
    if (trace.faultClass !== null) {
      logger.warn(
        {
          event: "ai.gateway.fault",
          reason: outcome,
          err_class: trace.faultClass,
          feature: trace.feature,
          route: trace.routeKey,
          correlation_id: scope.correlationId,
        },
        "ai gateway fault",
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
