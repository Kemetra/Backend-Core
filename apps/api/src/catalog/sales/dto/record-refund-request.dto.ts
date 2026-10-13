/**
 * record-refund-request.dto.ts — 008 US4 (T058).
 *
 * Strict Zod schema for the `recordRefund` request body, mirroring
 * `RecordRefundRequest` in `packages/contracts/openapi/pos-sales/sales.yaml`.
 *
 * Records ONLY the POS-reported refund amount — no tender / payment data
 * (gate A.5, deferred to 010). `refundedAt` / tenant / store / actor resolve
 * server-side and are rejected if body-supplied (FR-061). The refund's own
 * `(sourceSystem, externalId)` pair is the dedup key (FR-013). Money is an
 * exact-decimal STRING (gate A.6 — no float).
 */
import { z } from "zod";

// A refund amount is non-negative (the DB enforces `pos_refund_amount >= 0`);
// reject a leading `-` at the boundary so it fails as a 400 validation error,
// not a 500 DB CHECK violation.
const decimalAmount = z
  .string()
  .regex(
    /^\d{1,15}(\.\d{1,4})?$/,
    "must be a non-negative exact-decimal string",
  );

const currencyCode = z.string().regex(/^[A-Z]{3}$/, "must be an ISO-4217 code");

export const RecordRefundRequestSchema = z
  .object({
    sourceSystem: z.string().min(1).max(100),
    externalId: z.string().min(1).max(200),
    posRefundAmount: decimalAmount,
    currencyCode,
  })
  .strict();

export type RecordRefundRequestDto = z.infer<typeof RecordRefundRequestSchema>;
