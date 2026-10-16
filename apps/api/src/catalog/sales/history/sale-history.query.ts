/**
 * RT-539 (RT-534 S3) — request schemas and the keyset cursor of the POS sale
 * history (`pos-sales/sale-history.yaml` 1.0.0-draft; owner decisions
 * OD-534-1..8, RT-534 comment 12048 / Confluence 40468506).
 *
 * Query (`listSaleHistory`, OD-534-4): `from` and `to` are REQUIRED business
 * dates, both inclusive, `to >= from` and `to - from <= 30` (31 business
 * days). A wider range is a 400 and is never truncated. `.strict()` rejects an
 * unknown key, so a smuggled `store_id` is a 400: scope always comes from the
 * credential (§XII). Every refusal here is a 400 `validation_error` raised
 * before any database read. Dates are checked as real calendar dates in UTC
 * date arithmetic, so `2026-02-30` is a 400 and never a Postgres 22008.
 *
 * Cursor. Repo convention (`shift-closes.projections.ts`): unsigned base64url
 * JSON bound to the operation, the tenant, the store and a digest of the
 * filters it was issued under; any other token is a 400. It carries only the
 * keyset position (the last row's business date, `occurred_at` at microsecond
 * precision and sale id). The visibility filter (a cashier's own sales) is
 * never in the cursor: the service applies it to every page, so a hand-built
 * token can only reposition the walk inside rows the caller may already read.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 100;
/** OD-534-4: 31 business days, `to - from <= 30`. */
export const MAX_SPAN_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A canonical UUID (any version), lower or upper case. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Epoch ms of a `YYYY-MM-DD` that names a real calendar day (year >= 1), else NaN. */
function calendarDayMs(value: string): number {
  if (!DATE_RE.test(value) || value.startsWith("0000")) return Number.NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  // Date.parse rolls an out-of-range day over ("02-30" -> "03-02").
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return Number.NaN;
  return ms;
}

export function isCalendarDate(value: string): boolean {
  return !Number.isNaN(calendarDayMs(value));
}

const BusinessDateSchema = z.string().refine(isCalendarDate, "must be a calendar date (YYYY-MM-DD)");

const UuidSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

export const SaleHistoryListQuerySchema = z
  .object({
    from: BusinessDateSchema,
    to: BusinessDateSchema,
    device_ref: UuidSchema.optional(),
    operator_user_id: UuidSchema.optional(),
    sale_number: z.string().min(1).max(96).optional(),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "cursor must be an opaque continuation token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  })
  .strict()
  .superRefine((q, ctx) => {
    const days = (calendarDayMs(q.to) - calendarDayMs(q.from)) / DAY_MS;
    if (days < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must not be before from" });
    } else if (days > MAX_SPAN_DAYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "the range is at most 31 business days" });
    }
  });

export type SaleHistoryListQuery = z.infer<typeof SaleHistoryListQuerySchema>;

/** An RFC 3339 UTC instant Postgres can represent (year 0000 is a 22008). */
const InstantSchema = z
  .string()
  .datetime()
  .refine((value) => !value.startsWith("0000"), "must be a representable instant");

/**
 * `SaleReprintRequest`: `localCopyNumber` is REQUIRED with `record` (the
 * originating terminal numbered the copy it printed) and FORBIDDEN with
 * `authorize` (the server assigns it). Either violation is a 400.
 */
export const SaleReprintRequestSchema = z
  .object({
    mode: z.enum(["authorize", "record"]),
    kind: z.enum(["duplicate", "sale_record"]),
    printedAt: InstantSchema,
    localCopyNumber: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const path = ["localCopyNumber"];
    if (body.mode === "record" && body.localCopyNumber === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "required with mode record" });
    } else if (body.mode === "authorize" && body.localCopyNumber !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "not allowed with mode authorize" });
    }
  });

export type SaleReprintRequestDto = z.infer<typeof SaleReprintRequestSchema>;

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** Raised for a cursor this operation did not issue for these filters -> 400 validation_error. */
export class InvalidSaleHistoryCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this query");
    this.name = "InvalidSaleHistoryCursorError";
  }
}

/** The filters a cursor is bound to (null = not filtered). */
export interface SaleHistoryFilters {
  readonly from: string;
  readonly to: string;
  readonly deviceRef: string | null;
  readonly operatorUserId: string | null;
  readonly saleNumber: string | null;
}

/** The keyset position after which the next page starts. */
export interface SaleHistoryKeyset {
  readonly businessDate: string;
  /** `occurred_at` rendered by `OCCURRED_AT_KEY_SQL`: UTC, six fractional digits. */
  readonly occurredAtKey: string;
  readonly saleId: string;
}

const OCCURRED_AT_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Renders `occurred_at` as the cursor key, so the cast back is the exact stored instant. */
export const OCCURRED_AT_KEY_SQL = `to_char(s.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CURSOR_KIND = "sale_history";

const CursorSchema = z
  .object({
    k: z.literal(CURSOR_KIND),
    t: z.string().regex(LOWER_UUID_RE),
    s: z.string().regex(LOWER_UUID_RE),
    f: z.string().min(1),
    d: z.string().refine(isCalendarDate),
    o: z.string().regex(OCCURRED_AT_KEY_RE),
    i: z.string().regex(LOWER_UUID_RE),
  })
  .strict();

/** A digest of the filters, so a cursor reused with other filters is refused. */
function filtersDigest(filters: SaleHistoryFilters): string {
  const canonical = JSON.stringify([
    filters.from,
    filters.to,
    filters.deviceRef,
    filters.operatorUserId,
    filters.saleNumber,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("base64url").slice(0, 22);
}

interface CursorScope {
  readonly tenantId: string;
  readonly storeId: string;
  readonly filters: SaleHistoryFilters;
}

export function encodeSaleHistoryCursor(input: CursorScope & { readonly keyset: SaleHistoryKeyset }): string {
  const payload = {
    k: CURSOR_KIND,
    t: input.tenantId.toLowerCase(),
    s: input.storeId.toLowerCase(),
    f: filtersDigest(input.filters),
    d: input.keyset.businessDate,
    o: input.keyset.occurredAtKey,
    i: input.keyset.saleId,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The keyset position, if `cursor` was issued by this operation for this tenant, store and filters. */
export function decodeSaleHistoryCursor(input: CursorScope & { readonly cursor: string }): SaleHistoryKeyset {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidSaleHistoryCursorError();
  }
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success || !issuedFor(parsed.data, input)) throw new InvalidSaleHistoryCursorError();
  return { businessDate: parsed.data.d, occurredAtKey: parsed.data.o, saleId: parsed.data.i };
}

/** The cursor was issued for this tenant, store and filters, and names a real instant. */
function issuedFor(cursor: z.infer<typeof CursorSchema>, scope: CursorScope): boolean {
  const sameScope = cursor.t === scope.tenantId.toLowerCase() && cursor.s === scope.storeId.toLowerCase();
  return sameScope && cursor.f === filtersDigest(scope.filters) && isCalendarInstant(cursor.o);
}

/** True when the key names a real UTC instant (no rolled-over day or hour). */
function isCalendarInstant(key: string): boolean {
  const ms = Date.parse(key);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === key.slice(0, 19);
}
