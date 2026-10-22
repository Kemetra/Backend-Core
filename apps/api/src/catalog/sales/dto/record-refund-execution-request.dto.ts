/**
 * RecordRefundExecutionRequest — Zod mirror of `pos-sales/sales.yaml`
 * `RecordRefundExecutionRequest` (Jira RT-787; RT-490, RT-271 R-3/R-4).
 * Strict: the instrument, currency, `recordedAt`, tenant, store and actor are
 * server-owned and rejected if body-supplied (FR-061).
 */
import { z } from "zod";
import { hasNoNul, NO_NUL_MESSAGE } from "../../../common/text-validation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuid = z.string().regex(UUID_RE, "must be a uuid");

/** `PositiveDecimalAmount`: numeric(19,4), no sign, zero rejected. */
const positiveAmount = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, "must be a non-negative exact-decimal string")
  .refine((v) => /[1-9]/.test(v), "amount must be greater than zero");

export const RefundExecutionEvidenceSchema = z
  .object({
    method: z.enum(["drawer", "manual"]),
    // No lower bound (an offline payout is reported later), but within the
    // range Postgres stores: year 1 or later, so a fuzzed date is a 400, never a 500.
    paidAt: z
      .string()
      .datetime({ offset: true })
      .refine((v) => new Date(v).getUTCFullYear() >= 1, "paidAt is out of range"),
    shiftRef: uuid,
  })
  .strict();

export const RecordRefundExecutionRequestSchema = z
  .object({
    sourceSystem: z.string().min(1).max(100).refine(hasNoNul, NO_NUL_MESSAGE),
    externalId: z.string().min(1).max(200).refine(hasNoNul, NO_NUL_MESSAGE),
    executionRef: uuid,
    allocationRef: uuid,
    amount: positiveAmount,
    // R-4: the pilot reports settled executions only.
    outcome: z.literal("settled"),
    evidence: RefundExecutionEvidenceSchema,
  })
  .strict();

export type RecordRefundExecutionRequestDto = z.infer<typeof RecordRefundExecutionRequestSchema>;

/** `readReturnByProvenance` query (`ReturnSourceSystem` / `ReturnExternalId`). */
export const ReturnProvenanceQuerySchema = z.object({
  sourceSystem: z.string().min(1).max(100).refine(hasNoNul, NO_NUL_MESSAGE),
  externalId: z.string().min(1).max(200).refine(hasNoNul, NO_NUL_MESSAGE),
});

export type ReturnProvenanceQueryDto = z.infer<typeof ReturnProvenanceQuerySchema>;
