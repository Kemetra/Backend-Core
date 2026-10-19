/**
 * AiModule — RT-655. Provides the AI gateway with SAFE DEFAULTS:
 *
 *   - no registered features and an EMPTY route allowlist
 *   - the real entitlement port (RT-664 `AiEntitlementsModule`: layers 1, 6
 *     and the Option A quota reservation on the RT-663 usage ledger), and a
 *     fail-closed budget (no spend cap or credit pool is sized yet, RT-645)
 *   - empty evidence builder (RT-647 supplies real ones)
 *   - the disabled provider (never the fake) and the kill switch off
 *
 * It has no controller, so it adds no HTTP route, and it is deliberately NOT
 * imported by AppModule yet: there is no consumer until a feature route exists
 * (contract-first, [GATED]). RT-648's offline harness builds the gateway from
 * these tokens directly.
 */
import { Module } from "@nestjs/common";

import { AiEntitlementsModule } from "../ai-entitlements/ai-entitlements.module";
import { AiGatewayEntitlementPort } from "../ai-entitlements/gateway-entitlement.port";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import { DisabledModelProvider } from "./adapters/disabled/disabled-model-provider";
import {
  AI_BUDGET,
  AI_ENTITLEMENT,
  AI_EVIDENCE_BUILDER,
  AI_FEATURES,
  AI_GATEWAY_DEPS,
  AI_GATEWAY_METRICS,
  AI_GATEWAY_RUNTIME,
  AI_MODEL_PROVIDERS,
  AI_POLICY_PORTS,
  AI_ROUTE_ALLOWLIST,
  AI_ROUTING,
} from "./ai.tokens";
import { EmptyEvidencePackBuilder, FailClosedAiBudget } from "./gateway/ai-gateway.defaults";
import { aiGatewayMetrics } from "./gateway/ai-gateway.metrics";
import { readAiGatewayRuntime } from "./gateway/ai-gateway.runtime";
import { AiGateway } from "./gateway/ai-gateway.service";
import type { AiGatewayDeps, AiGatewayLogger } from "./gateway/ai-gateway.types";

type PolicyPorts = Pick<AiGatewayDeps, "entitlement" | "budget" | "evidence">;
type Routing = Pick<AiGatewayDeps, "routes" | "providers">;

@Module({
  imports: [AiEntitlementsModule],
  providers: [
    { provide: AI_FEATURES, useValue: [] },
    { provide: AI_ENTITLEMENT, useExisting: AiGatewayEntitlementPort },
    { provide: AI_BUDGET, useClass: FailClosedAiBudget },
    { provide: AI_EVIDENCE_BUILDER, useClass: EmptyEvidencePackBuilder },
    { provide: AI_ROUTE_ALLOWLIST, useValue: [] },
    { provide: AI_MODEL_PROVIDERS, useFactory: () => [new DisabledModelProvider()] },
    { provide: AI_GATEWAY_RUNTIME, useFactory: () => readAiGatewayRuntime() },
    { provide: AI_GATEWAY_METRICS, useValue: aiGatewayMetrics },
    {
      provide: AI_POLICY_PORTS,
      useFactory: (
        entitlement: AiGatewayDeps["entitlement"],
        budget: AiGatewayDeps["budget"],
        evidence: AiGatewayDeps["evidence"],
      ): PolicyPorts => ({ entitlement, budget, evidence }),
      inject: [AI_ENTITLEMENT, AI_BUDGET, AI_EVIDENCE_BUILDER],
    },
    {
      provide: AI_ROUTING,
      useFactory: (
        routes: AiGatewayDeps["routes"],
        providers: AiGatewayDeps["providers"],
      ): Routing => ({ routes, providers }),
      inject: [AI_ROUTE_ALLOWLIST, AI_MODEL_PROVIDERS],
    },
    {
      provide: AI_GATEWAY_DEPS,
      useFactory: (
        features: AiGatewayDeps["features"],
        policy: PolicyPorts,
        routing: Routing,
        runtime: AiGatewayDeps["runtime"],
        metrics: AiGatewayDeps["metrics"],
        logger?: AiGatewayLogger,
      ): AiGatewayDeps => ({
        features,
        ...policy,
        ...routing,
        runtime,
        metrics,
        ...(logger === undefined ? {} : { logger }),
      }),
      inject: [
        AI_FEATURES,
        AI_POLICY_PORTS,
        AI_ROUTING,
        AI_GATEWAY_RUNTIME,
        AI_GATEWAY_METRICS,
        { token: ROOT_LOGGER, optional: true },
      ],
    },
    AiGateway,
  ],
  exports: [AiGateway],
})
export class AiModule {}
