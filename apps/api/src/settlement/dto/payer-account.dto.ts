/**
 * payer-account.dto.ts — RT-418: the Console payer-account boundary
 * (`settlement/settlement.yaml` 2.0.0, RT-417).
 *
 *   - `PayerAccountCreate`: strict, so a removed `creditTerms` or a smuggled
 *     `tenant_id` is a 400. `externalRef` (the ERPNext Customer link) is null
 *     or carries a non-whitespace character (`\S`, so a tab-only value is
 *     refused too).
 *   - the list query: `category`, an opaque keyset `cursor` (the last page's
 *     last `payerRef`) and `page_size` 1..200 (default 50).
 *   - `toPayerAccount`: the wire projection. No `tenant_id`, no credit terms.
 */
import { z } from "zod";

export const PAYER_CATEGORIES = ["credit_customer", "corporate", "insurer"] as const;
export type PayerCategory = (typeof PAYER_CATEGORIES)[number];

export const PAYER_PAGE_SIZE_DEFAULT = 50;

/**
 * Text Postgres will store: no NUL (`text` refuses it, which would surface as
 * a 500) and at least one non-whitespace character (a blank value is
 * meaningless, and `display_name` carries a non-blank CHECK).
 */
const storableText = (max?: number) => {
  const base = z.string().min(1);
  return (max === undefined ? base : base.max(max))
    .regex(/\S/, "must contain a non-whitespace character")
    .refine((value) => !value.includes("\u0000"), "must not contain a NUL character");
};

export const PayerAccountCreateSchema = z
  .object({
    category: z.enum(PAYER_CATEGORIES),
    displayName: storableText(200),
    externalRef: storableText().nullable().optional(),
    storeId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type PayerAccountCreateDto = z.infer<typeof PayerAccountCreateSchema>;

export const PAYER_STATUSES = ["active", "suspended"] as const;
export type PayerStatus = (typeof PAYER_STATUSES)[number];

/** `payer_account.version` is an int4; the contract bounds `expectedVersion` to it (a larger value would be a Postgres 22003). */
export const PAYER_VERSION_MAX = 2_147_483_647;

/**
 * The `PayerAccountUpdate` text patterns, verbatim from `settlement/settlement.yaml`
 * 2.1.0 (a unit test pins each `.source` to the contract). Both are linear: no
 * nested or overlapping quantifier, so a long value cannot stall the event loop.
 *
 *   - display name: a non-whitespace character and no NUL;
 *   - external ref (an identifier): no surrounding whitespace, no control
 *     characters, no NUL, no zero-width characters, no line / paragraph separators.
 */
// eslint-disable-next-line no-control-regex -- the NUL / control exclusion is the point of these patterns
export const PAYER_DISPLAY_NAME_PATTERN = new RegExp(String.raw`^\s*[^\s\u0000][^\u0000]*$`);
// eslint-disable-next-line no-control-regex -- see above
export const PAYER_EXTERNAL_REF_PATTERN = new RegExp(
  String.raw`^[^\s\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2028\u2029\ufeff](?:[^\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2028\u2029\ufeff]*[^\s\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2028\u2029\ufeff])?$`,
);

/**
 * `PayerAccountUpdate` (`settlement.yaml` 2.1.0, RT-572): `expectedVersion` plus
 * at least one of `displayName`, `externalRef` and `status`. Strict, so
 * `category`, `storeId`, `tenant_id` and any other key are a 400. `externalRef`
 * is a plain string, so `null` (an unlink) is a 400.
 */
export const PayerAccountUpdateSchema = z
  .object({
    expectedVersion: z.number().int().min(0).max(PAYER_VERSION_MAX),
    displayName: z.string().min(1).max(200).regex(PAYER_DISPLAY_NAME_PATTERN, "must contain a non-whitespace character and no NUL").optional(),
    externalRef: z.string().min(1).max(140).regex(PAYER_EXTERNAL_REF_PATTERN, "must be an identifier: no surrounding whitespace, control, zero-width or separator characters").optional(),
    status: z.enum(PAYER_STATUSES).optional(),
  })
  .strict()
  .refine((body) => body.displayName !== undefined || body.externalRef !== undefined || body.status !== undefined, {
    message: "at least one of displayName, externalRef or status is required",
  });

export type PayerAccountUpdateDto = z.infer<typeof PayerAccountUpdateSchema>;

/** The `payerRef` path parameter: a uuid, validated before any SQL cast (a bad value is a 400, never a Postgres 22P02). */
export const PayerRefParamSchema = z.string().uuid("payerRef is not valid");

export const PayerAccountListQuerySchema = z
  .object({
    category: z.enum(PAYER_CATEGORIES).optional(),
    cursor: z.string().uuid("cursor is not valid").optional(),
    page_size: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type PayerAccountListQuery = z.infer<typeof PayerAccountListQuerySchema>;

/** A `payer_account` row as the payer reads select it. */
export interface PayerAccountRow {
  readonly id: string;
  readonly category: PayerCategory;
  readonly display_name: string;
  readonly external_ref: string | null;
  readonly status: "active" | "suspended";
  readonly store_id: string | null;
  readonly version: number;
}

/** The contract `PayerAccount` wire shape. */
export interface PayerAccountBody {
  readonly payerRef: string;
  readonly category: PayerCategory;
  readonly displayName: string;
  readonly externalRef: string | null;
  readonly status: "active" | "suspended";
  readonly storeId: string | null;
  readonly version: number;
}

export function toPayerAccount(row: PayerAccountRow): PayerAccountBody {
  return {
    payerRef: row.id,
    category: row.category,
    displayName: row.display_name,
    externalRef: row.external_ref,
    status: row.status,
    storeId: row.store_id,
    version: row.version,
  };
}
