/**
 * AiGatewayEntitlementPort — RT-664: the `ai-entitlements` checker behind the
 * AI gateway's `AiEntitlementPort` (replacing the RT-655 deny-all stub).
 *
 *   check   → `AiEntitlementChecker.evaluate` (layers 1 and 6, read-only).
 *             The gateway has already authorized layers 2-4 for this
 *             principal and these stores.
 *   reserve → `AiEntitlementChecker.check` with the caller's own context:
 *             layers 1-6 again, in the reservation transaction, then the
 *             Option A reserve.
 *   settle  → commit / release on the usage ledger. A missing reservation
 *             throws so the gateway logs it; the sweeper is the backstop.
 *
 * Every refusal the checker can give maps to a gateway reason; anything
 * else fails closed as `entitlement_unavailable`. Run metadata longer than
 * the ledger's column bounds is dropped, never truncated mid-value, so a
 * settle cannot fail on its own telemetry.
 */
import { Injectable } from "@nestjs/common";
import type { AiUsageTelemetry } from "@data-pulse-2/db";

import type {
  AiEntitlementDecision,
  AiEntitlementDenyReason,
  AiEntitlementPort,
  AiPolicyInput,
  AiReservation,
  AiReserveDenyReason,
  AiReserveInput,
  AiRunTelemetry,
  AiUsageSettlement,
} from "../ai/gateway/ai-gateway.types";
import type { ResolvedContext } from "../context/types";
import { AiEntitlementChecker } from "./entitlement-checker";
import type { AiCheckDenyReason } from "./entitlement.types";

const ENTITLEMENT_REASONS: ReadonlySet<string> = new Set<AiEntitlementDenyReason>([
  "not_authorized",
  "tenant_inactive",
  "not_entitled",
  "trial_expired",
  "grace_read_only",
  "feature_disabled_tenant",
  "entitlement_unavailable",
]);
const RESERVE_REASONS: ReadonlySet<string> = new Set<AiReserveDenyReason>([...ENTITLEMENT_REASONS, "quota_exhausted"] as AiReserveDenyReason[]);

/** Ledger text bounds (0055 `ai_usage_ledger_text_lengths`). */
const MAX_LEN = { requestId: 128, routeKey: 200, promptTemplateId: 200, promptTemplateVersion: 64, outputSchemaId: 200, providerKey: 64, modelId: 200, providerRequestId: 256 } as const;
const MAX_EVIDENCE_REFS = 256;
const MAX_EVIDENCE_CHARS = 32_768;

function bounded(value: string | undefined, max: number): string | null {
  return value !== undefined && value.length >= 1 && value.length <= max ? value : null;
}

/** A token count the ledger accepts (a non-negative whole number), else null. */
function tokens(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function evidenceRefs(refs: readonly string[] | undefined): readonly string[] | null {
  if (refs === undefined || refs.length > MAX_EVIDENCE_REFS) return null;
  return refs.join(",").length <= MAX_EVIDENCE_CHARS ? refs : null;
}

export function ledgerTelemetry(t: AiRunTelemetry): AiUsageTelemetry {
  return {
    requestId: bounded(t.requestId, MAX_LEN.requestId),
    routeKey: bounded(t.routeKey, MAX_LEN.routeKey),
    promptTemplateId: bounded(t.promptTemplateId, MAX_LEN.promptTemplateId),
    promptTemplateVersion: bounded(t.promptTemplateVersion, MAX_LEN.promptTemplateVersion),
    outputSchemaId: bounded(t.outputSchemaId, MAX_LEN.outputSchemaId),
    providerKey: bounded(t.providerKey, MAX_LEN.providerKey),
    modelId: bounded(t.modelId, MAX_LEN.modelId),
    providerRequestId: bounded(t.providerRequestId, MAX_LEN.providerRequestId),
    evidenceRefIds: evidenceRefs(t.evidenceRefIds),
    inputTokens: tokens(t.inputTokens),
    outputTokens: tokens(t.outputTokens),
    cachedInputTokens: tokens(t.cachedInputTokens),
    tokenCountSource: t.tokenCountSource ?? null,
  };
}

/** The principal the gateway already authorized (layers 2-4), as a context for layers 1 and 6. */
function authorizedContext(input: AiPolicyInput): ResolvedContext {
  return {
    userId: input.userId,
    tenantId: input.tenantId,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    storeAccess: { kind: "all" },
  };
}

function entitlementReason(reason: AiCheckDenyReason): AiEntitlementDenyReason {
  return ENTITLEMENT_REASONS.has(reason) ? (reason as AiEntitlementDenyReason) : "entitlement_unavailable";
}

function reserveReason(reason: AiCheckDenyReason): AiReserveDenyReason {
  return RESERVE_REASONS.has(reason) ? (reason as AiReserveDenyReason) : "entitlement_unavailable";
}

@Injectable()
export class AiGatewayEntitlementPort implements AiEntitlementPort {
  constructor(private readonly checker: AiEntitlementChecker) {}

  get reservationTtlMs(): number {
    return this.checker.reservationTtlSeconds * 1000;
  }

  async check(input: AiPolicyInput): Promise<AiEntitlementDecision> {
    const r = await this.checker.evaluate(authorizedContext(input), input.featureId, input.storeIds);
    return r.allowed ? { allowed: true } : { allowed: false, reason: entitlementReason(r.reason) };
  }

  async reserve(input: AiReserveInput): Promise<AiReservation> {
    const outcome = await this.checker.check(
      input.ctx,
      { featureId: input.featureId, targetStores: [...input.storeIds], unitsEstimate: input.units, idempotencyKey: input.idempotencyKey },
      { requestId: bounded(input.correlationId, MAX_LEN.requestId) },
    );
    const d = outcome.decision;
    if (d.decision === "deny") return { allowed: false, reason: reserveReason(d.reasonCode) };
    return { allowed: true, reservationId: d.reservationId, entitlementVersion: d.entitlementVersion, runnable: outcome.replay === null };
  }

  async settle(settlement: AiUsageSettlement): Promise<void> {
    const r = await this.checker.settle({
      tenantId: settlement.tenantId,
      reservationId: settlement.reservationId,
      outcome: settlement.outcome,
      telemetry: ledgerTelemetry(settlement.telemetry),
    });
    if (r === null) throw new Error("AI usage reservation not found");
  }
}
