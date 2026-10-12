/**
 * effect-integration.spec.ts — Jira RT-425 (Inventory Effects Journal, additive).
 *
 * RT-289 G2-2 / G2-3 / Q2: every movement a Retail write path appends is an
 * Inventory Effect with an explicit origin and owning Business Event, and gets
 * a `not_posted` integration record in the SAME transaction:
 *
 *   - manual movement   → event `adjustment`, keyed by the movement's own id;
 *   - transfer          → both legs, event `transfer`, keyed by the transfer group;
 *   - count correction  → event `count`, keyed by the recorded stock count.
 *
 * The movement list projects `origin`, `integrationState` and `erpConfirmedAt`
 * from a LEFT JOIN, so a movement without an integration record reads null.
 * The integration record is tenant-isolated by RLS like the effect itself.
 * Nothing activates sale effects here (RT-427).
 *
 * Layer: service + DB against the RLS-active `env.app` pool. Docker-gated.
 */
import 'reflect-metadata';

import { Pool } from 'pg';

import {
  applyAllUpAndCreateAppRole,
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
  TENANT_A,
  TENANT_B,
} from '../../catalog/__support__/isolation-harness';
import { MOVE_A_X, seedInventoryFixture } from '../__support__/seed-inventory';
import { InventoryService } from '../../../src/inventory/inventory.service';

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let service: InventoryService;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedInventoryFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env['MIGRATION_TEST_ALLOW_SKIP'] === '1') {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[effect-integration] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  service = new InventoryService(env.app as unknown as Pool);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn('[effect-integration] skipping — Docker unavailable');
    return true;
  }
  return false;
}

interface EffectRow {
  origin: string;
  event_type: string | null;
  event_ref_id: string | null;
  state: string | null;
  posting_status_id: string | null;
  erp_confirmed_at: Date | null;
}

/** The effect columns and its integration record, read as the superuser. */
async function effect(id: string): Promise<EffectRow> {
  const r = await env!.admin.query<EffectRow>(
    `SELECT m.origin, m.event_type, m.event_ref_id,
            i.state, i.posting_status_id, i.erp_confirmed_at
       FROM stock_movements m
       LEFT JOIN inventory_effect_integration i ON i.effect_id = m.id
      WHERE m.id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`no movement ${id}`);
  return row;
}

/** Run `sql` on the RLS-active app pool inside `tenantId`'s context. */
async function asTenant<T extends Record<string, unknown>>(
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await env!.app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
    const r = await client.query<T>(sql, params);
    await client.query('ROLLBACK');
    return r.rows;
  } finally {
    client.release();
  }
}

const principal = { tenantId: TENANT_A, storeId: STORE_A_X, userId: ACTOR_A };

describe('RT-425 — Retail write paths record origin, owning event and not_posted', () => {
  it('a manual movement is an `adjustment` event keyed by itself, starting not_posted', async () => {
    if (maybeSkip()) return;
    const m = await service.createStockMovement({
      ...principal,
      movementType: 'inbound',
      quantity: '2.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
    });

    expect(m.origin).toBe('retail');
    expect(m.integrationState).toBe('not_posted');
    expect(m.erpConfirmedAt).toBeNull();

    const e = await effect(m.id);
    expect(e).toEqual({
      origin: 'retail',
      event_type: 'adjustment',
      event_ref_id: m.id,
      state: 'not_posted',
      posting_status_id: null,
      erp_confirmed_at: null,
    });
  });

  it('both transfer legs are one `transfer` event (the transfer group), each not_posted', async () => {
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

    for (const leg of [t.outbound, t.inbound]) {
      expect(leg.origin).toBe('retail');
      expect(leg.integrationState).toBe('not_posted');
      const e = await effect(leg.id);
      expect(e.event_type).toBe('transfer');
      expect(e.event_ref_id).toBe(t.transferGroupId);
      expect(e.state).toBe('not_posted');
      expect(e.posting_status_id).toBeNull();
    }
  });

  it('a count correction is the `count` event (the recorded count), starting not_posted', async () => {
    if (maybeSkip()) return;
    const c = await service.recordStockCount({
      ...principal,
      tenantProductRef: PRODUCT_A_ACTIVE,
      countedQuantity: '50.0000',
      stockingUnit: 'ea',
    });

    const corr = c.correctionMovement;
    expect(corr).not.toBeNull();
    expect(corr!.integrationState).toBe('not_posted');
    const e = await effect(corr!.id);
    expect(e.event_type).toBe('count');
    expect(e.event_ref_id).toBe(c.stockCountId);
    expect(e.state).toBe('not_posted');
  });

  it('a zero-variance count appends no effect and no integration record', async () => {
    if (maybeSkip()) return;
    const before = await env!.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inventory_effect_integration`,
    );
    // The previous test left on-hand at exactly 50.0000.
    const c = await service.recordStockCount({
      ...principal,
      tenantProductRef: PRODUCT_A_ACTIVE,
      countedQuantity: '50.0000',
      stockingUnit: 'ea',
    });
    expect(c.correctionMovement).toBeNull();
    const after = await env!.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inventory_effect_integration`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe('RT-425 — the integration record is written in the SAME transaction', () => {
  it('when the integration write fails, the movement is rolled back with it', async () => {
    if (maybeSkip()) return;
    const countBefore = await env!.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movements WHERE tenant_id = $1`,
      [TENANT_A],
    );
    await env!.admin.query(`REVOKE INSERT ON inventory_effect_integration FROM app_test`);
    try {
      await expect(
        service.createStockMovement({
          ...principal,
          movementType: 'inbound',
          quantity: '1.0000',
          stockingUnit: 'ea',
          tenantProductRef: PRODUCT_A_ACTIVE,
        }),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await env!.admin.query(`GRANT INSERT ON inventory_effect_integration TO app_test`);
    }
    const countAfter = await env!.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movements WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(countAfter.rows[0]!.n).toBe(countBefore.rows[0]!.n);
  });
});

describe('RT-425 — movement list projects origin + integration state', () => {
  it('projects not_posted for an RT-425 write and null for a movement with no record', async () => {
    if (maybeSkip()) return;
    const m = await service.createStockMovement({
      ...principal,
      movementType: 'outbound',
      quantity: '-1.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
    });

    const list = await service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
      limit: 200,
    });
    const written = list.items.find((i) => i.id === m.id);
    expect(written).toMatchObject({
      origin: 'retail',
      integrationState: 'not_posted',
      erpConfirmedAt: null,
    });

    // MOVE_A_X is a raw fixture row seeded after the migrations ran, so it has
    // no integration record (the pre-catch-up case): it still lists, as null.
    const seeded = list.items.find((i) => i.id === MOVE_A_X);
    expect(seeded).toMatchObject({ origin: 'retail', integrationState: null, erpConfirmedAt: null });
  });
});

describe('RT-425 — the integration record is tenant-isolated (RLS)', () => {
  it("tenant B sees none of tenant A's integration records, and cannot update them", async () => {
    if (maybeSkip()) return;
    const asA = await asTenant<{ n: string }>(
      TENANT_A,
      `SELECT count(*)::text AS n FROM inventory_effect_integration`,
    );
    expect(Number(asA[0]!.n)).toBeGreaterThan(0);

    const asB = await asTenant<{ n: string }>(
      TENANT_B,
      `SELECT count(*)::text AS n FROM inventory_effect_integration WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(asB[0]!.n).toBe('0');

    const updated = await asTenant<{ effect_id: string }>(
      TENANT_B,
      `UPDATE inventory_effect_integration SET state_reason = 'cross-tenant'
        WHERE tenant_id = $1 RETURNING effect_id`,
      [TENANT_A],
    );
    expect(updated).toEqual([]);
  });

  it('no role can delete an integration record (no DELETE policy)', async () => {
    if (maybeSkip()) return;
    const deleted = await asTenant<{ effect_id: string }>(
      TENANT_A,
      `DELETE FROM inventory_effect_integration RETURNING effect_id`,
    );
    expect(deleted).toEqual([]);
  });
});
