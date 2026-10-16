/**
 * RT-562 (RT-556 F2) — request schemas and the keyset cursor of the console
 * sales read (`console-sales.openapi.yaml` 1.0.0-draft, RT-561).
 *
 * List (`consoleListSales`): `store_id`, `from` and `to` are REQUIRED; both
 * dates are inclusive, `to >= from` and `to - from <= 30` (31 business days,
 * the sale-history rule). A wider range is a 400 and is never truncated.
 * `.strict()` rejects an unknown key, so a smuggled `tenant_id` is a 400: the
 * tenant always comes from the session (§XII). Every value must be a single
 * string: a repeated key arrives as an array and is a 400. Every refusal here
 * is a 400 `validation_error`, raised after the guards and before any read.
 *
 * Cursor. The repo convention (`shift-closes`, `sale-history`): unsigned
 * base64url JSON bound to this operation, the tenant, the store and a digest
 * of every filter; any other token, a POS sale-history cursor included, is a
 * 400. It carries only the keyset position. The caller's store scope is never
 * in it: the service re-checks the scope on every page, so a hand-built token
 * can only reposition the walk inside rows the caller may already read.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  isCalendarDate,
  MAX_SPAN_DAYS,
  PAGE_SIZE_MAX,
  type SaleHistoryKeyset,
} from "../catalog/sales/history/sale-history.query";
import type { ErpPostingState, ReturnState } from "../catalog/sales/history/sale-history.projections";
import { SALE_SYNC_STATUS_VALUES, type SaleSyncStatus } from "../catalog/sales/sale-sync-status";

export { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from "../catalog/sales/history/sale-history.query";

/**
 * The most sales one filtered list request reads (any of `sale_number`,
 * `sync_status`, `voided`, `return_state`, `erp_posting_state`). The page may
 * then be short or empty with a non-null cursor (the contract's bounded page).
 */
export const SCAN_LIMIT_DEFAULT = 500;

const DAY_MS = 86_400_000;

const UuidSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

const BusinessDateSchema = z.string().refine(isCalendarDate, "must be a calendar date (YYYY-MM-DD)");

const SYNC_STATUSES = SALE_SYNC_STATUS_VALUES as unknown as [SaleSyncStatus, ...SaleSyncStatus[]];

export const ConsoleSaleListQuerySchema = z
  .object({
    store_id: UuidSchema,
    from: BusinessDateSchema,
    to: BusinessDateSchema,
    sale_number: z.string().min(1).max(96).optional(),
    sync_status: z.enum(SYNC_STATUSES).optional(),
    // Only the literals: `z.coerce.boolean` would read "0" or "no" as true.
    voided: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    return_state: z.enum(["none", "partial", "full"]).optional(),
    erp_posting_state: z.enum(["posted", "pending", "failed", "unknown"]).optional(),
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
      .pipe(z.number().int().min(1).max(PAGE_SIZE_MAX))
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

export type ConsoleSaleListQuery = z.infer<typeof ConsoleSaleListQuerySchema>;

export const SaleRefParamSchema = UuidSchema;

/** Every list filter (null = not filtered); the cursor is bound to all of them. */
export interface ConsoleSaleFilters {
  readonly from: string;
  readonly to: string;
  readonly saleNumber: string | null;
  readonly syncStatus: SaleSyncStatus | null;
  readonly voided: boolean | null;
  readonly returnState: ReturnState | null;
  readonly erpPostingState: ErpPostingState | null;
}

export function consoleFiltersOf(query: ConsoleSaleListQuery): ConsoleSaleFilters {
  return {
    from: query.from,
    to: query.to,
    saleNumber: query.sale_number ?? null,
    syncStatus: query.sync_status ?? null,
    voided: query.voided ?? null,
    returnState: query.return_state ?? null,
    erpPostingState: query.erp_posting_state ?? null,
  };
}

/** True when any filter beyond the store and the range is set (the read is then scan-capped). */
export function hasAnyFilter(filters: ConsoleSaleFilters): boolean {
  return (
    filters.saleNumber !== null ||
    filters.syncStatus !== null ||
    filters.voided !== null ||
    filters.returnState !== null ||
    filters.erpPostingState !== null
  );
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** A cursor this operation did not issue for this tenant, store and filters → 400. */
export class InvalidConsoleSaleCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this query");
    this.name = "InvalidConsoleSaleCursorError";
  }
}

const OPERATION = "console_sales";
const LOWER_UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const KEY_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const CursorPayload = z
  .object({
    op: z.literal(OPERATION),
    tenant: z.string().regex(LOWER_UUID),
    store: z.string().regex(LOWER_UUID),
    digest: z.string().min(1),
    date: z.string().refine(isCalendarDate),
    at: z.string().regex(KEY_INSTANT).refine(namesRealInstant),
    id: z.string().regex(LOWER_UUID),
  })
  .strict();

type CursorPayload = z.infer<typeof CursorPayload>;

/** True when `key` (UTC, six fractional digits) names a real instant, not a rolled-over one. */
function namesRealInstant(key: string): boolean {
  const ms = Date.parse(key);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === key.slice(0, 19);
}

function digestOf(filters: ConsoleSaleFilters): string {
  const ordered = [
    filters.from,
    filters.to,
    filters.saleNumber,
    filters.syncStatus,
    filters.voided,
    filters.returnState,
    filters.erpPostingState,
  ];
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("base64url").slice(0, 22);
}

export interface ConsoleCursorBinding {
  readonly tenantId: string;
  readonly storeId: string;
  readonly filters: ConsoleSaleFilters;
}

export function encodeConsoleSaleCursor(binding: ConsoleCursorBinding, keyset: SaleHistoryKeyset): string {
  const payload: CursorPayload = {
    op: OPERATION,
    tenant: binding.tenantId.toLowerCase(),
    store: binding.storeId.toLowerCase(),
    digest: digestOf(binding.filters),
    date: keyset.businessDate,
    at: keyset.occurredAtKey,
    id: keyset.saleId,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The keyset position of `cursor`, or InvalidConsoleSaleCursorError when it was not issued for `binding`. */
export function decodeConsoleSaleCursor(binding: ConsoleCursorBinding, cursor: string): SaleHistoryKeyset {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidConsoleSaleCursorError();
  }
  const parsed = CursorPayload.safeParse(decoded);
  if (!parsed.success) throw new InvalidConsoleSaleCursorError();
  const p = parsed.data;
  const boundHere =
    p.tenant === binding.tenantId.toLowerCase() &&
    p.store === binding.storeId.toLowerCase() &&
    p.digest === digestOf(binding.filters);
  if (!boundHere) throw new InvalidConsoleSaleCursorError();
  return { businessDate: p.date, occurredAtKey: p.at, saleId: p.id };
}
