/**
 * Approver-eligibility DTOs (RT-788, RT-114 MA-BC2).
 *
 * Source of truth: `packages/contracts/openapi/pos-approvers.openapi.yaml`.
 *
 *   - The body is `.strict()` (= `additionalProperties: false`), so any scope
 *     field (`tenant_id`, `branch_id`, `store_id`, `terminal_id`,
 *     `device_id`) or other unknown field is a 400. Scope comes from the
 *     authenticated device row only (Constitution §II, §XII).
 *   - `user_ids`: 1 to 50 UUIDs, distinct as UUIDs. `uniqueItems` compares raw
 *     strings, so two spellings of one UUID (letter case) are caught here and
 *     answered 400 (`ApproverUserId`). A `urn:uuid:` prefix is not a UUID to
 *     Zod, so it is a 400 too (the contract allows rejecting it).
 */
import { z } from "zod";

/** The most ids one request may carry. */
export const MAX_APPROVER_USER_IDS = 50;

const ApproverUserId = z.string().uuid();

export const ApproverEligibilityRequestSchema = z
  .object({
    user_ids: z
      .array(ApproverUserId)
      .min(1)
      .max(MAX_APPROVER_USER_IDS)
      .superRefine((ids, ctx) => {
        const seen = new Set<string>();
        ids.forEach((id, index) => {
          const key = id.toLowerCase();
          if (seen.has(key)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "duplicate user id" });
          }
          seen.add(key);
        });
      }),
  })
  .strict();

export type ApproverEligibilityRequestInput = z.infer<typeof ApproverEligibilityRequestSchema>;

/**
 * `PosApproverEligibilityResult` — minimum disclosure. `action_kinds` is
 * reserved and omitted in `1.0.0-draft`.
 */
export interface ApproverEligibilityResult {
  readonly user_id: string;
  readonly eligible: boolean;
}

/** `PosApproverEligibilityResponse`. */
export interface ApproverEligibilityResponseBody {
  readonly results: ApproverEligibilityResult[];
}
