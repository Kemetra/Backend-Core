/**
 * Pending-aware operational position and the cutover equivalence report
 * (Jira RT-428; RT-289 DC-7; decisions 923–930, 977, 980).
 *
 * Per ERP mapping boundary — V1: one bucket per store (Gate 4 Q2), grain
 * (tenant, bucket, item) — the expected ERP book is
 *
 *   expected_erp_book = operational_position − pending ERP − pending Retail
 *
 * where operational_position is the store's latest Inventory Anchor plus every
 * effect it does not cover (RT-427, `SINCE_ANCHOR`), and the terms sum the
 * effects since the anchor by integration state:
 *   - pending ERP: an ERP intent exists that ERPNext has not booked as-is —
 *     `pending`, `rejected`, and `reconciliation_required` (its ERP document
 *     differs; no ERP-side quantity is recorded, so the whole effect counts);
 *   - pending Retail: a Retail effect with no ERP intent yet — `not_posted`
 *     (an effect without an integration row is treated the same);
 *   - `confirmed` and `external` are ERP book already; `erp_neutral` nets to
 *     zero per bucket (Gate 4 Q10). None is a term.
 *
 * Only tenants with activated sale effects have an anchor-based position. For
 * every other tenant (and a store created after activation, which has no
 * anchor) the reads return no row and 017 keeps its legacy raw-SUM comparison.
 *
 * Read-only: both run on the caller's client under its tenant context (RLS)
 * and never write an effect, an integration row or ERP stock. Quantities are
 * exact NUMERIC text, never a JS number.
 */
import type { PoolClient } from "pg";

import { LATEST_BIN_CTES, SINCE_ANCHOR } from "./activation";

export interface PendingAwarePosition {
  readonly storeId: string;
  readonly tenantProductRef: string;
  readonly anchorGeneration: number;
  /** The anchor's Bin quantity (0 when the product had no Bin entry). */
  readonly anchorQuantity: string;
  /** Anchor quantity plus every effect it does not cover. */
  readonly operationalPosition: string;
  readonly pendingErp: string;
  readonly pendingRetail: string;
  readonly expectedErpBook: string;
  /** The latest erp_confirmed_at of a confirmed effect since the anchor (929 input). */
  readonly latestErpConfirmedAt: string | null;
  /** The effects' stocking unit; null without an effect since the anchor. */
  readonly operationalUnit: string | null;
  /** The anchor line's ERP stock UOM; null without an anchor line. */
  readonly erpStockUom: string | null;
  /** The legacy 017 operational side: the raw SUM of every movement of the store. */
  readonly legacyOnHand: string;
}

/**
 * CTE bodies (no WITH): `anchor` (latest generation per store of an activated
 * tenant, optionally one store $1), `moves`, `keys`, `legacy` and `positions`.
 */
const POSITIONS_CTES = `
anchor AS (
  SELECT DISTINCT ON (a.store_id) a.id, a.store_id, a.generation, a.activated_at
    FROM inventory_anchors a
    JOIN tenant_inventory_settings s
      ON s.tenant_id = a.tenant_id AND s.sale_effects_activated_at IS NOT NULL
   WHERE ($1::uuid IS NULL OR a.store_id = $1::uuid)
   ORDER BY a.store_id, a.generation DESC
),
moves AS (
  SELECT anchor.store_id, mv.tenant_product_ref AS product,
         sum(mv.quantity) AS total,
         COALESCE(sum(mv.quantity) FILTER (WHERE i.state IN ('pending', 'rejected', 'reconciliation_required')), 0)
           AS pending_erp,
         COALESCE(sum(mv.quantity) FILTER (WHERE i.state IS NULL OR i.state = 'not_posted'), 0) AS pending_retail,
         max(i.erp_confirmed_at) AS latest_confirmed_at,
         min(mv.stocking_unit) AS unit
    FROM anchor
    JOIN stock_movements mv ON mv.store_id = anchor.store_id AND ${SINCE_ANCHOR}
    LEFT JOIN inventory_effect_integration i ON i.effect_id = mv.id
   WHERE mv.tenant_product_ref IS NOT NULL
   GROUP BY anchor.store_id, mv.tenant_product_ref
),
keys AS (
  SELECT anchor.store_id, l.tenant_product_ref AS product FROM anchor
    JOIN inventory_anchor_lines l ON l.anchor_id = anchor.id
  UNION SELECT store_id, product FROM moves
),
legacy AS (
  SELECT sm.store_id, sm.tenant_product_ref AS product, sum(sm.quantity) AS on_hand
    FROM anchor JOIN stock_movements sm ON sm.store_id = anchor.store_id
   WHERE sm.tenant_product_ref IS NOT NULL
   GROUP BY sm.store_id, sm.tenant_product_ref
),
positions AS (
  SELECT k.store_id, k.product, anchor.generation,
         COALESCE(l.quantity, 0) AS anchor_quantity,
         COALESCE(l.quantity, 0) + COALESCE(m.total, 0) AS position,
         COALESCE(m.pending_erp, 0) AS pending_erp,
         COALESCE(m.pending_retail, 0) AS pending_retail,
         COALESCE(l.quantity, 0) + COALESCE(m.total, 0)
           - COALESCE(m.pending_erp, 0) - COALESCE(m.pending_retail, 0) AS expected,
         m.latest_confirmed_at, m.unit, l.erp_stock_uom,
         COALESCE(lg.on_hand, 0) AS legacy_on_hand
    FROM keys k
    JOIN anchor ON anchor.store_id = k.store_id
    LEFT JOIN inventory_anchor_lines l ON l.anchor_id = anchor.id AND l.tenant_product_ref = k.product
    LEFT JOIN moves m ON m.store_id = k.store_id AND m.product = k.product
    LEFT JOIN legacy lg ON lg.store_id = k.store_id AND lg.product = k.product
)`;

const POSITION_COLUMNS = `
  p.store_id, p.product AS tenant_product_ref, p.generation,
  p.anchor_quantity::text, p.position::text AS operational_position,
  p.pending_erp::text, p.pending_retail::text, p.expected::text AS expected_erp_book,
  p.latest_confirmed_at, p.unit, p.erp_stock_uom, p.legacy_on_hand::text`;

interface PositionDbRow {
  store_id: string;
  tenant_product_ref: string;
  generation: number;
  anchor_quantity: string;
  operational_position: string;
  pending_erp: string;
  pending_retail: string;
  expected_erp_book: string;
  latest_confirmed_at: Date | null;
  unit: string | null;
  erp_stock_uom: string | null;
  legacy_on_hand: string;
}

function toPosition(row: PositionDbRow): PendingAwarePosition {
  return {
    storeId: row.store_id,
    tenantProductRef: row.tenant_product_ref,
    anchorGeneration: row.generation,
    anchorQuantity: row.anchor_quantity,
    operationalPosition: row.operational_position,
    pendingErp: row.pending_erp,
    pendingRetail: row.pending_retail,
    expectedErpBook: row.expected_erp_book,
    latestErpConfirmedAt: row.latest_confirmed_at?.toISOString() ?? null,
    operationalUnit: row.unit,
    erpStockUom: row.erp_stock_uom,
    legacyOnHand: row.legacy_on_hand,
  };
}

/**
 * Whether 017 compares this store pending-aware: its tenant has activated sale
 * effects and the store has an anchor. True even when no product has a
 * position yet (an anchor with no line and no effect since).
 */
export async function isStorePendingAware(client: Pick<PoolClient, "query">, storeId: string): Promise<boolean> {
  const r = await client.query<{ aware: boolean }>(
    `WITH ${POSITIONS_CTES} SELECT EXISTS (SELECT 1 FROM anchor) AS aware`,
    [storeId],
  );
  return r.rows[0]!.aware;
}

/**
 * The pending-aware position of every product of one store (or of every
 * anchored store when `storeId` is null). Empty when the tenant has not
 * activated sale effects or the store has no anchor.
 */
export async function readPendingAwarePositions(
  client: Pick<PoolClient, "query">,
  storeId: string | null,
): Promise<PendingAwarePosition[]> {
  const r = await client.query<PositionDbRow>(
    `WITH ${POSITIONS_CTES}
     SELECT ${POSITION_COLUMNS} FROM positions p ORDER BY p.store_id, p.product`,
    [storeId],
  );
  return r.rows.map(toPosition);
}

export interface CutoverEquivalenceRow extends PendingAwarePosition {
  /** The latest complete Bin snapshot's quantity; null when it has no entry. */
  readonly latestBinQuantity: string | null;
  readonly snapshotReadAt: string | null;
  /** latestBin − legacyOnHand (what 017 compares today); null without a Bin entry. */
  readonly legacyDifference: string | null;
  /** latestBin − expectedErpBook; null without a Bin entry. */
  readonly pendingAwareDifference: string | null;
  /** The pending-aware expected book equals the ERP-confirmed Bin. */
  readonly equivalent: boolean;
  /** The snapshot was read before an effect's ERP confirmation (929). */
  readonly snapshotStale: boolean;
}

interface EquivalenceDbRow extends PositionDbRow {
  bin_quantity: string | null;
  read_at: Date | null;
  legacy_difference: string | null;
  pending_aware_difference: string | null;
  equivalent: boolean;
  snapshot_stale: boolean;
}

/**
 * The dual-read equivalence report for the sale-effect activation cutover
 * (977, 980): per anchored store and product, the legacy raw SUM and the
 * pending-aware expected ERP book side by side against the latest complete
 * Bin snapshot. Read-only evidence; it decides nothing.
 */
export async function buildCutoverEquivalenceReport(
  client: Pick<PoolClient, "query">,
): Promise<CutoverEquivalenceRow[]> {
  const r = await client.query<EquivalenceDbRow>(
    `WITH ${POSITIONS_CTES}, ${LATEST_BIN_CTES}
     SELECT ${POSITION_COLUMNS},
            b.quantity::text AS bin_quantity, b.read_at,
            (b.quantity - p.legacy_on_hand)::text AS legacy_difference,
            (b.quantity - p.expected)::text AS pending_aware_difference,
            COALESCE(b.quantity = p.expected, false) AS equivalent,
            COALESCE(b.read_at < p.latest_confirmed_at, false) AS snapshot_stale
       FROM positions p
       LEFT JOIN bin b ON b.store_id = p.store_id AND b.product = p.product
      ORDER BY p.store_id, p.product`,
    [null],
  );
  return r.rows.map((row) => ({
    ...toPosition(row),
    latestBinQuantity: row.bin_quantity,
    snapshotReadAt: row.read_at?.toISOString() ?? null,
    legacyDifference: row.legacy_difference,
    pendingAwareDifference: row.pending_aware_difference,
    equivalent: row.equivalent,
    snapshotStale: row.snapshot_stale,
  }));
}
