/**
 * Default collaborators — RT-655. Every default DENIES or yields nothing, so an
 * AiModule with no overrides can never reach a provider.
 */
import type { AiBudgetDecision, AiBudgetPort, AiEvidencePackBuilder } from "./ai-gateway.types";
import type { EvidencePack } from "../ports/model-provider.port";

/**
 * Fail-closed budget (the internal spend cap and the platform free-credit
 * pool, layer 7). Neither is sized yet (RT-645) and no store holds them, so
 * the budget state is unknown, and AD-AI-ENT-001 D-3 says unknown means deny.
 * The quota itself is the entitlement port's reservation (RT-664).
 */
export class FailClosedAiBudget implements AiBudgetPort {
  check(): Promise<AiBudgetDecision> {
    return Promise.resolve({ allowed: false, reason: "entitlement_unavailable" });
  }
}

/** No evidence builder is registered yet (RT-647); an empty pack means no request. */
export class EmptyEvidencePackBuilder implements AiEvidencePackBuilder {
  build(): Promise<EvidencePack> {
    return Promise.resolve({ items: [] });
  }
}
