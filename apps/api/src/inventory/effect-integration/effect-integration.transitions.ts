/**
 * Inventory effect integration transitions — Jira RT-426 (RT-289 G2-3).
 *
 * Applies one ERP posting signal to every Inventory Effect the posting intent
 * represents (`inventory_effect_integration.posting_status_id`). Runs on the
 * caller's client, so it commits or rolls back WITH the posting-status update
 * that produced the signal. RLS scopes the rows to the caller's tenant GUC.
 *
 * Only `inventory_effect_integration` is written. The effects (`stock_movements`)
 * are never read for update, inserted, edited or deleted (771, 899, DC-3/DC-5):
 * an ERP outcome changes integration state, never quantity.
 *
 * Effects with no ERP intent (not_posted, external, erp_neutral) carry no
 * `posting_status_id` (CHECK inventory_effect_integration_intent_link), so no
 * signal reaches them. An intent with no linked effects (every intent until
 * sale effects activate, RT-427) is a no-op.
 */
import type { InventoryIntegrationState } from "@data-pulse-2/db";
import type { PoolClient } from "pg";

import {
  decideTransition,
  IllegalIntegrationTransitionError,
  type PostingSignal,
} from "./integration-state-machine";

export interface PostingSignalInput {
  /** The `erpnext_posting_status` row (work item) the signal is about. */
  readonly postingStatusId: string;
  readonly signal: PostingSignal;
  /**
   * The ERPNext document {doctype, name} JSON text: the confirming document on
   * `posted`, the mismatching evidence on `reconciliation_required` (or null).
   */
  readonly erpDocumentRef?: string | null;
  /** `posted` only: the intent's `posted_at` (G2-4, RT-289 Q6). */
  readonly erpConfirmedAt?: Date;
  /** Bounded machine note (no PII): the rejection category, the repair kind. */
  readonly stateReason?: string | null;
}

/** The fields a transition into `to` writes, beyond the state itself. */
interface TargetFields {
  readonly erpDocumentRef: string | null;
  readonly erpConfirmedAt: Date | null;
  readonly stateReason: string | null;
}

/**
 * Move every effect linked to the posting intent. Refuses the whole signal
 * (throws, so the caller's transaction rolls back) when any linked effect is in
 * a state the signal cannot move. Returns the number of effects moved.
 */
export async function applyPostingSignalToEffects(
  client: PoolClient,
  input: PostingSignalInput,
): Promise<number> {
  // FOR UPDATE: the caller already holds the posting row's lock, which
  // serializes signals for one intent; locking the integration rows too keeps
  // a future writer outside that path from interleaving.
  const linked = await client.query<{ effect_id: string; state: InventoryIntegrationState }>(
    `SELECT effect_id, state
       FROM inventory_effect_integration
      WHERE posting_status_id = $1
      FOR UPDATE`,
    [input.postingStatusId],
  );

  const moving: string[] = [];
  let target: InventoryIntegrationState | null = null;
  for (const row of linked.rows) {
    const decision = decideTransition(row.state, input.signal);
    if (decision.kind === "illegal") {
      throw new IllegalIntegrationTransitionError(row.state, input.signal);
    }
    if (decision.kind === "move") {
      moving.push(row.effect_id);
      target = decision.to;
    }
  }
  if (target === null) return 0;

  const fields = targetFields(target, input);
  const r = await client.query(
    `UPDATE inventory_effect_integration
        SET state = $2, erp_document_ref = $3, erp_confirmed_at = $4,
            state_reason = $5, updated_at = now()
      WHERE effect_id = ANY($1::uuid[])`,
    [moving, target, fields.erpDocumentRef, fields.erpConfirmedAt, fields.stateReason],
  );
  return r.rowCount ?? 0;
}

/**
 * confirmed carries the confirming document and time; reconciliation_required
 * keeps the mismatching document as evidence; pending and rejected carry none.
 */
function targetFields(to: InventoryIntegrationState, input: PostingSignalInput): TargetFields {
  const stateReason = input.stateReason ?? null;
  if (to === "confirmed") {
    if (!input.erpDocumentRef || !input.erpConfirmedAt) {
      throw new Error("a posted signal needs the ERP document and confirmation time");
    }
    return { erpDocumentRef: input.erpDocumentRef, erpConfirmedAt: input.erpConfirmedAt, stateReason };
  }
  if (to === "reconciliation_required") {
    return { erpDocumentRef: input.erpDocumentRef ?? null, erpConfirmedAt: null, stateReason };
  }
  return { erpDocumentRef: null, erpConfirmedAt: null, stateReason };
}
