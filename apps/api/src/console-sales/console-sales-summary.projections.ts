/**
 * RT-649 — the pure assembly of the console sales summary
 * (`console-sales-summary.openapi.yaml` 1.0.0-draft). No DB, no clock.
 *
 * The service reads one row per (fact kind, store, business date, currency,
 * state) group, each already counted and summed in SQL, and this module rolls
 * them into the wire shape: one dense bucket per store and business date, the
 * store's range totals, and the scope's per-date and range totals over EVERY
 * store of the scope. Money stays exact: every amount is the `numeric(19,4)`
 * text Postgres returns, added here as a BigInt of ten-thousandths and
 * rendered back with four fractional digits. Nothing is ever a JS number,
 * converted between currencies or added across currencies.
 */
import { compareCodeUnits } from "../common/compare-code-units";
import { erpPostingStateOf } from "../catalog/sales/history/sale-history.projections";

// ---------------------------------------------------------------------------
// Rows read by the service
// ---------------------------------------------------------------------------

export type SummaryFactKind = "sale" | "void" | "return" | "refund" | "close";

/**
 * One aggregated group. `k1` / `k2` / `k3` by kind:
 *   sale:  k1 = sales.sync_status, k2 = erpnext_posting_status.status (null = no row)
 *   close: k1 = close_kind, k2 = approval_missing, k3 = 'true' when variance <> 0
 *   void / return / refund: unused (null)
 * `amount` is the `numeric(19,4)` SUM as text (null for closes); `n` the count.
 */
export interface SummaryFactRow {
  readonly kind: SummaryFactKind;
  readonly store_id: string;
  readonly business_date: string;
  readonly currency_code: string | null;
  readonly k1: string | null;
  readonly k2: string | null;
  readonly k3: string | null;
  readonly n: number;
  readonly amount: string | null;
}

export interface SummaryStoreRow {
  readonly store_id: string;
  readonly timezone: string;
  /** The store-local date at `asOf`. */
  readonly current_business_date: string;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface CurrencyTotal {
  readonly currencyCode: string;
  readonly count: number;
  readonly total: string;
}

export interface MoneyFacts {
  readonly count: number;
  readonly byCurrency: readonly CurrencyTotal[];
}

export interface SalesKpis {
  readonly receivedSales: MoneyFacts;
  readonly voids: MoneyFacts;
  readonly returns: MoneyFacts;
  readonly legacyRefunds: MoneyFacts;
  readonly syncStatus: {
    readonly captured: number;
    readonly synced: number;
    readonly failedRetryable: number;
    readonly failedNeedsRepair: number;
  };
  readonly erpPosting: { readonly posted: number; readonly pending: number; readonly failed: number; readonly unknown: number };
  readonly shiftCloses: {
    readonly count: number;
    readonly normal: number;
    readonly forced: number;
    readonly withVariance: number;
    readonly approvalMissing: { readonly yes: number; readonly no: number; readonly unknown: number };
  };
}

export interface BusinessDateKpis {
  readonly businessDate: string;
  readonly kpis: SalesKpis;
}

export interface StoreSalesSummary {
  readonly storeRef: string;
  readonly storeTimezone: string;
  readonly currentBusinessDate: string;
  readonly days: readonly BusinessDateKpis[];
  readonly rangeTotals: SalesKpis;
}

export interface ConsoleSalesSummary {
  readonly scope: "store" | "all_in_scope";
  readonly storeRef: string | null;
  readonly from: string;
  readonly to: string;
  readonly asOf: string;
  readonly completeness: "received_only";
  readonly stores: readonly StoreSalesSummary[];
  readonly nextCursor: string | null;
  readonly scopeTotals: {
    readonly storeCount: number;
    readonly days: readonly BusinessDateKpis[];
    readonly rangeTotals: SalesKpis;
  };
}

// ---------------------------------------------------------------------------
// Exact decimal (four fractional digits)
// ---------------------------------------------------------------------------

const SCALE = 4;
const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d{1,4}))?$/;

/** `"123.4500"` → 1234500n. Throws on anything that is not a decimal with at most four digits. */
export function parseDecimal4(text: string): bigint {
  const m = DECIMAL_RE.exec(text);
  if (m === null) throw new Error(`sales summary: not a numeric(19,4) amount: ${JSON.stringify(text)}`);
  const value = BigInt(m[2]!) * 10n ** BigInt(SCALE) + BigInt((m[3] ?? "").padEnd(SCALE, "0"));
  return m[1] === "-" ? -value : value;
}

/** 1234500n → `"123.4500"`. */
export function formatDecimal4(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(SCALE);
  const text = `${abs / unit}.${(abs % unit).toString().padStart(SCALE, "0")}`;
  return negative ? `-${text}` : text;
}

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

class MoneyAcc {
  private readonly byCurrency = new Map<string, { count: number; total: bigint }>();

  add(currency: string, count: number, amount: bigint): void {
    const cur = this.byCurrency.get(currency) ?? { count: 0, total: 0n };
    cur.count += count;
    cur.total += amount;
    this.byCurrency.set(currency, cur);
  }

  toWire(): MoneyFacts {
    const byCurrency = [...this.byCurrency.entries()]
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([currencyCode, v]) => ({ currencyCode, count: v.count, total: formatDecimal4(v.total) }));
    return { count: byCurrency.reduce((n, c) => n + c.count, 0), byCurrency };
  }
}

class KpiAcc {
  readonly receivedSales = new MoneyAcc();
  readonly voids = new MoneyAcc();
  readonly returns = new MoneyAcc();
  readonly legacyRefunds = new MoneyAcc();
  readonly sync = { captured: 0, synced: 0, failedRetryable: 0, failedNeedsRepair: 0 };
  readonly erp = { posted: 0, pending: 0, failed: 0, unknown: 0 };
  readonly closes = { count: 0, normal: 0, forced: 0, withVariance: 0, approvalMissing: { yes: 0, no: 0, unknown: 0 } };

  add(row: SummaryFactRow): void {
    switch (row.kind) {
      case "sale":
        this.receivedSales.add(currencyOf(row), row.n, amountOf(row));
        this.sync[syncKeyOf(row.k1)] += row.n;
        this.erp[erpPostingStateOf(row.k2)] += row.n;
        return;
      case "void":
        this.voids.add(currencyOf(row), row.n, amountOf(row));
        return;
      case "return":
        this.returns.add(currencyOf(row), row.n, amountOf(row));
        return;
      case "refund":
        this.legacyRefunds.add(currencyOf(row), row.n, amountOf(row));
        return;
      case "close":
        this.closes.count += row.n;
        this.closes[closeKindOf(row.k1)] += row.n;
        if (row.k3 === "true") this.closes.withVariance += row.n;
        this.closes.approvalMissing[triStateOf(row.k2)] += row.n;
        return;
    }
  }

  toWire(): SalesKpis {
    return {
      receivedSales: this.receivedSales.toWire(),
      voids: this.voids.toWire(),
      returns: this.returns.toWire(),
      legacyRefunds: this.legacyRefunds.toWire(),
      syncStatus: { ...this.sync },
      erpPosting: { ...this.erp },
      shiftCloses: { ...this.closes, approvalMissing: { ...this.closes.approvalMissing } },
    };
  }
}

function currencyOf(row: SummaryFactRow): string {
  if (row.currency_code === null) throw new Error(`sales summary: a ${row.kind} group has no currency`);
  return row.currency_code;
}

function amountOf(row: SummaryFactRow): bigint {
  if (row.amount === null) throw new Error(`sales summary: a ${row.kind} group has no amount`);
  return parseDecimal4(row.amount);
}

const SYNC_KEYS: Readonly<Record<string, keyof KpiAcc["sync"]>> = {
  captured: "captured",
  synced: "synced",
  "failed-retryable": "failedRetryable",
  "failed-needs-repair": "failedNeedsRepair",
};

/** A sync status outside the 0026 CHECK cannot be stored; never folded into another bucket. */
function syncKeyOf(status: string | null): keyof KpiAcc["sync"] {
  const key = status === null ? undefined : SYNC_KEYS[status];
  if (key === undefined) throw new Error(`sales summary: unexpected sync status ${JSON.stringify(status)}`);
  return key;
}

function closeKindOf(kind: string | null): "normal" | "forced" {
  if (kind === "normal" || kind === "forced") return kind;
  throw new Error(`sales summary: unexpected close kind ${JSON.stringify(kind)}`);
}

function triStateOf(value: string | null): "yes" | "no" | "unknown" {
  if (value === "yes" || value === "no" || value === "unknown") return value;
  throw new Error(`sales summary: unexpected approval_missing ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AssembleSummaryInput {
  readonly scope: "store" | "all_in_scope";
  readonly storeRef: string | null;
  readonly from: string;
  readonly to: string;
  readonly dates: readonly string[];
  readonly asOf: string;
  /** Every store of the scope, any order. */
  readonly stores: readonly SummaryStoreRow[];
  readonly facts: readonly SummaryFactRow[];
  /** The last store id of the previous page (exclusive), or null for the first page. */
  readonly after: string | null;
  readonly pageSize: number;
}

export interface AssembledSummary {
  readonly body: Omit<ConsoleSalesSummary, "nextCursor">;
  /** The last store id of this page when more stores follow; null on the last page. */
  readonly resumeAfter: string | null;
}

interface StoreAcc {
  readonly days: Map<string, KpiAcc>;
  readonly range: KpiAcc;
}

function daysAcc(dates: readonly string[]): Map<string, KpiAcc> {
  return new Map(dates.map((d) => [d, new KpiAcc()]));
}

function daysWire(days: Map<string, KpiAcc>): BusinessDateKpis[] {
  return [...days.entries()].map(([businessDate, acc]) => ({ businessDate, kpis: acc.toWire() }));
}

/** Every bucket a fact group is added to: its store's day and range, the scope's day and range. */
class SummaryAcc {
  private readonly perStore: Map<string, StoreAcc>;
  readonly scopeDays: Map<string, KpiAcc>;
  readonly scopeRange = new KpiAcc();

  constructor(stores: readonly SummaryStoreRow[], dates: readonly string[]) {
    this.perStore = new Map(stores.map((s) => [s.store_id, { days: daysAcc(dates), range: new KpiAcc() }]));
    this.scopeDays = daysAcc(dates);
  }

  add(row: SummaryFactRow): void {
    const targets = [
      this.perStore.get(row.store_id)?.days.get(row.business_date),
      this.perStore.get(row.store_id)?.range,
      this.scopeDays.get(row.business_date),
      this.scopeRange,
    ];
    // Every group is read through the scoped stores and the range: anything else is a query defect.
    if (targets.includes(undefined)) {
      throw new Error("sales summary: a fact group falls outside the scoped stores or the range");
    }
    for (const acc of targets) acc!.add(row);
  }

  store(storeId: string): StoreAcc {
    return this.perStore.get(storeId)!;
  }
}

/** The stores of this page (by id, after `after`) and the last id when more follow. */
function pageOf(
  stores: readonly SummaryStoreRow[],
  after: string | null,
  pageSize: number,
): { readonly page: SummaryStoreRow[]; readonly resumeAfter: string | null } {
  const ordered = [...stores].sort((a, b) => compareCodeUnits(a.store_id, b.store_id));
  const remaining = after === null ? ordered : ordered.filter((s) => compareCodeUnits(s.store_id, after) > 0);
  const page = remaining.slice(0, pageSize);
  return { page, resumeAfter: remaining.length > page.length ? page[page.length - 1]!.store_id : null };
}

/** Roll the aggregated groups into the summary page. */
export function assembleSummary(input: AssembleSummaryInput): AssembledSummary {
  const acc = new SummaryAcc(input.stores, input.dates);
  for (const row of input.facts) acc.add(row);
  const { page, resumeAfter } = pageOf(input.stores, input.after, input.pageSize);

  return {
    body: {
      scope: input.scope,
      storeRef: input.storeRef,
      from: input.from,
      to: input.to,
      asOf: input.asOf,
      completeness: "received_only",
      stores: page.map((s) => ({
        storeRef: s.store_id,
        storeTimezone: s.timezone,
        currentBusinessDate: s.current_business_date,
        days: daysWire(acc.store(s.store_id).days),
        rangeTotals: acc.store(s.store_id).range.toWire(),
      })),
      scopeTotals: { storeCount: input.stores.length, days: daysWire(acc.scopeDays), rangeTotals: acc.scopeRange.toWire() },
    },
    resumeAfter,
  };
}
