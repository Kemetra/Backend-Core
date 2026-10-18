/**
 * record-void-request.dto.ts — 008 US3 (T053); RT-530 approval evidence.
 *
 * Strict Zod schema for the `recordVoid` request body, mirroring
 * `RecordVoidRequest` in `packages/contracts/openapi/pos-sales/sales.yaml`.
 *
 * `.strict()` enforces the FR-061 mass-assignment ban: `voidedAt` / tenant /
 * store / actor resolve server-side and are NOT accepted from the body. The
 * void's own `(sourceSystem, externalId)` pair is recorded provenance + the
 * dedup key (FR-013), never body-assignable authority.
 *
 * RT-530 (additive; `[GATED]` approval: Jira RT-530 comment 11988): the body
 * also carries the bound manager-approval evidence (`approval`, modelled on
 * the RT-114 C7 approval record) and the device-side business day of the void
 * (`businessDate`). Both are OPTIONAL IN SHAPE so the strict schema stays
 * additive; the SERVICE refuses a void without them (403
 * `void_approval_required` / 422 `void_outside_business_day`), because a
 * missing approval needs its own contract code, not a generic 400.
 */
import { z } from "zod";
import { hasNoNul, NO_NUL_MESSAGE } from "../../../common/text-validation";

/** A decimal money string, compared exactly in Postgres `numeric`, never as a float. */
const AMOUNT_RE = /^\d{1,15}(\.\d{1,4})?$/;
/** A calendar day `YYYY-MM-DD`. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isCalendarDay = (v: string): boolean => {
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export const VoidApprovalSchema = z
  .object({
    /** The terminal's approval id (an RT-114 `manager_approvals.approval_id`). */
    approvalId: z.string().uuid(),
    /** The approved action; only `sale.void` binds a void. */
    action: z.string().min(1).max(100).refine(hasNoNul, NO_NUL_MESSAGE),
    /** The sale the approval was bound to: must be the path's sale. */
    saleRef: z.string().uuid(),
    /** The sale total the approval was bound to (exact decimal string). */
    amount: z.string().regex(AMOUNT_RE),
    /** The `users.id` of the operator who asked for the void. */
    requesterUserId: z.string().uuid(),
    /** The `users.id` of the manager whose PIN approved it. */
    approverUserId: z.string().uuid(),
    /** The RT-114 policy version the approval was checked against. */
    policyVersion: z.string().min(1).max(64).refine(hasNoNul, NO_NUL_MESSAGE),
    /** When the terminal recorded the approval (device clock). */
    approvedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const RecordVoidRequestSchema = z
  .object({
    sourceSystem: z.string().min(1).max(100).refine(hasNoNul, NO_NUL_MESSAGE),
    externalId: z.string().min(1).max(200).refine(hasNoNul, NO_NUL_MESSAGE),
    /** The device-side business day of the void; must equal the sale's `business_date`. */
    businessDate: z.string().regex(DATE_RE).refine(isCalendarDay).optional(),
    approval: VoidApprovalSchema.optional(),
  })
  .strict();

export type VoidApprovalDto = z.infer<typeof VoidApprovalSchema>;
export type RecordVoidRequestDto = z.infer<typeof RecordVoidRequestSchema>;
