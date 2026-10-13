/**
 * Inventory effect integration-state machine — Jira RT-426 (RT-289 G2-3).
 *
 * PURE: no I/O. Decides how one effect's integration state answers one ERP
 * posting signal. The writer (`effect-integration.transitions.ts`) applies the
 * decision to `inventory_effect_integration` rows; the effect itself (a
 * `stock_movements` row) is never inserted, updated or deleted by a transition
 * (771, 899, DC-3).
 *
 * Transitions (RT-289 §2.3, DC-3, DC-5):
 *
 *   signal                    from                       to
 *   ------------------------  -------------------------  -----------------------
 *   posted                    pending                    confirmed
 *   failed_transient          pending                    pending (stays)
 *   permanently_rejected      pending                    rejected
 *     (incl. retry budget exhausted)
 *   reconciliation_required   pending                    reconciliation_required
 *     (incl. a stale-resolution post)
 *   reconciliation_required   rejected                   reconciliation_required
 *     (RT-332: a dead-lettered intent upgraded once an ERP document is known)
 *   repair_re_post            rejected                   pending
 *
 * A signal that finds the effect already in the state it would move to is a
 * no-op (the O-3 duplicate-ack echo; a concurrent repair). Every other pairing
 * is illegal and refused: confirmed is final under a different outcome (the
 * stored document wins, O-3), reconciliation_required is never re-offered
 * (RT-332), and not_posted / external / erp_neutral carry no ERP intent, so no
 * posting signal can reach them.
 */
import type { InventoryIntegrationState } from "@data-pulse-2/db";

/** An ERP posting outcome, or the operator repair, as seen by the effects it represents. */
export type PostingSignal =
  | "posted"
  | "failed_transient"
  | "permanently_rejected"
  | "reconciliation_required"
  | "repair_re_post";

export type TransitionDecision =
  | { readonly kind: "move"; readonly to: InventoryIntegrationState }
  | { readonly kind: "no_op" }
  | { readonly kind: "illegal" };

interface SignalRule {
  /** The state the signal moves an effect to. */
  readonly to: InventoryIntegrationState;
  /** The states the signal may move an effect out of. */
  readonly from: readonly InventoryIntegrationState[];
}

const RULES: Readonly<Record<PostingSignal, SignalRule>> = {
  posted: { to: "confirmed", from: ["pending"] },
  failed_transient: { to: "pending", from: [] },
  permanently_rejected: { to: "rejected", from: ["pending"] },
  reconciliation_required: { to: "reconciliation_required", from: ["pending", "rejected"] },
  repair_re_post: { to: "pending", from: ["rejected"] },
};

/** How an effect in `current` answers `signal`. */
export function decideTransition(
  current: InventoryIntegrationState,
  signal: PostingSignal,
): TransitionDecision {
  const rule = RULES[signal];
  if (current === rule.to) return { kind: "no_op" };
  if (rule.from.includes(current)) return { kind: "move", to: rule.to };
  return { kind: "illegal" };
}

/**
 * A posting signal reached an effect whose integration state cannot answer it
 * (e.g. a `posted` ack for an effect already `rejected`). The posting row and
 * its effects would disagree, so the whole transaction is refused rather than
 * leaving them out of step.
 */
export class IllegalIntegrationTransitionError extends Error {
  constructor(
    readonly from: InventoryIntegrationState,
    readonly signal: PostingSignal,
  ) {
    super(`illegal inventory effect integration transition: ${from} on ${signal}`);
    this.name = "IllegalIntegrationTransitionError";
  }
}
