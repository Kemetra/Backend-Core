/**
 * RT-730 (CAT-R2) — request schemas and the keyset cursor of the console
 * catalog read (`catalog/console-catalog.yaml`, RT-729).
 *
 * List (`consoleListCatalogProducts`): every key is optional. `.strict()`
 * rejects an unknown key, so a smuggled `tenant_id` is a 400: the tenant
 * always comes from the session (§XII). Every value must be a single string:
 * a repeated key arrives as an array and is a 400. `q` counts code points and
 * refuses a lone surrogate or a NUL (RT-611 / RT-612). Every refusal here is
 * a 400 `validation_error`, raised after the guards and before any read.
 *
 * Cursor. The console convention (`console-sales`, `shift-closes`): opaque,
 * unsigned, bound to this operation, the tenant and a digest of every filter;
 * any other token is a 400. It carries only the keyset position
 * `(matchRank, name, productId)`; the caller's store scope is never in it and
 * is re-checked on every page. Because the position holds a product name (up
 * to 500 code points) the token is a compact byte layout rather than JSON:
 *
 *   [0] version   [1] matchRank   [2..17] tenant   [18..33] product id
 *   [34..49] filter digest   [50..] name (UTF-8)
 *
 * so the longest one stays under the contract's 4096 characters.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import { codePointLength, hasNoNul, maxCodePoints, NO_NUL_MESSAGE, wellFormedText } from "../../common/text-validation";

export const LIMIT_DEFAULT = 50;
export const LIMIT_MAX = 100;
const Q_MAX = 100;
const NAME_MAX = 500;

export const PRODUCT_STATUS_FILTERS = ["active", "inactive", "retired", "any"] as const;
export type ProductStatusFilter = (typeof PRODUCT_STATUS_FILTERS)[number];

const UuidSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

export const CatalogProductListQuerySchema = z
  .object({
    q: z
      .string()
      .min(1)
      .superRefine(maxCodePoints(Q_MAX))
      .superRefine(wellFormedText)
      .refine(hasNoNul, NO_NUL_MESSAGE)
      .optional(),
    status: z.enum(PRODUCT_STATUS_FILTERS).optional(),
    category_id: UuidSchema.optional(),
    store_id: UuidSchema.optional(),
    cursor: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[A-Za-z0-9_-]+$/, "cursor must be an opaque continuation token")
      .optional(),
    // A digit string, never `z.coerce`: an array (`limit[]=5`) must not coerce.
    limit: z
      .string()
      .regex(/^\d{1,3}$/, "limit must be an integer")
      .transform(Number)
      .pipe(z.number().int().min(1).max(LIMIT_MAX))
      .optional(),
  })
  .strict();

export type CatalogProductListQuery = z.infer<typeof CatalogProductListQuerySchema>;

export const ProductIdParamSchema = UuidSchema;

/** Every list filter (null = not filtered); the cursor is bound to all of them. */
export interface CatalogProductFilters {
  readonly q: string | null;
  readonly status: ProductStatusFilter;
  /** Lower case. */
  readonly categoryId: string | null;
  /** Lower case. */
  readonly storeId: string | null;
}

export function catalogFiltersOf(query: CatalogProductListQuery): CatalogProductFilters {
  return {
    q: query.q ?? null,
    status: query.status ?? "active",
    categoryId: query.category_id ?? null,
    storeId: query.store_id ?? null,
  };
}

/** The position after which the next page starts. `matchRank` 0 = exact identifier hit (or no `q`). */
export interface CatalogProductKeyset {
  readonly matchRank: 0 | 1;
  readonly name: string;
  readonly productId: string;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** A cursor this operation did not issue for this tenant and filters → 400. */
export class InvalidCatalogCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this query");
    this.name = "InvalidCatalogCursorError";
  }
}

const VERSION = 1;
const OPERATION = "console_catalog_products";
const UUID_BYTES = 16;
const DIGEST_BYTES = 16;
const NAME_OFFSET = 2 + UUID_BYTES + UUID_BYTES + DIGEST_BYTES;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

function uuidOf(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function digestOf(filters: CatalogProductFilters): Buffer {
  const ordered = [OPERATION, filters.q, filters.status, filters.categoryId, filters.storeId];
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest().subarray(0, DIGEST_BYTES);
}

export interface CatalogCursorBinding {
  readonly tenantId: string;
  readonly filters: CatalogProductFilters;
}

export function encodeCatalogCursor(binding: CatalogCursorBinding, keyset: CatalogProductKeyset): string {
  return Buffer.concat([
    Buffer.from([VERSION, keyset.matchRank]),
    uuidBytes(binding.tenantId.toLowerCase()),
    uuidBytes(keyset.productId.toLowerCase()),
    digestOf(binding.filters),
    Buffer.from(keyset.name, "utf8"),
  ]).toString("base64url");
}

/** The cursor's bytes, if it is a canonical token long enough to hold a name. */
function cursorBytes(cursor: string): Buffer {
  const bytes = Buffer.from(cursor, "base64url");
  // A canonical token only: base64url decoding ignores stray characters and padding bits.
  if (bytes.length <= NAME_OFFSET || bytes.toString("base64url") !== cursor) throw new InvalidCatalogCursorError();
  return bytes;
}

/** True when the header names this version, a valid rank, this tenant and these filters. */
function isBoundTo(bytes: Buffer, binding: CatalogCursorBinding): boolean {
  const rank = bytes[1];
  return (
    bytes[0] === VERSION &&
    (rank === 0 || rank === 1) &&
    bytes.subarray(2, 2 + UUID_BYTES).equals(uuidBytes(binding.tenantId.toLowerCase())) &&
    bytes.subarray(2 + 2 * UUID_BYTES, NAME_OFFSET).equals(digestOf(binding.filters))
  );
}

/** The keyset name: strict UTF-8, no NUL, at most 500 code points. */
function cursorName(bytes: Buffer): string {
  let name: string;
  try {
    name = strictUtf8.decode(bytes.subarray(NAME_OFFSET));
  } catch {
    throw new InvalidCatalogCursorError();
  }
  if (!hasNoNul(name) || codePointLength(name) > NAME_MAX) throw new InvalidCatalogCursorError();
  return name;
}

/** The keyset position of `cursor`, or InvalidCatalogCursorError when it was not issued for `binding`. */
export function decodeCatalogCursor(binding: CatalogCursorBinding, cursor: string): CatalogProductKeyset {
  const bytes = cursorBytes(cursor);
  if (!isBoundTo(bytes, binding)) throw new InvalidCatalogCursorError();
  return {
    matchRank: bytes[1] as 0 | 1,
    name: cursorName(bytes),
    productId: uuidOf(bytes.subarray(2 + UUID_BYTES, 2 + 2 * UUID_BYTES)),
  };
}

/**
 * `q` as an ILIKE substring pattern: `%`, `_` and the escape character `\`
 * are literal, so the match is a plain case-insensitive substring.
 */
export function substringPattern(q: string): string {
  const escaped = q.replaceAll(/[\\%_]/g, (c) => "\\" + c);
  return `%${escaped}%`;
}
