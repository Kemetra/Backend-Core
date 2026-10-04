/**
 * negative-on-hand.projection.ts — RT-177 pure helpers + wire shapes.
 *
 * The ERPNext negative on-hand view is computed on read from the latest recorded
 * Connector Bin snapshot per store (`erpnext_reconciliation_run.summary
 * .bin_view_report`, RT-51 D1/D2). Everything here is pure (no DB, no clock):
 *
 *   - the canonical exact-decimal test for "negative" — a quantity string is
 *     scaled to an integer number of millionths (BigInt), so `-0.000000` is zero,
 *     never negative, and no float ever touches a quantity;
 *   - the item order (quantity ascending, then ERPNext item name, then the
 *     entry's position in the report as a final tie-break);
 *   - the opaque cursors (base64url JSON, strictly validated on the way in);
 *   - the freshness classification (RT-51 D4);
 *   - the wire projections (`additionalProperties:false` shapes of the contract).
 *
 * Quantities are returned byte-identical to the report; the canonical form is
 * only ever used for comparison.
 */
import { z } from "zod";

/** RT-51 D4 — v1 constant: a snapshot older than this is `stale`. */
export const STALE_AFTER_SECONDS = 86_400;

/** The discrepancy kind of every row of this view (RT-51 D2). */
export const NEGATIVE_ON_HAND_KIND = "erpnext_negative_on_hand" as const;

/** Exact-decimal quantity as the Connector reports it (the 019 contract pattern). */
const QUANTITY_RE = /^(-?)([0-9]{1,15})(?:\.([0-9]{1,6}))?$/;
const SCALE_DIGITS = 6;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse an exact-decimal quantity string into integer millionths. Returns null
 * for anything that is not an exact-decimal string (never a float parse).
 */
export function toScaledQuantity(quantity: string): bigint | null {
  const m = QUANTITY_RE.exec(quantity);
  if (!m) return null;
  const [, sign, intPart, fracPart] = m;
  const frac = (fracPart ?? "").padEnd(SCALE_DIGITS, "0");
  const magnitude = BigInt(`${intPart}${frac}`);
  return sign === "-" ? -magnitude : magnitude;
}

/** True iff the quantity is strictly below zero (`-0.000000` is not). */
export function isStrictlyNegative(quantity: string): boolean {
  const scaled = toScaledQuantity(quantity);
  return scaled !== null && scaled < 0n;
}

// ---------------------------------------------------------------------------
// Report entries
// ---------------------------------------------------------------------------

/** One stored report entry as read back from `bin_view_report.entries`. */
export interface StoredReportEntry {
  readonly erpnextItemRef: unknown;
  readonly tenant_product_ref?: unknown;
  readonly quantity?: unknown;
  readonly stockUom?: unknown;
}

/** A stored entry with its 1-based position in the report. */
export interface PositionedEntry {
  readonly entry: StoredReportEntry;
  readonly ordinal: number;
}

/** A negative entry, normalized for ordering and projection. */
export interface NegativeEntry {
  readonly name: string;
  readonly quantity: string;
  readonly scaled: bigint;
  readonly stockUom: string;
  readonly tenantProductRef: string | null;
  readonly ordinal: number;
}

/** The stored ref is the item name (019); tolerate an `{ name }` object too. */
function itemName(ref: unknown): string | null {
  if (typeof ref === "string") return ref;
  if (ref !== null && typeof ref === "object") {
    const name = (ref as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return null;
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 140;
}

/**
 * Keep the entries strictly below zero, normalized and in view order. An entry
 * that is not a well-formed report entry cannot be shown inside the contract
 * shape and is skipped (the 019 report DTO already rejects such entries).
 */
export function negativeEntries(entries: readonly PositionedEntry[]): NegativeEntry[] {
  const out: NegativeEntry[] = [];
  for (const { entry, ordinal } of entries) {
    const name = itemName(entry.erpnextItemRef);
    const quantity = entry.quantity;
    if (!boundedText(name) || typeof quantity !== "string") continue;
    if (!boundedText(entry.stockUom)) continue;
    const scaled = toScaledQuantity(quantity);
    if (scaled === null || scaled >= 0n) continue;
    const ref = entry.tenant_product_ref;
    out.push({
      name,
      quantity,
      scaled,
      stockUom: entry.stockUom,
      tenantProductRef: typeof ref === "string" && UUID_RE.test(ref) ? ref : null,
      ordinal,
    });
  }
  return out.sort(compareEntries);
}

/** View order: quantity ascending, then item name, then report position. */
export function compareEntries(
  a: Pick<NegativeEntry, "scaled" | "name" | "ordinal">,
  b: Pick<NegativeEntry, "scaled" | "name" | "ordinal">,
): number {
  if (a.scaled !== b.scaled) return a.scaled < b.scaled ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.ordinal - b.ordinal;
}

// ---------------------------------------------------------------------------
// Opaque cursors
// ---------------------------------------------------------------------------

/** Raised for a cursor this operation did not issue → 400 validation_error. */
export class InvalidCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this operation");
    this.name = "InvalidCursorError";
  }
}

const StoreCursorSchema = z
  .object({ k: z.literal("s"), s: z.string().regex(UUID_RE) })
  .strict();

const ItemCursorSchema = z
  .object({
    k: z.literal("i"),
    q: z.string().regex(QUANTITY_RE),
    n: z.string().min(1).max(140),
    o: z.number().int().min(1),
  })
  .strict();

export interface ItemCursor {
  readonly scaled: bigint;
  readonly name: string;
  readonly ordinal: number;
}

function encode(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decode(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
}

export function encodeStoreCursor(storeId: string): string {
  return encode({ k: "s", s: storeId });
}

export function decodeStoreCursor(cursor: string): string {
  const parsed = StoreCursorSchema.safeParse(decode(cursor));
  if (!parsed.success) throw new InvalidCursorError();
  return parsed.data.s.toLowerCase();
}

export function encodeItemCursor(entry: NegativeEntry): string {
  return encode({ k: "i", q: entry.quantity, n: entry.name, o: entry.ordinal });
}

export function decodeItemCursor(cursor: string): ItemCursor {
  const parsed = ItemCursorSchema.safeParse(decode(cursor));
  if (!parsed.success) throw new InvalidCursorError();
  return {
    // The schema regex guarantees an exact-decimal string.
    scaled: toScaledQuantity(parsed.data.q)!,
    name: parsed.data.n,
    ordinal: parsed.data.o,
  };
}

/**
 * One keyset page of the ordered negative entries: the entries strictly after
 * `cursor`, at most `limit`, and the cursor of the last one when more follow.
 */
export function pageEntries(
  ordered: readonly NegativeEntry[],
  cursor: ItemCursor | null,
  limit: number,
): { page: NegativeEntry[]; nextCursor: string | null } {
  const after = cursor
    ? ordered.filter((e) => compareEntries(e, cursor) > 0)
    : ordered;
  const page = after.slice(0, limit);
  const nextCursor =
    after.length > limit ? encodeItemCursor(page[page.length - 1]!) : null;
  return { page, nextCursor };
}

// ---------------------------------------------------------------------------
// Snapshot freshness (RT-51 D4)
// ---------------------------------------------------------------------------

export type SnapshotStatusKind = "no_warehouse_mapping" | "no_snapshot" | "fresh" | "stale";

/** The usable snapshot of one store, as read from the database. */
export interface StoreSnapshotFacts {
  readonly runId: string;
  readonly erpnextWarehouseRef: string | null;
  readonly readAt: string | null;
  readonly recordedAt: string;
  readonly reportedEntryCount: number | null;
}

export interface PendingRequestFacts {
  readonly runId: string;
  readonly requestedAt: string;
}

export interface StockSnapshotStatus {
  readonly status: SnapshotStatusKind;
  readonly erpnextWarehouseRef: string | null;
  readonly runId: string | null;
  readonly readAt: string | null;
  readonly recordedAt: string | null;
  readonly staleAfterSeconds: number;
  readonly reportedEntryCount: number | null;
  readonly pendingRequest: { readonly runId: string; readonly requestedAt: string } | null;
}

/**
 * Classify a store's snapshot. No active `stock` map wins over any older
 * snapshot (RT-51 D4: the store is not mapped now). An unparseable
 * `recordedAt` cannot prove freshness and is reported `stale`.
 */
export function snapshotStatus(input: {
  readonly mappedWarehouseRef: string | null;
  readonly snapshot: StoreSnapshotFacts | null;
  readonly pending: PendingRequestFacts | null;
  readonly now: Date;
}): StockSnapshotStatus {
  if (input.mappedWarehouseRef === null) {
    return {
      status: "no_warehouse_mapping",
      erpnextWarehouseRef: null,
      runId: null,
      readAt: null,
      recordedAt: null,
      staleAfterSeconds: STALE_AFTER_SECONDS,
      reportedEntryCount: null,
      pendingRequest: null,
    };
  }
  const pendingRequest = input.pending
    ? { runId: input.pending.runId, requestedAt: input.pending.requestedAt }
    : null;
  const snap = input.snapshot;
  if (snap === null) {
    return {
      status: "no_snapshot",
      erpnextWarehouseRef: input.mappedWarehouseRef,
      runId: null,
      readAt: null,
      recordedAt: null,
      staleAfterSeconds: STALE_AFTER_SECONDS,
      reportedEntryCount: null,
      pendingRequest,
    };
  }
  const recordedMs = Date.parse(snap.recordedAt);
  const fresh =
    !Number.isNaN(recordedMs) &&
    input.now.getTime() - recordedMs <= STALE_AFTER_SECONDS * 1000;
  return {
    status: fresh ? "fresh" : "stale",
    erpnextWarehouseRef: snap.erpnextWarehouseRef ?? input.mappedWarehouseRef,
    runId: snap.runId,
    readAt: snap.readAt,
    recordedAt: snap.recordedAt,
    staleAfterSeconds: STALE_AFTER_SECONDS,
    reportedEntryCount: snap.reportedEntryCount,
    pendingRequest,
  };
}

/** True when the status carries a snapshot whose items are served. */
export function servesItems(status: StockSnapshotStatus): boolean {
  return status.status === "fresh" || status.status === "stale";
}

// ---------------------------------------------------------------------------
// Wire shapes (contract: reconciliation.yaml, RT-177)
// ---------------------------------------------------------------------------

export interface NegativeOnHandItem {
  readonly discrepancyKind: typeof NEGATIVE_ON_HAND_KIND;
  readonly erpnextItemRef: { readonly doctype: "Item"; readonly name: string };
  readonly mappingStatus: "mapped" | "unmapped";
  readonly tenantProduct: { readonly id: string; readonly name: string } | null;
  readonly erpnextWarehouseRef: string;
  readonly quantity: string;
  readonly stockUom: string;
}

export interface StoreNegativeOnHandSummary {
  readonly storeId: string;
  readonly storeName: string;
  readonly snapshot: StockSnapshotStatus;
  readonly negativeItemCount: number;
}

export interface StoreNegativeOnHandSummaryPage {
  readonly items: readonly StoreNegativeOnHandSummary[];
  readonly nextCursor: string | null;
}

export interface StoreNegativeOnHandPage {
  readonly storeId: string;
  readonly snapshot: StockSnapshotStatus;
  readonly items: readonly NegativeOnHandItem[];
  readonly nextCursor: string | null;
}

/**
 * Project a negative entry. `mapped` needs both the snapshot's resolved product
 * ref and a product row to name it; otherwise the entry is `unmapped` with a
 * null product (the contract's "null iff unmapped").
 */
export function toNegativeOnHandItem(
  entry: NegativeEntry,
  warehouseRef: string,
  productNames: ReadonlyMap<string, string>,
): NegativeOnHandItem {
  const productName =
    entry.tenantProductRef !== null ? productNames.get(entry.tenantProductRef) : undefined;
  const tenantProduct =
    entry.tenantProductRef !== null && productName !== undefined
      ? { id: entry.tenantProductRef, name: productName }
      : null;
  return {
    discrepancyKind: NEGATIVE_ON_HAND_KIND,
    erpnextItemRef: { doctype: "Item", name: entry.name },
    mappingStatus: tenantProduct ? "mapped" : "unmapped",
    tenantProduct,
    erpnextWarehouseRef: warehouseRef,
    quantity: entry.quantity,
    stockUom: entry.stockUom,
  };
}
