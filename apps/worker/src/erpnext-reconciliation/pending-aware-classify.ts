/**
 * RT-428 — the pending-aware class of one (store, product) line of a tenant
 * with activated sale effects (RT-289 DC-7; Reconciliation 923–930).
 *
 *   expected_erp_book = operational_position − Σ(pending ERP terms) − Σ(pending Retail terms)
 *
 * The exact-decimal sums are computed in SQL (NUMERIC, never a JS number, §III);
 * this function only orders the checks and compares canonical strings. It is
 * explanatory: it never changes an effect or ERP stock.
 */
import { canonicalDecimal } from "./canonical-decimal";

/** The classes a pending-aware line can take (014 vocabulary + 927–929 + UOM). */
export type PendingAwareClass =
  | "match"
  | "expected_pending_erp"
  | "expected_pending_retail"
  | "erp_snapshot_stale"
  | "quantity_divergence"
  | "uom_mismatch"
  | "unmapped_item"
  | "dp2_only"
  | "negative_balance_flagged";

export interface PendingAwareLine {
  /** Anchor quantity plus every effect recorded since the anchor. */
  readonly operationalPosition: string;
  /** Σ effects with an ERP intent ERPNext has not booked (pending, rejected, reconciliation_required). */
  readonly pendingErp: string;
  /** Σ Retail effects with no ERP intent yet (not_posted). */
  readonly pendingRetail: string;
  /** operationalPosition − pendingErp − pendingRetail. */
  readonly expectedErpBook: string;
  /** The Bin quantity; undefined when the snapshot has no entry for the product. */
  readonly binQty: string | undefined;
  readonly hasConfirmedMap: boolean;
  /** The operational unit differs from the Bin stock UOM (M-6). */
  readonly uomMismatch: boolean;
  /** The snapshot was read before an effect's erp_confirmed_at (929). */
  readonly snapshotStale: boolean;
}

const isZero = (value: string): boolean => canonicalDecimal(value) === "0";

/**
 * Order: negative, unmapped, presence, UOM (never a quantity class), then the
 * expected-book compare: equal → in sync or the pending term that explains the
 * gap; unequal → stale snapshot, else unexplained divergence.
 */
export function classifyPendingAware(line: PendingAwareLine): PendingAwareClass {
  if (canonicalDecimal(line.operationalPosition).startsWith("-")) return "negative_balance_flagged";
  if (!line.hasConfirmedMap) return "unmapped_item";
  if (line.binQty === undefined) return "dp2_only";
  if (line.uomMismatch) return "uom_mismatch";
  return compareExpectedBook(line, line.binQty);
}

/** The expected-book compare of a mapped line with a Bin entry in the same unit. */
function compareExpectedBook(line: PendingAwareLine, binQty: string): PendingAwareClass {
  if (canonicalDecimal(line.expectedErpBook) !== canonicalDecimal(binQty)) {
    return line.snapshotStale ? "erp_snapshot_stale" : "quantity_divergence";
  }
  if (!isZero(line.pendingErp)) return "expected_pending_erp";
  return isZero(line.pendingRetail) ? "match" : "expected_pending_retail";
}
