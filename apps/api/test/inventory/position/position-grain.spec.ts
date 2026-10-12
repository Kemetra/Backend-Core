/**
 * position-grain.spec.ts — Jira RT-432 (inventory position grain; RT-290
 * Gate 4: G4-1…G4-6).
 *
 * The UPGRADE path: migrations up to 0043 run first, movements are recorded
 * without a position (as every pre-0044 writer did), then 0044 runs. Proves:
 *
 *   - every write path lands at an explicit position: the store's `primary`
 *     location and `sellable` (manual movement, both transfer legs, count
 *     correction, sale-linked backfill, restock);
 *   - a manual movement may name another location of the path store and another
 *     status; a location of another store or tenant is a non-disclosing 404 and
 *     writes nothing; an inactive location is a 400; an unknown status is a 400;
 *   - a pre-0044 movement is READ as (the store's primary location, sellable)
 *     with `positionInterpreted: true` and is never rewritten (G4-5);
 *   - on-hand stays the physical total over every status and location and adds
 *     the per-status breakdown, where a pre-0044 movement counts as sellable;
 *   - listStockLocations returns the store's locations, primary first, tenant-
 *     isolated.
 *
 * Layer: service + DB against the RLS-active `env.app` pool. Docker-gated.
 */
import 'reflect-metadata';

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';

import {
  APP_ROLE_NAME,
  APP_ROLE_PASSWORD,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from '../../_helpers/postgres-container';
import {
  seedCatalogIsolationFixture,
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
} from '../../catalog/__support__/isolation-harness';
import { InventoryService } from '../../../src/inventory/inventory.service';

const DRIZZLE_DIR = resolve(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle');
const GRAIN_MIGRATION = '0044_stock_locations_position_grain.sql';

// Pre-0044 movements (no position). `5704a4` mnemonic, hex-safe.
const LEGACY_IN_A_X = '0a000000-0000-7000-8000-005704a4a001';
const LEGACY_OUT_A_X = '0a000000-0000-7000-8000-005704a4a002';
// A storage location of A.X, and one deactivated.
const BACKROOM_A_X = '0a000000-0000-7000-8000-005704a4a0b1';
const CLOSED_A_X = '0a000000-0000-7000-8000-005704a4a0b2';

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let service: InventoryService;

async function applyMigrations(pgEnv: PgTestEnv, pick: (name: string) => boolean): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith('.down.sql'))
    .filter(pick)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), 'utf8'));
  }
}

/** The app role the RLS-active pool connects as, granted on every table that exists now. */
async function grantAppRole(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE_NAME}') THEN
        CREATE ROLE ${APP_ROLE_NAME} LOGIN PASSWORD '${APP_ROLE_PASSWORD}';
      END IF;
    END
    $$;
  `);
  await pgEnv.admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE_NAME}`);
  await pgEnv.admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE_NAME}`);
  await pgEnv.admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE_NAME}`);
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrations(env, (n) => n.localeCompare(GRAIN_MIGRATION) < 0);
    await grantAppRole(env);
    await seedCatalogIsolationFixture(env);
    // The acting user the audit rows reference (as seed-inventory does).
    await env.admin.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'actor-a@fixture.invalid', NULL)
       ON CONFLICT DO NOTHING`,
      [ACTOR_A],
    );
    // Recorded before 0044: no position.
    await env.admin.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
          tenant_product_ref, reason, occurred_at, created_by)
       VALUES
         ($1, $3, $4, 'inbound',  10.0000, 'ea', $5, 'legacy inbound',  '2026-10-01T10:00:00Z', $6),
         ($2, $3, $4, 'outbound', -4.0000, 'ea', $5, 'legacy outbound', '2026-10-01T11:00:00Z', $6)`,
      [LEGACY_IN_A_X, LEGACY_OUT_A_X, TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, ACTOR_A],
    );
    await applyMigrations(env, (n) => n.localeCompare(GRAIN_MIGRATION) >= 0);
    await grantAppRole(env);
    await env.admin.query(
      `INSERT INTO stock_locations (id, tenant_id, store_id, code, name, kind, is_active) VALUES
         ($1, $3, $4, 'BACKROOM', 'Backroom', 'storage', true),
         ($2, $3, $4, 'CLOSED', 'Closed shelf', 'storage', false)`,
      [BACKROOM_A_X, CLOSED_A_X, TENANT_A, STORE_A_X],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env['MIGRATION_TEST_ALLOW_SKIP'] === '1') {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[position-grain] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  service = new InventoryService(env.app as unknown as Pool);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn('[position-grain] skipping — Docker unavailable');
    return true;
  }
  return false;
}

async function primaryOf(storeId: string): Promise<string> {
  const r = await env!.admin.query<{ id: string }>(
    `SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`,
    [storeId],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`no primary for ${storeId}`);
  return id;
}

/** The stored position of a movement, read as the superuser. */
async function stored(id: string): Promise<{ stock_location_id: string | null; inventory_status: string | null }> {
  const r = await env!.admin.query<{ stock_location_id: string | null; inventory_status: string | null }>(
    `SELECT stock_location_id, inventory_status FROM stock_movements WHERE id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`no movement ${id}`);
  return row;
}

async function movementCount(): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM stock_movements`);
  return Number(r.rows[0]?.n ?? '0');
}

const principal = { tenantId: TENANT_A, storeId: STORE_A_X, userId: ACTOR_A };
const SELLABLE = 'sellable';

describe('RT-432 — every write path lands at an explicit position (G4-6)', () => {
  it('a manual movement defaults to the store primary location and sellable', async () => {
    if (maybeSkip()) return;
    const m = await service.createStockMovement({
      ...principal,
      movementType: 'inbound',
      quantity: '3.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
    });
    const primary = await primaryOf(STORE_A_X);
    expect(m).toMatchObject({ stockLocationId: primary, inventoryStatus: SELLABLE, positionInterpreted: false });
    expect(await stored(m.id)).toEqual({ stock_location_id: primary, inventory_status: SELLABLE });
  });

  it('both transfer legs land at their own store primary, sellable', async () => {
    if (maybeSkip()) return;
    const t = await service.createStockTransfer({
      tenantId: TENANT_A,
      userId: ACTOR_A,
      sourceStoreId: STORE_A_X,
      destinationStoreId: STORE_A_Y,
      tenantProductRef: PRODUCT_A_ACTIVE,
      quantity: '1.0000',
      stockingUnit: 'ea',
    });
    expect(await stored(t.outbound.id)).toEqual({
      stock_location_id: await primaryOf(STORE_A_X),
      inventory_status: SELLABLE,
    });
    expect(await stored(t.inbound.id)).toEqual({
      stock_location_id: await primaryOf(STORE_A_Y),
      inventory_status: SELLABLE,
    });
  });

  it('a count correction lands at the store primary, sellable', async () => {
    if (maybeSkip()) return;
    const c = await service.recordStockCount({
      ...principal,
      tenantProductRef: PRODUCT_A_ACTIVE,
      countedQuantity: '100.0000',
      stockingUnit: 'ea',
    });
    expect(c.correctionMovement).not.toBeNull();
    expect(await stored(c.correctionMovement!.id)).toEqual({
      stock_location_id: await primaryOf(STORE_A_X),
      inventory_status: SELLABLE,
    });
  });

  it('the sale-linked backfill and the restock land at the store primary, sellable', async () => {
    if (maybeSkip()) return;
    const out = await service.backfillSaleLinkedOutbound({
      ...principal,
      sourceSystem: 'rt432-backfill',
      externalId: 'rt432-line-1',
      movementType: 'outbound',
      quantity: '-1.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
    });
    const back = await service.backfillRestockInbound({
      ...principal,
      sourceSystem: 'rt432-restock',
      externalId: 'rt432-void-1',
      movementType: 'inbound',
      quantity: '1.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
    });
    const primary = await primaryOf(STORE_A_X);
    for (const id of [out.id, back.id]) {
      expect(await stored(id)).toEqual({ stock_location_id: primary, inventory_status: SELLABLE });
    }
    // A redelivery returns the same, positioned movement (no second row).
    const again = await service.backfillSaleLinkedOutbound({
      ...principal,
      sourceSystem: 'rt432-backfill',
      externalId: 'rt432-line-1',
      movementType: 'outbound',
      quantity: '-1.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
    });
    expect(again).toMatchObject({ id: out.id, stockLocationId: primary, positionInterpreted: false });
  });
});

describe('RT-432 — a manual movement may name its location and status', () => {
  it('writes at another active location of the path store, in another status', async () => {
    if (maybeSkip()) return;
    const m = await service.createStockMovement({
      ...principal,
      movementType: 'inbound',
      quantity: '2.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
      stockLocationId: BACKROOM_A_X,
      inventoryStatus: 'damaged',
    });
    expect(m).toMatchObject({ stockLocationId: BACKROOM_A_X, inventoryStatus: 'damaged' });
    expect(await stored(m.id)).toEqual({ stock_location_id: BACKROOM_A_X, inventory_status: 'damaged' });
  });

  it.each([
    ['another store of the same tenant', STORE_A_Y],
    ['another tenant (RLS hides it)', STORE_B_X],
  ])('a location of %s is a 404 and writes nothing', async (_label, foreignStore) => {
    if (maybeSkip()) return;
    const before = await movementCount();
    await expect(
      service.createStockMovement({
        ...principal,
        movementType: 'inbound',
        quantity: '1.0000',
        stockingUnit: 'ea',
        stockLocationId: await primaryOf(foreignStore),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await movementCount()).toBe(before);
  });

  it('an inactive location and an unknown status are 400s', async () => {
    if (maybeSkip()) return;
    await expect(
      service.createStockMovement({
        ...principal,
        movementType: 'inbound',
        quantity: '1.0000',
        stockingUnit: 'ea',
        stockLocationId: CLOSED_A_X,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createStockMovement({
        ...principal,
        movementType: 'inbound',
        quantity: '1.0000',
        stockingUnit: 'ea',
        inventoryStatus: 'on_shelf' as never,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RT-432 — pre-0044 movements are read, never rewritten (G4-5)', () => {
  it('are read as the store primary location and sellable, flagged positionInterpreted', async () => {
    if (maybeSkip()) return;
    const list = await service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
      limit: 200,
    });
    const primary = await primaryOf(STORE_A_X);
    const legacy = list.items.filter((i) => [LEGACY_IN_A_X, LEGACY_OUT_A_X].includes(i.id));
    expect(legacy).toHaveLength(2);
    for (const item of legacy) {
      expect(item).toMatchObject({ stockLocationId: primary, inventoryStatus: SELLABLE, positionInterpreted: true });
    }
    expect(list.items.filter((i) => !i.positionInterpreted).length).toBeGreaterThan(0);
    for (const id of [LEGACY_IN_A_X, LEGACY_OUT_A_X]) {
      expect(await stored(id)).toEqual({ stock_location_id: null, inventory_status: null });
    }
  });
});

describe('RT-432 — on-hand keeps the physical total and adds the status breakdown', () => {
  it('quantity is every status; sellable counts pre-0044 movements; entries sum to the total', async () => {
    if (maybeSkip()) return;
    const sums = await env!.admin.query<{ total: string; damaged: string }>(
      `SELECT SUM(quantity)::numeric(19,4)::text AS total,
              COALESCE(SUM(quantity) FILTER (WHERE inventory_status = 'damaged'), 0)::numeric(19,4)::text AS damaged
         FROM stock_movements WHERE store_id = $1 AND tenant_product_ref = $2`,
      [STORE_A_X, PRODUCT_A_ACTIVE],
    );
    const oh = await service.getOnHand({ tenantId: TENANT_A, storeId: STORE_A_X, productId: PRODUCT_A_ACTIVE });
    expect(oh.quantity).toBe(sums.rows[0]?.total);
    expect(oh.statusQuantities.map((q) => q.inventoryStatus)).toEqual([
      'sellable',
      'return_inspection',
      'quality_hold',
      'damaged',
      'expired',
      'recall_hold',
    ]);
    expect(oh.statusQuantities.find((q) => q.inventoryStatus === 'damaged')?.quantity).toBe(
      sums.rows[0]?.damaged,
    );
    expect(oh.statusQuantities.find((q) => q.inventoryStatus === 'expired')?.quantity).toBe('0.0000');
    // The 2.0000 damaged inbound is physical but not sellable.
    const toMilli = (q: string): bigint => BigInt(q.replace('.', ''));
    expect(toMilli(oh.quantity) - toMilli(oh.sellableQuantity)).toBe(toMilli('2.0000'));
    const sum = oh.statusQuantities.reduce((acc, q) => acc + toMilli(q.quantity), 0n);
    expect(sum).toBe(toMilli(oh.quantity));
  });
});

describe('RT-432 — listStockLocations', () => {
  it('returns the store locations, primary first, then by code', async () => {
    if (maybeSkip()) return;
    const r = await service.listStockLocations({ tenantId: TENANT_A, storeId: STORE_A_X });
    expect(r.items.map((l) => [l.code, l.kind, l.isActive])).toEqual([
      ['PRIMARY', 'primary', true],
      ['BACKROOM', 'storage', true],
      ['CLOSED', 'storage', false],
    ]);
    expect(r.items.every((l) => l.storeId === STORE_A_X)).toBe(true);
  });

  it('another tenant store is a non-disclosing 404', async () => {
    if (maybeSkip()) return;
    await expect(service.listStockLocations({ tenantId: TENANT_A, storeId: STORE_B_X })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const b = await service.listStockLocations({ tenantId: TENANT_B, storeId: STORE_B_X });
    expect(b.items.map((l) => l.kind)).toEqual(['primary']);
  });
});
