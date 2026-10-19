/**
 * AI gateway metrics — RT-655 (docs/observability/signals.md §1.4).
 *
 * Bounded labels only: `assertMetricLabels` runs at module load, so a label
 * outside the `ALLOWED_METRIC_LABELS` entry (or a forbidden one such as
 * `tenant_id`) throws before any instrument can record. Helper parameter types
 * admit only the declared keys. Per-tenant cost is NOT a metric: it lives in the
 * usage ledger owned by RT-663 (AD-AI-PROV-001 D-6).
 *
 * Instruments are no-ops until an OTel MetricReader is registered.
 */
import { assertMetricLabels, getMeter, type Attributes, type Counter } from "@data-pulse-2/shared";

import type { AiGatewayMetrics } from "./ai-gateway.types";

assertMetricLabels("ai_gateway_run_total", ["feature", "outcome"]);
assertMetricLabels("ai_gateway_provider_call_total", ["provider", "route", "outcome"]);

const meter = getMeter("api");

const _run: Counter = meter.createCounter("ai_gateway_run_total", {
  description:
    "AI gateway runs by code-owned feature id and outcome (ok or a closed fallback reason) (RT-655). No tenant, store, user or correlation label.",
});

const _providerCall: Counter = meter.createCounter("ai_gateway_provider_call_total", {
  description:
    "Provider requests actually sent, by allowlisted provider and route and by result outcome (RT-655). No model id, token count or cost label.",
});

export const aiGatewayMetrics: AiGatewayMetrics = {
  recordRun(attrs) {
    _run.add(1, attrs as unknown as Attributes);
  },
  recordProviderCall(attrs) {
    _providerCall.add(1, attrs as unknown as Attributes);
  },
};

export const AI_METRIC_NAMES = ["ai_gateway_run_total", "ai_gateway_provider_call_total"] as const;
