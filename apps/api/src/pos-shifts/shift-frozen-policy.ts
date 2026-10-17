/**
 * The shift variance policy frozen with a cash-up open (RT-387; pos-shifts
 * 1.2.0-draft `FrozenPolicy` / `RecordedFrozenPolicy`, AD-CASH-001 D-6 / D-7;
 * storage `0050_shift_variance_policy`, the six `frozen_policy_*` columns).
 *
 * The POS freezes the policy it applies and sends it on the open; Backend-Core
 * records it verbatim and never refuses it on policy grounds. Only a malformed
 * `frozenPolicy` is a 400: a source / revision-id mismatch, a `limit` without
 * its amount or currency, a missing or unknown member. Its precision and its
 * currency are NOT checked here (a value finer than its currency, or in
 * another currency than the shift's, is accepted and flagged).
 *
 * Payload hash (D-7, "Mixed-version payload hashes"): an absent `frozenPolicy`
 * is OMITTED from the open's canonical form — never `?? null` — so a
 * pre-upgrade open re-delivered later hashes byte-identically; a present null
 * `policyRevisionId` is hashed as null. `limitAmount` is hashed in the
 * canonical money form of the frozen currency, or verbatim when that currency
 * has no ISO-4217 minor unit or the amount is finer than it.
 */
import { z } from "zod";

import type { PolicyValue } from "../cash-variance-policy/policy-value";
import { renderPolicyValue } from "../cash-variance-policy/policy-value";
import { minorUnitExponent } from "../catalog/sales/iso4217-minor-units";
import { formatMoney } from "./shift-money";

export type FrozenPolicySource = "system" | "tenant" | "store" | "fallback";
export type PolicyFlag = "policy_revision_unknown" | "policy_revision_superseded" | "policy_value_mismatch";

/** The contract's flag order; a stored flag list is always in it. */
export const POLICY_FLAG_ORDER: ReadonlyArray<PolicyFlag> = [
  "policy_revision_unknown",
  "policy_revision_superseded",
  "policy_value_mismatch",
];

export interface FrozenPolicyFact {
  readonly policySource: FrozenPolicySource;
  readonly policyRevisionId: string | null;
  readonly policyValue: PolicyValue;
}

export interface RecordedFrozenPolicy extends FrozenPolicyFact {
  readonly policyFlags: ReadonlyArray<PolicyFlag>;
}

const uuid = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

const FrozenValueSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z
    .object({
      mode: z.literal("limit"),
      limitAmount: z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, "must be a non-negative exact-decimal string"),
      currencyCode: z.string().regex(/^[A-Z]{3}$/, "must be an ISO-4217 code"),
    })
    .strict(),
]);

/** `FrozenPolicy`: all three members, a revision id exactly for source tenant / store. */
export const FrozenPolicySchema = z
  .object({
    policySource: z.enum(["system", "tenant", "store", "fallback"]),
    policyRevisionId: uuid.nullable(),
    policyValue: FrozenValueSchema,
  })
  .strict()
  .superRefine((frozen, ctx) => {
    const needsRevision = frozen.policySource === "tenant" || frozen.policySource === "store";
    if (needsRevision !== (frozen.policyRevisionId !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policyRevisionId"],
        message: "is a uuid for source tenant or store and null for system or fallback",
      });
    }
  });

/** An amount as the open's hash carries it (see the module header). */
function hashAmount(amount: string, currencyCode: string): string {
  if (minorUnitExponent(currencyCode) === null) return amount;
  try {
    return formatMoney({ amount, currencyCode });
  } catch {
    return amount;
  }
}

/** The frozen policy's canonical form inside the open's payload hash. */
export function frozenPolicyHashForm(frozen: FrozenPolicyFact): Record<string, unknown> {
  const value = frozen.policyValue;
  return {
    policySource: frozen.policySource,
    policyRevisionId: frozen.policyRevisionId,
    policyValue:
      value.mode === "limit"
        ? { mode: "limit", limitAmount: hashAmount(value.limitAmount, value.currencyCode), currencyCode: value.currencyCode }
        : { mode: "none" },
  };
}

/** The `shifts` columns of a frozen policy, selected next to the cash-up columns. */
export const FROZEN_POLICY_COLUMNS = `
  frozen_policy_source, frozen_policy_revision_id, frozen_policy_mode,
  frozen_policy_limit_amount::text AS frozen_policy_limit_amount, frozen_policy_currency_code,
  frozen_policy_flags`;

export interface FrozenPolicyDbColumns {
  frozen_policy_source: FrozenPolicySource | null;
  frozen_policy_revision_id: string | null;
  frozen_policy_mode: string | null;
  frozen_policy_limit_amount: string | null;
  frozen_policy_currency_code: string | null;
  frozen_policy_flags: PolicyFlag[] | null;
}

/** The recorded policy of a row (null when the open carried none: all-or-none by CHECK). */
export function toRecordedFrozenPolicy(row: FrozenPolicyDbColumns): RecordedFrozenPolicy | null {
  if (row.frozen_policy_source === null || row.frozen_policy_mode === null) return null;
  return {
    policySource: row.frozen_policy_source,
    policyRevisionId: row.frozen_policy_revision_id,
    policyValue: renderPolicyValue({
      mode: row.frozen_policy_mode,
      limitAmount: row.frozen_policy_limit_amount,
      currencyCode: row.frozen_policy_currency_code,
    }),
    policyFlags: POLICY_FLAG_ORDER.filter((f) => (row.frozen_policy_flags ?? []).includes(f)),
  };
}

/** The six insert parameters of a recorded policy (all null without one; flags `{}` when none). */
export function frozenPolicyParams(frozen: RecordedFrozenPolicy | null): unknown[] {
  if (frozen === null) return [null, null, null, null, null, null];
  const value = frozen.policyValue;
  return [
    frozen.policySource,
    frozen.policyRevisionId,
    value.mode,
    value.mode === "limit" ? value.limitAmount : null,
    value.mode === "limit" ? value.currencyCode : null,
    [...frozen.policyFlags],
  ];
}
