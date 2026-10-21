/**
 * Sale-effects activation with the Inventory Anchor, and the read-only
 * anchor-vs-Bin comparison (Jira RT-427; RT-289 Q3, Q4, DC-8; decisions
 * 778–787, 977, 980; owner decisions 3, 4 and 6 of 2026-10-21).
 *
 * Both run on the CALLER's client inside one transaction with the tenant's
 * `app.current_tenant` set (RLS); the CLI (`src/cli/inventory-effects.ts`)
 * opens it.
 *
 * Activation (tenant-wide, decision 6), all or nothing:
 *   1. takes the tenant settings key EXCLUSIVE, so it waits for every
 *      in-flight sale / void / return writer (they hold it SHARED) and every
 *      later writer sees the committed flag;
 *   2. refuses (decision 3) unless every live store has an active `stock`
 *      warehouse map and a complete Bin snapshot of THAT warehouse, read after
 *      the store's last posted ERP document, with no posting row still
 *      `pending` / `failed_transient` and no `erpnext.posting.requested`
 *      intent undelivered — so no sale processed before activation can reach
 *      ERPNext after the snapshot without an effect;
 *   3. writes, per store, the next-generation Inventory Anchor from that
 *      snapshot: one line per Bin item that maps to exactly one confirmed
 *      Retail product, the Bin quantity exactly as reported. Its coverage
 *      records the pre-activation movements it absorbs (Q3) and the Bin items
 *      with no Retail product;
 *   4. sets `sale_effects_activated_at` / `_by`. No sale is backfilled (DC-8)
 *      and no movement is written: the anchor is metadata (779).
 *
 * Comparison (decision 4): per store and product, the latest anchor plus every
 * effect recorded since activation, against the latest complete Bin snapshot.
 * It is NOT pending-aware (effects not yet confirmed by ERPNext are listed,
 * not subtracted) — the pending-aware reconciliation is RT-428.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { INVENTORY_SETTINGS_LOCK_NAMESPACE } from "./sale-effects";

export type ActivationRefusalCode =
  | "already_active"
  | "no_stores"
  | "store_unmapped"
  | "no_snapshot"
  | "snapshot_remapped"
  | "snapshot_stale"
  | "postings_in_flight"
  | "posting_intents_undelivered";

export interface ActivationRefusal {
  readonly code: ActivationRefusalCode;
  /** The stores that fail the precondition (empty for tenant-wide codes). */
  readonly storeIds: readonly string[];
}

export interface AnchoredStore {
  readonly storeId: string;
  readonly anchorId: string;
  readonly generation: number;
  readonly sourceRunId: string;
  readonly lines: number;
  readonly unmappedBinItems: number;
  readonly absorbedMovements: number;
}

export type ActivationOutcome =
  | { readonly kind: "activated"; readonly activatedAt: string; readonly stores: readonly AnchoredStore[] }
  | { readonly kind: "refused"; readonly refusal: ActivationRefusal };

export interface ActivateSaleEffectsInput {
  readonly tenantId: string;
  /** The operator who activates (a user id; recorded on the flag and anchors). */
  readonly actorId: string;
}

/** A Bin report usable as a snapshot (the RT-177 negative-on-hand rule). */
export const USABLE_REPORT = `(jsonb_typeof(r.summary->'bin_view_report') = 'object'
       AND jsonb_typeof(r.summary->'bin_view_report'->'recordedAt') = 'string'
       AND (r.summary->'bin_view_report'->'complete') IS DISTINCT FROM 'false'::jsonb)`;

/**
 * An intent the posting consumer has not turned into a posting row yet. It is
 * a sub-select of STORE_FACTS_SQL, so it and the `in_flight` posting rows are
 * read from ONE statement snapshot: a consumer that inserts the posting row and
 * then marks the event delivered cannot slip between two separate checks.
 */
const UNDELIVERED_INTENTS_SQL = `
SELECT count(*)::int FROM outbox_events o
 WHERE o.event_type = 'erpnext.posting.requested'
   AND (o.delivery_state IN ('pending', 'claimed', 'failed')
        OR (o.delivery_state = 'dead_lettered'
            AND NOT EXISTS (SELECT 1 FROM erpnext_posting_status p
                             WHERE p.tenant_id = o.tenant_id
                               AND p.source_ref_id::text = o.payload->>'source_ref_id')))`;

/** Per live store: its stock map, primary location and newest usable snapshot. */
const STORE_FACTS_SQL = `
WITH snap AS (
  SELECT DISTINCT ON (r.store_id) r.store_id, r.id, r.summary->'bin_view_report' AS report
    FROM erpnext_reconciliation_run r
   WHERE r.kind = 'stock' AND ${USABLE_REPORT}
   ORDER BY r.store_id, (r.summary->'bin_view_report'->>'recordedAt')::timestamptz DESC, r.id DESC
)
SELECT s.id AS store_id,
       whm.erpnext_warehouse_ref AS mapped_ref,
       loc.id AS primary_location_id,
       snap.id AS run_id,
       snap.report->>'erpnextWarehouseRef' AS snap_ref,
       (snap.report->>'readAt')::timestamptz AS read_at,
       (snap.report->>'recordedAt')::timestamptz AS recorded_at,
       (SELECT max(COALESCE(p.posted_at, p.updated_at)) FROM erpnext_posting_status p
         WHERE p.store_id = s.id AND p.status = 'posted') AS last_posted_at,
       EXISTS (SELECT 1 FROM erpnext_posting_status p
                WHERE p.store_id = s.id AND p.status IN ('pending', 'failed_transient')) AS in_flight,
       (${UNDELIVERED_INTENTS_SQL}) AS undelivered
  FROM stores s
  LEFT JOIN erpnext_warehouse_map whm
         ON whm.store_id = s.id AND whm.purpose = 'stock' AND whm.retired_at IS NULL
  LEFT JOIN stock_locations loc ON loc.store_id = s.id AND loc.kind = 'primary'
  LEFT JOIN snap ON snap.store_id = s.id
 WHERE s.deleted_at IS NULL
 ORDER BY s.id`;

interface StoreFactsRow {
  store_id: string;
  mapped_ref: string | null;
  primary_location_id: string;
  run_id: string | null;
  snap_ref: string | null;
  read_at: Date | null;
  recorded_at: Date | null;
  last_posted_at: Date | null;
  in_flight: boolean;
  /** Tenant-wide; read in the same statement (one snapshot) as `in_flight`. */
  undelivered: number;
}

function refused(code: ActivationRefusalCode, storeIds: readonly string[] = []): ActivationOutcome {
  return { kind: "refused", refusal: { code, storeIds } };
}

/** The first failing precondition, in decision-3 order, or null. */
function preconditionRefusal(stores: readonly StoreFactsRow[]): ActivationOutcome | null {
  if (stores.length === 0) return refused("no_stores");
  const failing = (test: (s: StoreFactsRow) => boolean): string[] => stores.filter(test).map((s) => s.store_id);
  const checks: Array<[ActivationRefusalCode, (s: StoreFactsRow) => boolean]> = [
    ["store_unmapped", (s) => s.mapped_ref === null],
    ["no_snapshot", (s) => s.run_id === null],
    ["snapshot_remapped", (s) => s.snap_ref !== s.mapped_ref],
    ["postings_in_flight", (s) => s.in_flight],
    ["snapshot_stale", (s) => s.last_posted_at !== null && s.read_at! <= s.last_posted_at],
  ];
  for (const [code, test] of checks) {
    const ids = failing(test);
    if (ids.length > 0) return refused(code, ids);
  }
  return stores[0]!.undelivered > 0 ? refused("posting_intents_undelivered") : null;
}

/**
 * Activate sale effects for the tenant (see the file header). On refusal
 * nothing is written; the caller should still roll back.
 */
export async function activateSaleEffects(
  client: Pick<PoolClient, "query">,
  input: ActivateSaleEffectsInput,
): Promise<ActivationOutcome> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`, [
    INVENTORY_SETTINGS_LOCK_NAMESPACE,
    input.tenantId,
  ]);
  const current = await client.query<{ active: boolean }>(
    `SELECT sale_effects_activated_at IS NOT NULL AS active FROM tenant_inventory_settings
      WHERE tenant_id = $1 FOR UPDATE`,
    [input.tenantId],
  );
  if (current.rows[0]?.active === true) return refused("already_active");

  const stores = (await client.query<StoreFactsRow>(STORE_FACTS_SQL)).rows;
  const refusal = preconditionRefusal(stores);
  if (refusal !== null) return refusal;

  const now = (await client.query<{ now: Date }>(`SELECT now() AS now`)).rows[0]!.now;
  const anchored: AnchoredStore[] = [];
  for (const store of stores) anchored.push(await writeAnchor(client, input, store, now));
  await client.query(
    `INSERT INTO tenant_inventory_settings
       (tenant_id, updated_by, sale_effects_activated_at, sale_effects_activated_by)
     VALUES ($1, $2, $3, $2)
     ON CONFLICT (tenant_id) DO UPDATE
       SET sale_effects_activated_at = EXCLUDED.sale_effects_activated_at,
           sale_effects_activated_by = EXCLUDED.sale_effects_activated_by,
           updated_by = EXCLUDED.updated_by`,
    [input.tenantId, input.actorId, now],
  );
  return { kind: "activated", activatedAt: now.toISOString(), stores: anchored };
}

/** What a store's anchor covers (781): the absorbed movements and the snapshot's Items. */
interface AnchorCoverage {
  readonly absorbedMovements: number;
  readonly lastReceivedAt: string | null;
  readonly binEntries: number;
  readonly mappedItems: number;
  readonly generation: number;
}

/** Read the coverage and the next generation of one store's anchor. */
async function readAnchorCoverage(client: Pick<PoolClient, "query">, store: StoreFactsRow): Promise<AnchorCoverage> {
  const r = await client.query<{ n: number; last_received_at: Date | null; entries: number; mapped: number; g: number }>(
    `${SNAPSHOT_ITEMS_CTE}
     SELECT (SELECT count(*)::int FROM stock_movements WHERE store_id = $2) AS n,
            (SELECT max(received_at) FROM stock_movements WHERE store_id = $2) AS last_received_at,
            (SELECT count(*)::int FROM entries) AS entries,
            (SELECT count(*)::int FROM mapped) AS mapped,
            (SELECT COALESCE(max(generation), 0) + 1 FROM inventory_anchors WHERE store_id = $2) AS g`,
    [store.run_id, store.store_id],
  );
  const row = r.rows[0]!;
  return {
    absorbedMovements: row.n,
    lastReceivedAt: row.last_received_at?.toISOString() ?? null,
    binEntries: row.entries,
    mappedItems: row.mapped,
    generation: row.g,
  };
}

/** One store's next-generation anchor and its lines, from its snapshot. */
async function writeAnchor(
  client: Pick<PoolClient, "query">,
  input: ActivateSaleEffectsInput,
  store: StoreFactsRow,
  activatedAt: Date,
): Promise<AnchoredStore> {
  const c = await readAnchorCoverage(client, store);
  const anchorId = randomUUID();
  const coverage = {
    preActivationMovements: { count: c.absorbedMovements, lastReceivedAt: c.lastReceivedAt },
    binEntries: c.binEntries,
    unmappedBinItems: c.binEntries - c.mappedItems,
  };
  await client.query(
    `INSERT INTO inventory_anchors
       (id, tenant_id, store_id, stock_location_id, inventory_status, generation, source_run_id,
        snapshot_read_at, snapshot_recorded_at, erpnext_warehouse_ref, activated_at, coverage, created_by)
     VALUES ($1, $2, $3, $4, 'sellable', $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
    [
      anchorId,
      input.tenantId,
      store.store_id,
      store.primary_location_id,
      c.generation,
      store.run_id,
      store.read_at,
      store.recorded_at,
      store.snap_ref,
      activatedAt,
      JSON.stringify(coverage),
      input.actorId,
    ],
  );
  await client.query(
    `${SNAPSHOT_ITEMS_CTE}
     INSERT INTO inventory_anchor_lines
       (id, anchor_id, tenant_id, tenant_product_ref, quantity, erp_stock_uom, erpnext_item_ref)
     SELECT gen_random_uuid(), $2, $3, mapped.product, mapped.quantity, mapped.uom, mapped.item
       FROM mapped`,
    [store.run_id, anchorId, input.tenantId],
  );
  return {
    storeId: store.store_id,
    anchorId,
    generation: c.generation,
    sourceRunId: store.run_id!,
    lines: c.mappedItems,
    unmappedBinItems: c.binEntries - c.mappedItems,
    absorbedMovements: c.absorbedMovements,
  };
}

/**
 * `entries`: the snapshot's Bin entries of run $1 (first entry per Item);
 * `mapped`: those whose Item maps to exactly one confirmed, active Retail
 * product (an ambiguous or unmapped Item has no operational position), carries
 * a stock UOM and whose quantity fits `inventory_anchor_lines.quantity`
 * (NUMERIC(21,6)) exactly. An entry that would be rounded is left out of the
 * anchor, like an effect line that cannot be written exactly, and counts as
 * unmapped in the coverage.
 */
const SNAPSHOT_ITEMS_CTE = `
WITH entries AS (
  SELECT DISTINCT ON (item) item, quantity, uom FROM (
    SELECT COALESCE(e.value->'erpnextItemRef'->>'name', e.value->>'erpnextItemRef') AS item,
           (e.value->>'quantity')::numeric AS quantity, e.value->>'stockUom' AS uom, e.ordinality
      FROM erpnext_reconciliation_run r,
           jsonb_array_elements(r.summary->'bin_view_report'->'entries') WITH ORDINALITY AS e(value, ordinality)
     WHERE r.id = $1) x
   ORDER BY item, ordinality
),
mapped AS (
  SELECT e.item, e.quantity, e.uom, min(m.tenant_product_id::text)::uuid AS product
    FROM entries e
    JOIN erpnext_item_map m
      ON m.erpnext_item_ref = e.item AND m.state = 'confirmed' AND m.retired_at IS NULL
   WHERE e.uom IS NOT NULL AND e.quantity = round(e.quantity, 6)
   GROUP BY e.item, e.quantity, e.uom
  HAVING count(*) = 1
)`;

// ---------------------------------------------------------------------------
// Read-only comparison (decision 4)
// ---------------------------------------------------------------------------

export interface AnchorComparisonRow {
  readonly storeId: string;
  readonly tenantProductRef: string;
  readonly anchorGeneration: number;
  /** The anchor's Bin quantity (0 when the product had no Bin entry). */
  readonly anchorQuantity: string;
  /** Every effect recorded at the store since activation. */
  readonly effectsSinceAnchor: string;
  /** Of those, the ones ERPNext has not confirmed yet (listed, not subtracted). */
  readonly unconfirmedEffects: string;
  readonly expectedQuantity: string;
  /** The latest complete Bin snapshot's quantity; null when it has no entry. */
  readonly latestBinQuantity: string | null;
  readonly latestSnapshotRecordedAt: string | null;
  /** latestBin − expected; null without a Bin entry. */
  readonly difference: string | null;
  /** The effects' unit differs from the ERP stock UOM (M-6: a finding, not a divergence). */
  readonly uomMismatch: boolean;
}

/**
 * The movements an anchor does not cover. Sale, void and return effects exist
 * only once the flag is ON, so they are all counted: a writer that began before
 * activation and waited on the settings lock writes them with a
 * transaction-start received_at EARLIER than activated_at. The watermark only
 * selects the other movements. Expects `mv` (stock_movements) and `anchor`.
 */
export const SINCE_ANCHOR = `(mv.event_type IN ('sale', 'sale_void', 'sale_return') OR mv.received_at >= anchor.activated_at)`;

/**
 * `snap`: each store's latest complete Bin snapshot; `unique_map`: Items that
 * map to exactly one confirmed product (the anchor's rule: an ambiguous Item is
 * attributed to none); `bin`: the snapshot's first entry per such Item, as
 * SNAPSHOT_ITEMS_CTE keeps for the anchor. CTE bodies only (no WITH).
 */
export const LATEST_BIN_CTES = `
snap AS (
  SELECT DISTINCT ON (r.store_id) r.store_id, r.id,
         (r.summary->'bin_view_report'->>'recordedAt')::timestamptz AS recorded_at,
         (r.summary->'bin_view_report'->>'readAt')::timestamptz AS read_at
    FROM erpnext_reconciliation_run r
   WHERE r.kind = 'stock' AND ${USABLE_REPORT}
   ORDER BY r.store_id, (r.summary->'bin_view_report'->>'recordedAt')::timestamptz DESC, r.id DESC
),
unique_map AS (
  SELECT m.erpnext_item_ref AS item, min(m.tenant_product_id::text)::uuid AS product
    FROM erpnext_item_map m
   WHERE m.state = 'confirmed' AND m.retired_at IS NULL
   GROUP BY m.erpnext_item_ref
  HAVING count(*) = 1
),
bin AS (
  SELECT DISTINCT ON (snap.store_id, um.item) snap.store_id, snap.recorded_at, snap.read_at, um.product,
         (e.value->>'quantity')::numeric AS quantity, e.value->>'stockUom' AS uom
    FROM snap
    JOIN erpnext_reconciliation_run r ON r.id = snap.id
    CROSS JOIN LATERAL jsonb_array_elements(r.summary->'bin_view_report'->'entries')
         WITH ORDINALITY AS e(value, ordinality)
    JOIN unique_map um
      ON um.item = COALESCE(e.value->'erpnextItemRef'->>'name', e.value->>'erpnextItemRef')
   ORDER BY snap.store_id, um.item, e.ordinality
)`;

const COMPARISON_SQL = `
WITH anchor AS (
  SELECT DISTINCT ON (a.store_id) a.id, a.store_id, a.generation, a.activated_at
    FROM inventory_anchors a ORDER BY a.store_id, a.generation DESC
),
${LATEST_BIN_CTES},
moves AS (
  SELECT anchor.store_id, mv.tenant_product_ref AS product,
         sum(mv.quantity) AS total,
         sum(mv.quantity) FILTER (WHERE i.state IS DISTINCT FROM 'confirmed'
                                    AND i.state IS DISTINCT FROM 'erp_neutral') AS unconfirmed,
         min(mv.stocking_unit) AS unit
    FROM anchor
    -- SINCE_ANCHOR: every sale / void / return effect, other movements from the watermark.
    JOIN stock_movements mv ON mv.store_id = anchor.store_id AND ${SINCE_ANCHOR}
    LEFT JOIN inventory_effect_integration i ON i.effect_id = mv.id
   WHERE mv.tenant_product_ref IS NOT NULL
   GROUP BY anchor.store_id, mv.tenant_product_ref
),
keys AS (
  SELECT anchor.store_id, l.tenant_product_ref AS product FROM anchor
    JOIN inventory_anchor_lines l ON l.anchor_id = anchor.id
  UNION SELECT store_id, product FROM moves
  UNION SELECT store_id, product FROM bin
)
SELECT k.store_id, k.product AS tenant_product_ref, anchor.generation,
       COALESCE(l.quantity, 0)::text AS anchor_quantity,
       COALESCE(moves.total, 0)::text AS effects_since_anchor,
       COALESCE(moves.unconfirmed, 0)::text AS unconfirmed_effects,
       (COALESCE(l.quantity, 0) + COALESCE(moves.total, 0))::text AS expected_quantity,
       bin.quantity::text AS latest_bin_quantity,
       bin.recorded_at AS latest_snapshot_recorded_at,
       (bin.quantity - COALESCE(l.quantity, 0) - COALESCE(moves.total, 0))::text AS difference,
       COALESCE(moves.unit IS NOT NULL AND COALESCE(bin.uom, l.erp_stock_uom) IS NOT NULL
                AND moves.unit <> COALESCE(bin.uom, l.erp_stock_uom), false) AS uom_mismatch
  FROM keys k
  JOIN anchor ON anchor.store_id = k.store_id
  LEFT JOIN inventory_anchor_lines l ON l.anchor_id = anchor.id AND l.tenant_product_ref = k.product
  LEFT JOIN moves ON moves.store_id = k.store_id AND moves.product = k.product
  LEFT JOIN bin ON bin.store_id = k.store_id AND bin.product = k.product
 ORDER BY k.store_id, k.product`;

interface ComparisonDbRow {
  store_id: string;
  tenant_product_ref: string;
  generation: number;
  anchor_quantity: string;
  effects_since_anchor: string;
  unconfirmed_effects: string;
  expected_quantity: string;
  latest_bin_quantity: string | null;
  latest_snapshot_recorded_at: Date | null;
  difference: string | null;
  uom_mismatch: boolean;
}

/** The read-only anchor-plus-effects vs latest-Bin comparison of every anchored store. */
export async function compareAnchorsToBin(client: Pick<PoolClient, "query">): Promise<AnchorComparisonRow[]> {
  const r = await client.query<ComparisonDbRow>(COMPARISON_SQL);
  return r.rows.map((row) => ({
    storeId: row.store_id,
    tenantProductRef: row.tenant_product_ref,
    anchorGeneration: row.generation,
    anchorQuantity: row.anchor_quantity,
    effectsSinceAnchor: row.effects_since_anchor,
    unconfirmedEffects: row.unconfirmed_effects,
    expectedQuantity: row.expected_quantity,
    latestBinQuantity: row.latest_bin_quantity,
    latestSnapshotRecordedAt: row.latest_snapshot_recorded_at?.toISOString() ?? null,
    difference: row.difference,
    uomMismatch: row.uom_mismatch,
  }));
}
