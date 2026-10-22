/**
 * RecordReturnRequest — Zod mirror of `pos-sales/sales.yaml`
 * `RecordReturnRequest` (Jira RT-73; RT-14 D1/D3). Strict: tenant / store /
 * actor / timestamps / amounts per line are server-owned and rejected.
 */
import { z } from "zod";
import { hasNoNul, NO_NUL_MESSAGE } from "../../../common/text-validation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const quantity = z
  .string()
  .regex(/^\d{1,13}(\.\d{1,6})?$/, "must be a non-negative decimal string")
  .refine((v) => /[1-9]/.test(v), "quantity must be greater than zero");

const amount = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, "must be a non-negative exact-decimal string");

export const ReturnLineRequestSchema = z
  .object({
    lineRef: z.string().regex(UUID_RE, "must be a uuid"),
    quantity,
  })
  .strict();

/**
 * One refund ALLOCATION (RT-271 R-2; RT-490). The three RT-490 fields are
 * optional and part of the return's payload (R-3): an absent `instrument`
 * means cash but hashes differently.
 */
export const RefundTenderSchema = z
  .object({
    method: z.literal("cash"),
    amount,
    allocationRef: z.string().regex(UUID_RE, "must be a uuid").optional(),
    originalTenderRef: z.string().regex(UUID_RE, "must be a uuid").optional(),
    instrument: z.literal("cash").optional(),
  })
  .strict();

type RefundTenderInput = z.infer<typeof RefundTenderSchema>;

/** RT-490 allocation rule 1: `allocationRef` on every allocation or none, each at most once. */
function allocationRefsConsistent(tenders: ReadonlyArray<RefundTenderInput>): boolean {
  const refs = tenders.flatMap((t) => (t.allocationRef === undefined ? [] : [t.allocationRef.toLowerCase()]));
  if (refs.length === 0) return true;
  return refs.length === tenders.length && new Set(refs).size === refs.length;
}

export const RecordReturnRequestSchema = z
  .object({
    sourceSystem: z.string().min(1).max(100).refine(hasNoNul, NO_NUL_MESSAGE),
    externalId: z.string().min(1).max(200).refine(hasNoNul, NO_NUL_MESSAGE),
    lines: z
      .array(ReturnLineRequestSchema)
      .min(1)
      .refine(
        (lines) => new Set(lines.map((l) => l.lineRef.toLowerCase())).size === lines.length,
        "each lineRef may appear at most once",
      ),
    refundTenders: z
      .array(RefundTenderSchema)
      .min(1)
      .refine(
        allocationRefsConsistent,
        "allocationRef must be on every allocation or none, and unique within the return",
      ),
    reason: z.string().min(1).max(500).refine(hasNoNul, NO_NUL_MESSAGE).optional(),
  })
  .strict();

export type RecordReturnRequestDto = z.infer<typeof RecordReturnRequestSchema>;
