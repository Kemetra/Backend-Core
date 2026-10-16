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

export const PayerAccountCreateSchema = z
  .object({
    category: z.enum(PAYER_CATEGORIES),
    displayName: z.string().min(1).max(200),
    externalRef: z.string().min(1).regex(/\S/, "must contain a non-whitespace character").nullable().optional(),
    storeId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type PayerAccountCreateDto = z.infer<typeof PayerAccountCreateSchema>;

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
