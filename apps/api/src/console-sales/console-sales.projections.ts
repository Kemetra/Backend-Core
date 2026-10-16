/**
 * RT-562 — pure wire projections and page assembly of the console sales read
 * (`console-sales.openapi.yaml` 1.0.0-draft). No DB, no clock.
 *
 * The console reads the same recorded sale facts as the POS sale history, so
 * the item and the detail are the sale-history projections (RT-539) with the
 * POS-only parts removed (`visibility`, `receiptFacts`, `reprint`) and the
 * store added (`storeRef`, `storeTimezone`): both reads describe one sale the
 * same way by construction.
 *
 * Every filter (`sale_number`, `sync_status`, `voided`, `return_state`,
 * `erp_posting_state`) is matched against the PROJECTED item, so a filter and
 * the value it shows can never disagree (for example `unknown` covers every
 * posting status the projection maps to `unknown`, not only a missing posting
 * row), and the rows one request reads stay bounded whatever the filter.
 */
import {
  toSaleHistoryItem,
  type SaleHistoryDetail,
  type SaleHistoryItem,
  type SaleHistoryRow,
} from "../catalog/sales/history/sale-history.projections";
import type { SaleHistoryKeyset } from "../catalog/sales/history/sale-history.query";
import type { ConsoleSaleFilters } from "./console-sales.query";

export type ConsoleSaleItem = SaleHistoryItem & { readonly storeRef: string };

export type ConsoleSaleDetail = Omit<SaleHistoryDetail, "summary" | "receiptFacts" | "reprint"> & {
  readonly summary: ConsoleSaleItem;
  readonly storeTimezone: string;
};

export interface ConsoleSalePage {
  readonly items: ReadonlyArray<ConsoleSaleItem>;
  readonly nextCursor: string | null;
  readonly asOf: string;
  readonly storeRef: string;
  readonly storeTimezone: string;
  readonly from: string;
  readonly to: string;
}

export function toConsoleSaleItem(item: SaleHistoryItem, storeRef: string): ConsoleSaleItem {
  const { saleRef, ...rest } = item;
  return { saleRef, storeRef, ...rest };
}

/** The sale-history detail as the console detail: no POS-only facts, plus the store. */
export function toConsoleSaleDetail(detail: SaleHistoryDetail, storeRef: string, storeTimezone: string): ConsoleSaleDetail {
  const { summary, receiptFacts: _receiptFacts, reprint: _reprint, ...facts } = detail;
  return { summary: toConsoleSaleItem(summary, storeRef), storeTimezone, ...facts };
}

/** The list filters, matched on the projected item. */
export function matchesFilters(item: SaleHistoryItem, filters: ConsoleSaleFilters): boolean {
  const wanted: ReadonlyArray<readonly [unknown, unknown]> = [
    [filters.saleNumber, item.saleNumber],
    [filters.syncStatus, item.syncStatus],
    [filters.voided, item.voided],
    [filters.returnState, item.returnState],
    [filters.erpPostingState, item.erpPostingState],
  ];
  // A null filter is not set; a set one must equal the projected value.
  return wanted.every(([filter, value]) => filter === null || filter === value);
}

export function keysetOf(row: SaleHistoryRow): SaleHistoryKeyset {
  return { businessDate: row.business_date, occurredAtKey: row.occurred_at_key, saleId: row.sale_id };
}

export interface AssembledPage {
  readonly items: ConsoleSaleItem[];
  /** Where the next page starts; null when the walk has ended. */
  readonly resumeAfter: SaleHistoryKeyset | null;
}

/**
 * One page from the rows the server read (in list order, at most `readLimit`).
 *
 *   - more matches than `pageSize`: the first `pageSize`; resume after the last RETURNED row;
 *   - otherwise, when the read was cut at `readLimit`: every match (possibly none); resume
 *     after the last row READ, so the next page never re-reads this window;
 *   - otherwise the range is exhausted: every match, and the walk ends.
 *
 * Either resume point is a row this request read, so every non-null cursor
 * moves the walk forward.
 */
export function assemblePage(input: {
  readonly rows: ReadonlyArray<SaleHistoryRow>;
  readonly readLimit: number;
  readonly pageSize: number;
  readonly storeRef: string;
  readonly filters: ConsoleSaleFilters;
}): AssembledPage {
  const matched = input.rows
    .map((row) => ({ row, item: toConsoleSaleItem(toSaleHistoryItem(row), input.storeRef) }))
    .filter(({ item }) => matchesFilters(item, input.filters));
  if (matched.length > input.pageSize) {
    const page = matched.slice(0, input.pageSize);
    return { items: page.map(({ item }) => item), resumeAfter: keysetOf(page[page.length - 1]!.row) };
  }
  const lastRead = input.rows.length >= input.readLimit ? input.rows[input.rows.length - 1] : undefined;
  return { items: matched.map(({ item }) => item), resumeAfter: lastRead === undefined ? null : keysetOf(lastRead) };
}
