/**
 * outcome-ack.dto.ts — Zod body schema for `connectorAckOutcome`.
 *
 * Mirrors the 012 `OutcomeAckRequest` (strict, O-2):
 *   - `outcome`: posted | failed_transient | permanently_rejected |
 *     reconciliation_required (required; RT-332);
 *   - `documentRef` ({doctype,name}) — REQUIRED iff outcome is posted or
 *     reconciliation_required (the EXISTING document), else absent;
 *   - `reason` ({category,message}) — REQUIRED iff outcome is
 *     permanently_rejected or reconciliation_required;
 *   - `resolutionVersion` — optional echo of the work item's frozen resolution
 *     version (RT-332); a positive integer;
 *   - `etaStatus` accepted + ignored in the interim mode (016 owns it).
 *
 * `.strict()` rejects unknown keys AND any body-supplied tenant/store/actor or
 * server-owned field (§XII mass-assignment ban) → 400 validation_error.
 * Tenant/scope come from the connectorBearer principal, never the body.
 *
 * The conditional-required coupling is enforced via `superRefine`: a `posted`
 * without `documentRef`, or a `permanently_rejected` without `reason`, is a 400
 * (the 012 ValidationFailure: "a missing conditional field").
 */
import { z } from "zod";

const DocumentRefSchema = z
  .object({
    doctype: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
  })
  .strict();

const RejectionReasonSchema = z
  .object({
    category: z.enum([
      "validation",
      "closed_period",
      "unmapped_item",
      "unmapped_account",
      "other",
    ]),
    message: z.string().min(1).max(1000),
  })
  .strict();

const EtaStatusSchema = z
  .object({
    state: z.enum(["submitted", "accepted", "rejected", "pending"]),
    uuid: z.string().min(1).nullish(),
  })
  .strict();

export const OutcomeAckBodySchema = z
  .object({
    outcome: z.enum([
      "posted",
      "failed_transient",
      "permanently_rejected",
      "reconciliation_required",
    ]),
    documentRef: DocumentRefSchema.nullish(),
    reason: RejectionReasonSchema.nullish(),
    etaStatus: EtaStatusSchema.nullish(),
    resolutionVersion: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const needsDocument =
      val.outcome === "posted" || val.outcome === "reconciliation_required";
    const needsReason =
      val.outcome === "permanently_rejected" ||
      val.outcome === "reconciliation_required";
    if (needsDocument && !val.documentRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documentRef"],
        message: `documentRef is required when outcome is '${val.outcome}'`,
      });
    }
    if (needsReason && !val.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: `reason is required when outcome is '${val.outcome}'`,
      });
    }
    if (!needsDocument && val.documentRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documentRef"],
        message: "documentRef is only valid when outcome is 'posted' or 'reconciliation_required'",
      });
    }
    if (!needsReason && val.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message:
          "reason is only valid when outcome is 'permanently_rejected' or 'reconciliation_required'",
      });
    }
  });

export type OutcomeAckBody = z.infer<typeof OutcomeAckBodySchema>;
