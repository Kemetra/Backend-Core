/**
 * apply-payment-request.dto.ts — 035 T031.
 *
 * Strict Zod schema for the `consoleApplyPayment` body
 * (contract `PaymentApplicationCreate`): { amount, version, note? }.
 * `additionalProperties:false` ⇒ `.strict()` (smuggled fields → 400). The path
 * `receivableRef` is validated separately by the controller. `tenant_id` /
 * `store_id` / actor are server-resolved, never in the body (§XII).
 */
import { z } from "zod";
import { maxCodePoints, wellFormedText } from "../../common/text-validation";

/**
 * Exact-decimal money string (no floats, §III) — up to 4 fractional digits.
 * STRICTLY POSITIVE: an apply of 0 / 0.0000 is a meaningless no-op whose ledger
 * INSERT the DB CHECK `payment_application_amount_positive (applied_amount > 0)`
 * rejects. Guarding here turns that into a clean 400 validation_error instead of
 * an uncaught 23514 → 500 (#580). Mirrors `owedAmount`'s `>0` refine; the sibling
 * `remittedAmount` deliberately allows 0 (a full-rejection remittance is valid).
 */
const PositiveMoneyString = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, "amount must be an exact-decimal money string")
  .refine((v) => Number(v) > 0, "amount must be greater than zero");

export const ApplyPaymentRequestSchema = z
  .object({
    amount: PositiveMoneyString,
    version: z.number().int().min(0),
    note: z.string().superRefine(wellFormedText).superRefine(maxCodePoints(500)).nullish(),
  })
  .strict();

export type ApplyPaymentRequestDto = z.infer<typeof ApplyPaymentRequestSchema>;
