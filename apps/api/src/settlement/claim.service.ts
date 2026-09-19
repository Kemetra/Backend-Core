/**
 * ClaimService — 035 T032.
 *
 * Claim submission + remittance reconciliation (FR-014), the Console third-party
 * collection surface. Mirrors ReceivableService: one `runWithTenantContext` tx
 * per op, discriminated-union results (service never throws HttpException), the
 * controller maps to HTTP.
 *
 * submitClaim: validates the payer + every receivable is in-scope AND claimable
 * (open | partially_applied), creates `claim` + `claim_receivables`, transitions
 * the receivables → 'claimed'. All-or-nothing.
 *
 * reconcileRemittance: the claim must be reconcilable (status submitted |
 * acknowledged — NOT already reconciled). The claimed amount is the SUM of the
 * claimed receivables' current outstanding balances. The pure `decideReconciliation`
 * computes variance + outcome; we record a `remittance` + `reconciliation_result`,
 * settle (outcome settled) / flag (outcome flagged) the receivables, and mark the
 * claim 'reconciled'. Rejection of a line is NOT modelled here — it routes to
 * DP-026 + Connector Arc A + POS-014 (FR-015, NG-1). Idempotency is the HTTP
 * interceptor's job.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";

import { PG_POOL } from "../auth/auth.module";
import { recordSettlementReceivable } from "../observability/metrics/api.metrics";
import { decideReconciliation } from "./reconcile-decision";
import { insertSettlementAudit } from "./transactional-audit";
import type {
  ClaimBody,
  ReconciliationResultBody,
} from "./dto/claim-request.dto";

export interface SubmitClaimInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly payerRef: string;
  readonly receivableRefs: readonly string[];
}

export type SubmitClaimResult =
  | { kind: "ok"; claim: ClaimBody }
  | { kind: "not_found" }
  | { kind: "conflict" };

export interface ReconcileInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly claimRef: string;
  readonly remittedAmount: string;
  readonly remittanceRef?: string | null;
}

export type ReconcileResult =
  | { kind: "ok"; result: ReconciliationResultBody }
  | { kind: "not_found" }
  | { kind: "conflict" };

const CLAIMABLE_STATES = ["open", "partially_applied"];

// Exact-decimal money (§III, no floats): integer ten-thousandths (scale 4),
// matching apply-payment-decision / reconcile-decision.
const SCALE = 4;
function toScaledInt(money: string): bigint {
  const [whole = "0", frac = ""] = money.split(".");
  const fracPadded = (frac + "0".repeat(SCALE)).slice(0, SCALE);
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fracPadded || "0");
}
function fromScaledInt(v: bigint): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const unit = 10n ** BigInt(SCALE);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(SCALE, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}
/** Sum scale-4 money strings exactly, returning a scale-4 string. */
function sumScaled(amounts: readonly string[]): string {
  let total = 0n;
  for (const a of amounts) total += toScaledInt(a);
  return fromScaledInt(total);
}

@Injectable()
export class ClaimService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async submitClaim(input: SubmitClaimInput): Promise<SubmitClaimResult> {
    const result = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<SubmitClaimResult> => {
        // Payer must resolve in tenant (RLS-filtered) → else non-disclosing 404.
        const payer = await client.query<{ store_id: string | null }>(
          `SELECT store_id FROM payer_account WHERE id = $1::uuid LIMIT 1`,
          [input.payerRef],
        );
        if (!payer.rows[0]) return { kind: "not_found" };

        // Lock + validate every receivable: in-scope, claimable state. A missing
        // one (RLS / fabricated) or a non-claimable one is a deterministic
        // conflict (the batch is all-or-nothing; no partial claim).
        const refs = [...new Set(input.receivableRefs)];
        const found = await client.query<{
          id: string;
          state: string;
          store_id: string;
          payer_id: string;
        }>(
          `SELECT id, state, store_id, payer_id FROM receivable
            WHERE id = ANY($1::uuid[]) FOR UPDATE`,
          [refs],
        );
        if (found.rows.length !== refs.length) return { kind: "conflict" };
        if (found.rows.some((r) => !CLAIMABLE_STATES.includes(r.state))) {
          return { kind: "conflict" };
        }
        // Every claimed receivable MUST be owed by the claim's payer — else the
        // claim would record payer X over payer Y's debt, and reconciliation
        // could settle the wrong payer's balance (Codex #581 P2). Reject mismatch.
        if (found.rows.some((r) => r.payer_id !== input.payerRef)) {
          return { kind: "conflict" };
        }
        // The claim is store-scoped to the receivables' store (they must agree).
        const storeIds = new Set(found.rows.map((r) => r.store_id));
        if (storeIds.size !== 1) return { kind: "conflict" };
        const storeId = [...storeIds][0]!;

        // Create the claim + join rows; transition the receivables → 'claimed'.
        const claimId = newId();
        await client.query(
          `INSERT INTO claim (id, tenant_id, store_id, payer_id, status, version)
           VALUES ($1, $2, $3, $4, 'submitted', 0)`,
          [claimId, input.tenantId, storeId, input.payerRef],
        );
        for (const ref of refs) {
          await client.query(
            `INSERT INTO claim_receivables
               (id, tenant_id, store_id, claim_id, receivable_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [newId(), input.tenantId, storeId, claimId, ref],
          );
        }
        await client.query(
          `UPDATE receivable SET state = 'claimed', version = version + 1,
                  updated_at = now()
            WHERE id = ANY($1::uuid[])`,
          [refs],
        );

        await insertSettlementAudit(client, {
          tenantId: input.tenantId,
          storeId,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          action: "settlement.claim.submitted",
          targetType: "claim",
          targetId: claimId,
          metadata: { receivable_ids: refs },
        });

        return {
          kind: "ok",
          claim: {
            claimRef: claimId,
            payerRef: input.payerRef,
            status: "submitted",
            receivableRefs: refs,
          },
        };
      },
    );
    // Post-commit signal — one increment per submitted claim (035 §7).
    if (result.kind === "ok") recordSettlementReceivable();
    return result;
  }

  async reconcileRemittance(input: ReconcileInput): Promise<ReconcileResult> {
    const result = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ReconcileResult> => {
        const claim = await client.query<{ status: string; store_id: string }>(
          `SELECT status, store_id FROM claim WHERE id = $1::uuid FOR UPDATE`,
          [input.claimRef],
        );
        const c = claim.rows[0];
        if (!c) return { kind: "not_found" };
        // Reconcilable only while submitted | acknowledged (not already reconciled).
        if (c.status === "reconciled") return { kind: "conflict" };

        // Lock the claim's receivables. Every line MUST still be in 'claimed'
        // state — if one was transitioned out (settled/flagged) since submit,
        // reconciling would touch a balance that already moved (Codex #581 P2):
        // a no-side-effect 409. Ordered by id for deterministic FIFO apportioning.
        const lines = await client.query<{
          id: string;
          state: string;
          outstanding_balance: string;
        }>(
          `SELECT r.id, r.state, r.outstanding_balance
             FROM claim_receivables cr
             JOIN receivable r ON r.id = cr.receivable_id
            WHERE cr.claim_id = $1::uuid
            ORDER BY r.id
              FOR UPDATE OF r`,
          [input.claimRef],
        );
        if (lines.rows.length === 0) return { kind: "conflict" };
        if (lines.rows.some((r) => r.state !== "claimed")) {
          return { kind: "conflict" };
        }

        const claimed = sumScaled(lines.rows.map((r) => r.outstanding_balance));
        const decision = decideReconciliation({
          claimedAmount: claimed,
          remittedAmount: input.remittedAmount,
        });

        // Record the remittance + the reconciliation result.
        await client.query(
          `INSERT INTO remittance
             (id, tenant_id, store_id, claim_id, remitted_amount, remittance_ref)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            newId(),
            input.tenantId,
            c.store_id,
            input.claimRef,
            input.remittedAmount,
            input.remittanceRef ?? null,
          ],
        );
        await client.query(
          `INSERT INTO reconciliation_result
             (id, tenant_id, store_id, claim_id, claimed_amount,
              remitted_amount, variance, outcome)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            newId(),
            input.tenantId,
            c.store_id,
            input.claimRef,
            claimed,
            input.remittedAmount,
            decision.variance,
            decision.outcome,
          ],
        );

        // Apply the remittance to the receivable BALANCES (Codex #581 P1 — the
        // money must move, not only the state):
        //   - settled  (remitted == claimed): debt cleared → balance 0, settled.
        //   - flagged  (remitted >  claimed): over-remittance, debt fully paid →
        //                balance 0, flagged (the variance anomaly is recorded).
        //   - partial  (remitted <  claimed): FIFO-apply `remitted` across the
        //                lines (by id); each line drops by min(remaining, balance);
        //                lines stay 'claimed' (still owed) with reduced balances.
        if (decision.outcome === "settled" || decision.outcome === "flagged") {
          const nextState = decision.outcome === "settled" ? "settled" : "flagged";
          for (const line of lines.rows) {
            await client.query(
              `UPDATE receivable SET outstanding_balance = 0, state = $2,
                      version = version + 1, updated_at = now()
                WHERE id = $1::uuid`,
              [line.id, nextState],
            );
          }
        } else {
          // partial — FIFO apportion the remitted amount across the claimed lines.
          let remaining = toScaledInt(input.remittedAmount);
          for (const line of lines.rows) {
            if (remaining <= 0n) break;
            const balance = toScaledInt(line.outstanding_balance);
            const applied = remaining < balance ? remaining : balance;
            if (applied <= 0n) continue;
            const newBalance = balance - applied;
            remaining -= applied;
            await client.query(
              `UPDATE receivable SET outstanding_balance = $2,
                      version = version + 1, updated_at = now()
                WHERE id = $1::uuid`,
              [line.id, fromScaledInt(newBalance)],
            );
          }
        }
        await client.query(
          `UPDATE claim SET status = 'reconciled', version = version + 1,
                  updated_at = now()
            WHERE id = $1::uuid`,
          [input.claimRef],
        );

        await insertSettlementAudit(client, {
          tenantId: input.tenantId,
          storeId: c.store_id,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          action: "settlement.remittance.reconciled",
          targetType: "claim",
          targetId: input.claimRef,
          metadata: {
            remitted_amount: input.remittedAmount,
            variance: decision.variance,
            outcome: decision.outcome,
          },
        });

        return {
          kind: "ok",
          result: {
            claimRef: input.claimRef,
            claimedAmount: claimed,
            remittedAmount: input.remittedAmount,
            variance: decision.variance,
            outcome: decision.outcome,
          },
        };
      },
    );
    // Post-commit signal — one increment per reconciled remittance (035 §7).
    if (result.kind === "ok") recordSettlementReceivable();
    return result;
  }
}
