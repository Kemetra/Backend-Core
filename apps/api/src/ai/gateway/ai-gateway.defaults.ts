/**
 * Default collaborators — RT-655. Every default DENIES or yields nothing, so an
 * AiModule with no overrides can never reach a provider.
 */
import type {
  AiBudgetDecision,
  AiBudgetPort,
  AiEntitlementDecision,
  AiEntitlementPort,
  AiEvidencePackBuilder,
} from "./ai-gateway.types";
import type { EvidencePack } from "../ports/model-provider.port";

/**
 * Deny-all entitlement stub (AD-AI-ENT-001; the RT-644 contract exists, the
 * `ai-entitlements` module does not). RT-664 replaces this binding. Until then
 * no tenant is entitled to any AI feature.
 */
export class DenyAllAiEntitlement implements AiEntitlementPort {
  async check(): Promise<AiEntitlementDecision> {
    return { allowed: false, reason: "not_entitled" };
  }
}

/**
 * Fail-closed budget stub. No usage ledger exists until RT-663, so the budget
 * state is unknown, and AD-AI-ENT-001 D-3 says unknown means deny.
 */
export class FailClosedAiBudget implements AiBudgetPort {
  async check(): Promise<AiBudgetDecision> {
    return { allowed: false, reason: "entitlement_unavailable" };
  }
}

/** No evidence builder is registered yet (RT-647); an empty pack means no request. */
export class EmptyEvidencePackBuilder implements AiEvidencePackBuilder {
  async build(): Promise<EvidencePack> {
    return { items: [] };
  }
}
