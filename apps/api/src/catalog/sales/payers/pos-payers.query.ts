/**
 * RT-802 — the query and the keyset cursor of `posListChargeablePayers`
 * (`pos-payers.openapi.yaml` 1.0.0-draft, RT-570).
 *
 * Query: `category`, `cursor` and `page_size` (1..200, default 50) only.
 * `.strict()` rejects any other key, so a smuggled `store_id` or a `q` search
 * is a 400: scope always comes from the envelope (§XII), and a payer name
 * never travels in a URL. A repeated key arrives as an array and is a 400.
 *
 * Cursor. Repo convention (`sale-history.query.ts`): unsigned base64url JSON
 * bound to the operation, the tenant, the store and the `category` filter it
 * was issued under; any other token is a 400. It carries only the last
 * payerRef, never a name. The scope is applied to every page by the service,
 * so a hand-built token can only reposition the walk inside rows the caller
 * may already read.
 */
import { z } from "zod";

import { PAYER_CATEGORIES, type PayerCategory } from "../../../settlement/dto/payer-account.dto";

export const POS_PAYERS_PAGE_SIZE_DEFAULT = 50;
export const POS_PAYERS_PAGE_SIZE_MAX = 200;

export const PosPayersQuerySchema = z
  .object({
    category: z.enum(PAYER_CATEGORIES).optional(),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "cursor must be an opaque continuation token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(POS_PAYERS_PAGE_SIZE_MAX).optional(),
  })
  .strict();

export type PosPayersQuery = z.infer<typeof PosPayersQuerySchema>;

/** Raised for a cursor this operation did not issue for this scope and filter → 400 validation_error. */
export class InvalidPosPayersCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this query");
    this.name = "InvalidPosPayersCursorError";
  }
}

const LOWER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_KIND = "pos_payers";

const CursorSchema = z
  .object({
    k: z.literal(CURSOR_KIND),
    t: z.string().regex(LOWER_UUID_RE),
    s: z.string().regex(LOWER_UUID_RE),
    c: z.enum(PAYER_CATEGORIES).nullable(),
    i: z.string().regex(LOWER_UUID_RE),
  })
  .strict();

interface CursorScope {
  readonly tenantId: string;
  readonly storeId: string;
  readonly category: PayerCategory | null;
}

export function encodePosPayersCursor(input: CursorScope & { readonly lastPayerRef: string }): string {
  const payload = {
    k: CURSOR_KIND,
    t: input.tenantId.toLowerCase(),
    s: input.storeId.toLowerCase(),
    c: input.category,
    i: input.lastPayerRef.toLowerCase(),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The last payerRef, if `cursor` was issued by this operation for this tenant, store and category. */
export function decodePosPayersCursor(input: CursorScope & { readonly cursor: string }): string {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidPosPayersCursorError();
  }
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidPosPayersCursorError();
  const { t, s, c, i } = parsed.data;
  const issuedHere = t === input.tenantId.toLowerCase() && s === input.storeId.toLowerCase() && c === input.category;
  if (!issuedHere) throw new InvalidPosPayersCursorError();
  return i;
}
