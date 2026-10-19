/**
 * RT-648 — `E1-OUT v1`, the output schema every explanation must satisfy
 * (RT-647 §5.2; gate S5). Shared by the baseline and any later model.
 *
 * Every nested object is `.strict()`: `assertStrictOutputSchema` in the gateway
 * only inspects the top level, so an invented nested field would otherwise be
 * silently stripped instead of rejected.
 */
import { z } from "zod";

import { E1_BOUNDARIES, E1_CLASSES } from "./e1.types";

export const TEMPLATE_IDS = [
  "H0", "G1", "G2", "G4", "G5", "X1", "X2",
  "A1", "A1R", "A2", "A3", "A4",
  "B1", "B2", "B3", "B4", "B5", "B7",
  "C1", "C2", "C3", "C4", "C5",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const PARAM_NAMES = [
  "saleNumber", "businessDate", "occurredAt", "currencyCode", "posTotal",
  "processedAt", "resolvedAt", "receivedAt", "reasonCode", "retryCount", "quarantinedAt",
  "saleDocumentRef", "reversalDocumentRef", "rejectionClass", "deadLetteredAt", "n",
] as const;
export type ParamName = (typeof PARAM_NAMES)[number];

export const OPEN_UNKNOWNS = [
  "erp_sale_state", "rejection_class", "erp_reversal_state", "reversal_class", "refund_reversal_state",
] as const;

export const GAP_IDS = ["S3", "S4", "S6"] as const;

const ref = z.string().min(1).max(300);
const ruleId = z.string().regex(/^[A-Za-z0-9-]{1,8}$/);

const track = <S extends [string, ...string[]]>(states: S) =>
  z.object({ state: z.enum(states), rule_id: ruleId }).strict();

export const E1_OUT_SCHEMA = z
  .object({
    schema_version: z.literal("e1-out/1"),
    pack_id: z.string().uuid(),
    class: z.enum(E1_CLASSES),
    tracks: z
      .object({
        processing: track(["captured", "synced", "failed-retryable", "failed-needs-repair", "n/a"]),
        erp_sale: z
          .object({
            state: z.enum(["posted", "pending", "failed", "unknown", "n/a"]),
            rule_id: ruleId,
            backlog_class: z.string().min(1).max(40),
          })
          .strict(),
        erp_reversal: track(["posted", "pending", "failed", "unknown", "not_voided", "n/a"]),
      })
      .strict(),
    first_failing_boundary: z.enum(E1_BOUNDARIES),
    open_unknowns: z.array(z.enum(OPEN_UNKNOWNS)),
    runbook_refs: z.array(z.string().regex(/^RB-E1-\d{2}$/)),
    claims: z.array(
      z
        .object({
          template_id: z.enum(TEMPLATE_IDS),
          params: z.record(z.enum(PARAM_NAMES), z.union([z.string().max(300), z.number().int(), z.null()])),
          evidence_refs: z.array(ref).min(1),
        })
        .strict(),
    ),
    known_gaps: z.array(z.object({ gap_id: z.enum(GAP_IDS), evidence_ref: ref }).strict()),
  })
  .strict();

export type E1Out = z.infer<typeof E1_OUT_SCHEMA>;
export type E1Claim = E1Out["claims"][number];

/** The evidence refs a validated output cites (claims and known gaps). */
export function citedRefs(out: E1Out): readonly string[] {
  return [...out.claims.flatMap((claim) => claim.evidence_refs), ...out.known_gaps.map((gap) => gap.evidence_ref)];
}
