/**
 * RT-649 — request schema and the store-page cursor of the console sales
 * summary (`console-sales-summary.openapi.yaml` 1.0.0-draft).
 *
 * `from` and `to` are REQUIRED, inclusive, `to >= from` and `to - from <= 30`
 * (the `consoleListSales` bound); a wider range is a 400, never truncated.
 * `store_id` is optional (one store, or every store in the caller's scope).
 * `.strict()` rejects an unknown key, so a smuggled `tenant_id` is a 400; a
 * repeated key arrives as an array and is a 400. Every refusal here is a 400
 * `validation_error`, raised after the guards and before any read.
 *
 * Cursor. The repo convention (`console-sales`, `shift-closes`): unsigned
 * base64url JSON bound to this operation, the tenant, the store (or its
 * absence), the range and the page size; any other token is a 400. It carries
 * only the last returned store id. The caller's store scope is re-read on
 * every request and never carried, so a hand-built token can only skip
 * stores the caller may already read.
 */
import { z } from "zod";

import { isCalendarDate, MAX_SPAN_DAYS } from "../catalog/sales/history/sale-history.query";
import { LOWER_UUID } from "./console-sales.query";

export const SUMMARY_PAGE_SIZE_DEFAULT = 50;
export const SUMMARY_PAGE_SIZE_MAX = 50;

const DAY_MS = 86_400_000;

const BusinessDateSchema = z.string().refine(isCalendarDate, "must be a calendar date (YYYY-MM-DD)");

export const ConsoleSalesSummaryQuerySchema = z
  .object({
    store_id: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
    from: BusinessDateSchema,
    to: BusinessDateSchema,
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "cursor must be an opaque continuation token")
      .optional(),
    // A digit string, never `z.coerce`: an array (`page_size[]=5`) must not coerce.
    page_size: z
      .string()
      .regex(/^\d{1,3}$/, "page_size must be an integer")
      .transform(Number)
      .pipe(z.number().int().min(1).max(SUMMARY_PAGE_SIZE_MAX))
      .optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const days = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / DAY_MS;
    if (days < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must not be before from" });
    } else if (days > MAX_SPAN_DAYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "the range is at most 31 business days" });
    }
  });

export type ConsoleSalesSummaryQuery = z.infer<typeof ConsoleSalesSummaryQuerySchema>;

/** Every business date from `from` to `to`, inclusive, ascending. */
export function businessDatesOf(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= Date.parse(`${to}T00:00:00Z`); ms += DAY_MS) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** A cursor this operation did not issue for this tenant, store, range and page size → 400. */
export class InvalidSalesSummaryCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this query");
    this.name = "InvalidSalesSummaryCursorError";
  }
}

const OPERATION = "console_sales_summary";

const CursorPayload = z
  .object({
    op: z.literal(OPERATION),
    tenant: z.string().regex(LOWER_UUID),
    store: z.string().regex(LOWER_UUID).nullable(),
    from: z.string().refine(isCalendarDate),
    to: z.string().refine(isCalendarDate),
    size: z.number().int().min(1).max(SUMMARY_PAGE_SIZE_MAX),
    after: z.string().regex(LOWER_UUID),
  })
  .strict();

type CursorPayload = z.infer<typeof CursorPayload>;

export interface SummaryCursorBinding {
  readonly tenantId: string;
  /** Lower case; null for every store in scope. */
  readonly storeId: string | null;
  readonly from: string;
  readonly to: string;
  readonly pageSize: number;
}

export function encodeSalesSummaryCursor(binding: SummaryCursorBinding, afterStoreId: string): string {
  const payload: CursorPayload = {
    op: OPERATION,
    tenant: binding.tenantId.toLowerCase(),
    store: binding.storeId,
    from: binding.from,
    to: binding.to,
    size: binding.pageSize,
    after: afterStoreId.toLowerCase(),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The last store id of the previous page, or InvalidSalesSummaryCursorError when not issued for `binding`. */
export function decodeSalesSummaryCursor(binding: SummaryCursorBinding, cursor: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidSalesSummaryCursorError();
  }
  const parsed = CursorPayload.safeParse(decoded);
  if (!parsed.success) throw new InvalidSalesSummaryCursorError();
  const p = parsed.data;
  const boundHere =
    p.tenant === binding.tenantId.toLowerCase() &&
    p.store === binding.storeId &&
    p.from === binding.from &&
    p.to === binding.to &&
    p.size === binding.pageSize;
  if (!boundHere) throw new InvalidSalesSummaryCursorError();
  return p.after;
}
