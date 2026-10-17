/**
 * CreditSaleReversalRequest — Zod mirror of `pos-sales/sales.yaml`
 * `CreditSaleReversalRequest` (Jira RT-577; owner rulings D6 / D8). Strict:
 * tenant / store / actor / role / timestamps / every amount except the refund
 * tenders are server-owned and rejected (FR-061).
 *
 * The cross-field rules the contract states with if/then/else, each a 400:
 *   - `kind: return` requires `lines`, forbids `businessDate`, and its refund
 *     tenders are cash only (`RefundTender`);
 *   - `kind: void` forbids `lines`; its refund tenders may mirror a card tender
 *     (`CreditReversalRefundTender`, D8);
 *   - a cash tender never carries a `reference`.
 * `approval` (RT-530 shape) and a void's `businessDate` stay OPTIONAL in shape:
 * a missing one is the service's contract refusal, not a 400.
 */
import { z } from "zod";

import { ReturnLineRequestSchema } from "./record-return-request.dto";
import { VoidApprovalSchema } from "./record-void-request.dto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT_RE = /^\d{1,15}(\.\d{1,4})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * At least one non-whitespace character and no NUL anywhere (the contract
 * `reason` pattern), checked as two linear tests rather than one backtracking
 * regular expression.
 */
const isReason = (v: string): boolean => !v.includes("\u0000") && /\S/u.test(v);

const isCalendarDay = (v: string): boolean => {
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export const CreditReversalRefundTenderSchema = z
  .object({
    method: z.enum(["cash", "card_external"]),
    amount: z.string().regex(AMOUNT_RE, "must be a non-negative exact-decimal string"),
    tenderRef: z.string().regex(UUID_RE, "must be a uuid").optional(),
    reference: z.string().regex(/^[A-Z0-9]{1,6}$/).optional(),
  })
  .strict()
  .refine((t) => t.method !== "cash" || t.reference === undefined, "a cash refund carries no reference");

export const CreditSaleReversalRequestSchema = z
  .object({
    sourceSystem: z.string().min(1).max(100),
    externalId: z.string().min(1).max(200),
    kind: z.enum(["void", "return"]),
    lines: z
      .array(ReturnLineRequestSchema)
      .min(1)
      .refine(
        (lines) => new Set(lines.map((l) => l.lineRef.toLowerCase())).size === lines.length,
        "each lineRef may appear at most once",
      )
      .optional(),
    refundTenders: z.array(CreditReversalRefundTenderSchema),
    reason: z.string().min(1).max(500).refine(isReason, "must hold a non-whitespace character and no NUL"),
    businessDate: z.string().regex(DATE_RE).refine(isCalendarDay).optional(),
    approval: VoidApprovalSchema.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.kind === "return") {
      if (body.lines === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "a return names its lines" });
      if (body.businessDate !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["businessDate"], message: "only a void carries a businessDate" });
      }
      body.refundTenders.forEach((t, i) => {
        if (t.method !== "cash" || t.tenderRef !== undefined || t.reference !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refundTenders", i], message: "a return refunds in cash only" });
        }
      });
    } else if (body.lines !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "a void names no lines" });
    }
  });

export type CreditSaleReversalRequestDto = z.infer<typeof CreditSaleReversalRequestSchema>;
export type CreditReversalRefundTenderDto = z.infer<typeof CreditReversalRefundTenderSchema>;
