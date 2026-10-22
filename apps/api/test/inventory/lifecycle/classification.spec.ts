/**
 * apps/api/test/inventory/lifecycle/classification.spec.ts
 *
 * Slice 009-LIFECYCLE (T095) — data-lifecycle classification + retention guard
 * (Constitution §XIV).
 *
 * The two inventory entities (`stock_movements`, `stock_counts`) are
 * BUSINESS-CLASS data: catalog references, signed quantities, provenance ids
 * (source/external/sale/terminal-event/transfer-group/stock-count), bounded
 * operator `reason` text, timestamps, and the acting principal (`created_by` —
 * an operational actor UUID, NOT customer PII). They carry NO PII and NO
 * payment/tender data in v1. Retention INHERITS the 001 long-horizon, insert-only
 * audit-retention posture for the immutable ledger; right-to-erasure TOMBSTONES
 * any future PII field rather than deleting a movement. The full classification
 * + retention prose is recorded in:
 *   - packages/db/drizzle/0014_inventory.sql  (migration header)
 *   - specs/009-inventory-stock-ledger/data-model.md  (§ data-lifecycle)
 * — both landed in the [GATED] 009-SCHEMA slice; this slice adds the EXECUTABLE
 * guard only.
 *
 * Docker-FREE introspection guard (mirrors the 008 SI-012 guard
 * `catalog/sales/lifecycle/classification.spec.ts`): it reads the actual
 * persisted column inventory off the Drizzle table objects via `getTableConfig`
 * and asserts it is EXACTLY the recorded business-class allowlist — a tripwire,
 * not a denylist. A later slice adding/removing/renaming a persisted column
 * fails set-equality and forces a §XIV re-review (the reclassification trigger).
 * A secondary collision-safe PII/payment denylist catches the common shapes a
 * future customer-reference / tender column would take.
 *
 * Note: `@data-pulse-2/db/schema` resolves to the package's built `dist/`, so
 * the db package must be built before this spec sees the exports
 * (`pnpm --filter @data-pulse-2/db build`).
 */
import 'reflect-metadata';

import * as fs from 'node:fs';
import * as path from 'node:path';

import { getTableConfig } from 'drizzle-orm/pg-core';

import {
  erpnextTrackingMap,
  inventoryAnchorLines,
  inventoryAnchors,
  inventoryEffectIntegration,
  inventoryPositionEvents,
  stockCounts,
  stockMovements,
  tenantInventorySettings,
  trackingIdentities,
} from '@data-pulse-2/db/schema';

function persistedColumns(table: unknown): string[] {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  return cfg.columns.map((c) => (c as unknown as { name: string }).name).sort();
}

/**
 * The recorded BUSINESS-CLASS persisted-column inventory for each inventory
 * table. Every entry is a catalog reference, a signed quantity, server-owned
 * provenance/lineage (source_system / external_id / idempotency_key / sale /
 * terminal-event / transfer-group / stock-count refs), a bounded operator note,
 * a timestamp, or the acting principal (`created_by`). NONE is a customer
 * reference or a tender/payment field. This list IS the machine-checked
 * classification: changing it requires re-running the §XIV review.
 */
const BUSINESS_CLASS_COLUMNS: ReadonlyArray<{
  name: string;
  table: unknown;
  columns: string[];
}> = [
  {
    name: 'stock_movements',
    table: stockMovements,
    columns: [
      'id',
      'tenant_id',
      'store_id',
      'movement_type',
      'quantity',
      'stocking_unit',
      'tenant_product_ref',
      'reason',
      'occurred_at',
      'received_at',
      'idempotency_key',
      'source_system',
      'external_id',
      'sale_id',
      'sale_line_id',
      'terminal_event_ref',
      'transfer_group_id',
      'stock_count_id',
      'created_by',
      'created_at',
      // RT-425 (0042) §XIV re-review: effect origin / event codes, an opaque
      // event and compensated-effect id, and the Gate 4/7 position
      // placeholders (an opaque location id, a status code, a tracking
      // identity). All business-class; no customer or payment data.
      'origin',
      'event_type',
      'event_ref_id',
      'compensates_effect_id',
      'stock_location_id',
      'inventory_status',
      'tracking_identity',
      // RT-448 (0045): the opaque id of the effect's tracking identity.
      'tracking_identity_id',
    ],
  },
  {
    // RT-448 (0045): an Inventory-owned batch / serial — opaque ids, a kind,
    // the printed manufacturer code (no PII), dates and an origin code.
    name: 'tracking_identities',
    table: trackingIdentities,
    columns: [
      'id',
      'tenant_id',
      'tenant_product_ref',
      'kind',
      'code',
      'expiry_date',
      'manufactured_on',
      'origin',
      'created_at',
      'updated_at',
    ],
  },
  {
    // RT-448 (0045): identity → opaque ERPNext Batch / Serial No name.
    name: 'erpnext_tracking_map',
    table: erpnextTrackingMap,
    columns: ['id', 'tenant_id', 'tracking_identity_id', 'kind', 'erpnext_ref', 'created_at'],
  },
  {
    // RT-425 (0042): the mutable per-effect ERP integration state. Codes,
    // opaque ids, an ERPNext document reference, timestamps and a bounded
    // state reason. Business-class; no customer or payment data.
    name: 'inventory_effect_integration',
    table: inventoryEffectIntegration,
    columns: [
      'effect_id',
      'tenant_id',
      'state',
      'posting_status_id',
      'erp_document_ref',
      'erp_confirmed_at',
      'state_reason',
      'created_at',
      'updated_at',
    ],
  },
  {
    // RT-435 (0056): the event record of a status move / relocation — opaque
    // ids, codes, an exact quantity and unit, a bounded operator note (no PII
    // by policy, as stock_movements.reason), a SHA-256 fingerprint (never the
    // raw Idempotency-Key) and timestamps.
    name: 'inventory_position_events',
    table: inventoryPositionEvents,
    columns: [
      'id',
      'tenant_id',
      'store_id',
      'kind',
      'tenant_product_ref',
      'quantity',
      'stocking_unit',
      'from_location_id',
      'to_location_id',
      'from_status',
      'to_status',
      'reason_code',
      'note',
      'tracking_identity_id',
      'command_fingerprint',
      'occurred_at',
      'created_by',
      'created_at',
    ],
  },
  {
    // RT-435 (0056): the per-tenant return landing status and its actor.
    // RT-427 (0063): the sale-effects activation time and its actor.
    name: 'tenant_inventory_settings',
    table: tenantInventorySettings,
    columns: [
      'tenant_id',
      'return_landing_status',
      'sale_effects_activated_at',
      'sale_effects_activated_by',
      'updated_by',
      'created_at',
      'updated_at',
    ],
  },
  {
    // RT-427 (0063): the Inventory Anchor — opaque ids, an ERP warehouse
    // reference, timestamps and a coverage object of counts.
    name: 'inventory_anchors',
    table: inventoryAnchors,
    columns: [
      'id',
      'tenant_id',
      'store_id',
      'stock_location_id',
      'inventory_status',
      'generation',
      'source_run_id',
      'snapshot_read_at',
      'snapshot_recorded_at',
      'erpnext_warehouse_ref',
      'activated_at',
      'coverage',
      'created_by',
      'created_at',
    ],
  },
  {
    // RT-427 (0063): one anchor line per product — an exact Bin quantity, its
    // ERP stock UOM and Item reference.
    name: 'inventory_anchor_lines',
    table: inventoryAnchorLines,
    columns: [
      'id',
      'anchor_id',
      'tenant_id',
      'tenant_product_ref',
      'quantity',
      'erp_stock_uom',
      'erpnext_item_ref',
    ],
  },
  {
    name: 'stock_counts',
    table: stockCounts,
    columns: [
      'id',
      'tenant_id',
      'store_id',
      'tenant_product_ref',
      'counted_quantity',
      'derived_on_hand_at_count',
      'stocking_unit',
      'counted_at',
      'created_by',
      'created_at',
    ],
  },
];

/**
 * Collision-safe PII / payment-class substrings. Each is a fragment that would
 * appear in a customer-reference or tender/payment column name but does NOT
 * collide with any business-class column above. Deliberately AVOIDS bare `name`
 * (would false-positive on nothing here, but kept out for parity with the 008
 * guard) and treats `created_by` / `source_system` as operational provenance,
 * not customer PII.
 */
const PII_PAYMENT_SUBSTRINGS = [
  'customer',
  'patient',
  'email',
  'phone',
  'address',
  'ssn',
  'national_id',
  'first_name',
  'last_name',
  'full_name',
  'dob',
  'birth',
  'tender',
  'payment',
  'card',
  'cash',
  'pan',
  'iban',
  'account_number',
  'cvv',
];

describe('009-LIFECYCLE (T095) — inventory data-class classification (§XIV)', () => {
  describe.each(BUSINESS_CLASS_COLUMNS)(
    '$name persists EXACTLY the recorded business-class columns',
    ({ table, columns }) => {
      it('set-equals the business-class allowlist (tripwire on add/remove/rename)', () => {
        const actual = persistedColumns(table);
        const expected = [...columns].sort();
        expect(actual).toEqual(expected);
      });
    },
  );

  describe('no PII / payment-class field is persisted in v1', () => {
    it.each(BUSINESS_CLASS_COLUMNS)('$name has zero PII/payment-class columns', ({ table }) => {
      const offending = persistedColumns(table).filter((col) =>
        PII_PAYMENT_SUBSTRINGS.some((frag) => col.toLowerCase().includes(frag)),
      );
      expect(offending).toEqual([]);
    });
  });
});

describe('009-LIFECYCLE (T095) — classification + retention recorded in source-of-truth', () => {
  // The retention posture (001-inherited, insert-only; tombstone-on-erasure) is
  // PROSE, not a column shape — its durable record lives in the migration header
  // + data-model.md. Kept lenient: keyword presence, not brittle wording.
  // repoRoot: __dirname is apps/api/test/inventory/lifecycle → FIVE hops up
  // (inventory→test→api→apps→root). NOTE: this is ONE FEWER ".." than the 008
  // guard (catalog/sales/lifecycle, six hops) because 009's path has `inventory`
  // where 008 has `catalog/sales` (two dirs). Verified by the readFileSync
  // assertions below resolving — do NOT blindly copy 008's six-".." count.
  const repoRoot = path.resolve(__dirname, '../../../../..');

  it('0014_inventory.sql header records business-class + 001-inherited retention (§XIV)', () => {
    const sqlPath = path.join(repoRoot, 'packages/db/drizzle/0014_inventory.sql');
    const text = fs.readFileSync(sqlPath, 'utf8');
    expect(text).toMatch(/BUSINESS-CLASS/i);
    expect(text).toMatch(/T095/);
    expect(text).toMatch(/§XIV/);
    // Keyword presence, not adjacency: the SQL comment wraps "the 001" and
    // "long-horizon" onto separate `-- ` lines, so assert each independently.
    expect(text).toMatch(/\b001\b/);
    expect(text).toMatch(/long-horizon/i);
    expect(text).toMatch(/tombston/i);
  });

  it('data-model.md records the business-class classification + 001-inherited retention', () => {
    const dmPath = path.join(repoRoot, 'specs/009-inventory-stock-ledger/data-model.md');
    const text = fs.readFileSync(dmPath, 'utf8');
    expect(text).toMatch(/business-class/i);
    expect(text).toMatch(/§XIV/);
    expect(text).toMatch(/inherits the 001/i);
    expect(text).toMatch(/tombston/i);
  });
});
