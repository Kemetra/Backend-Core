/**
 * RecordReturnRequest — Zod mirror of `pos-sales/sales.yaml`
 * `RecordReturnRequest` (Jira RT-73; RT-14 D1/D3). Strict: tenant / store /
 * actor / timestamps / amounts per line are server-owned and rejected.
 */
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const quantity = z
  .string()
  .regex(/^[0-9]{1,13}(\.[0-9]{1,6})?$/, "must be a non-negative decimal string")
  .refine((v) => /[1-9]/.test(v), "quantity must be greater than zero");

const amount = z
  .string()
  .regex(/^[0-9]{1,15}(\.[0-9]{1,4})?$/, "must be a non-negative exact-decimal string");

export const ReturnLineRequestSchema = z
  .object({
    lineRef: z.string().regex(UUID_RE, "must be a uuid"),
    quantity,
  })
  .strict();

export const RefundTenderSchema = z
  .object({
    method: z.literal("cash"),
    amount,
  })
  .strict();

export const RecordReturnRequestSchema = z
  .object({
    sourceSystem: z.string().min(1).max(100),
    externalId: z.string().min(1).max(200),
    lines: z
      .array(ReturnLineRequestSchema)
      .min(1)
      .refine(
        (lines) => new Set(lines.map((l) => l.lineRef.toLowerCase())).size === lines.length,
        "each lineRef may appear at most once",
      ),
    refundTenders: z.array(RefundTenderSchema).min(1),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

export type RecordReturnRequestDto = z.infer<typeof RecordReturnRequestSchema>;
