/**
 * position-events.spec.ts — Jira RT-435 (status moves, relocations, the M-5
 * per-bucket net rule and the return landing policy; owner decisions D1–D4,
 * RT-435 comment 12993).
 *
 * Proves, against the RLS-active `env.app` pool with every migration applied:
 *   - a status move and a relocation each leave PHYSICAL on-hand unchanged;
 *     Sellable On Hand changes by exactly the moved quantity when one side is
 *     `sellable` (and not at all for a sellable relocation);
 *   - each event writes exactly two effects under one `adjustment` event
 *     (event_ref_id = the event id), keyed `<kind>:<eventId>:from|to` (DC-1),
 *     at the right positions, with tracking_identity_id NULL;
 *   - both effects are `erp_neutral` in the same transaction and no ERP
 *     posting intent is created (M-5, Q10, V1 profile);
 *   - replaying the same command creates no second event or effect; the same
 *     key with a different command is a 409;
 *   - rejections: a location of another store (404), an inactive location
 *     (400), another tenant's store (404), from == to status / location (400),
 *     a Reason Code that does not allow the pair, a reserved code, a
 *     `correction` without a note (400), a cross-unit quantity (400), a tracked
 *     product (409); nothing is written by any of them;
 *   - D2: a store_manager may not move stock out of a sensitive status (403);
 *     a tenant_admin may;
 *   - the return landing policy defaults to `sellable`, is tenant-scoped, and
 *     `resolveReturnLandingStatus` reads it.
 *
 * Layer: service + DB. Docker-gated (MIGRATION_TEST_ALLOW_SKIP=1 skips).
 */
import 'reflect-metadata';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
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
  PRODUCT_A_RETIRED,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
} from '../../catalog/__support__/isolation-harness';
import { MembershipRepository } from '../../../src/context/membership.repository';
import { InventoryService } from '../../../src/inventory/inventory.service';
import {
  InventoryPositionEventsService,
  resolveReturnLandingStatus,
  type RelocationInput,
  type StatusMoveInput,
} from '../../../src/inventory/position-events/position-events.service';

// `0435` mnemonic, hex-safe.
const BACKROOM_A_X = '0a000000-0000-7000-8000-00000435a0b1';
const CLOSED_A_X = '0a000000-0000-7000-8000-00000435a0b2';
const MANAGER_A = '0a000000-0000-7000-8000-00000435a0c1';
const ADMIN_A = '0a000000-0000-7000-8000-00000435a0c2';

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let inventory: InventoryService;
let service: InventoryPositionEventsService;
let primaryAX = '';
let primaryAY = '';
let keySeq = 0;

/** A fresh, well-formed Idempotency-Key. */
function key(): string {
  keySeq += 1;
  return `rt435-key-${String(keySeq).padStart(8, '0')}`;
}

async function seedMember(
  admin: Pool,
  userId: string,
  roleCode: string,
  access: 'all' | 'specific',
  stores: readonly string[],
): Promise<void> {
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
    userId,
    `${roleCode}-${userId.slice(-4)}@fixture.invalid`,
  ]);
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES (gen_random_uuid(), $1, $2, $2) ON CONFLICT DO NOTHING`,
    [TENANT_A, roleCode],
  );
  const m = await admin.query<{ id: string }>(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     SELECT gen_random_uuid(), $1, $2, r.id, $4 FROM roles r WHERE r.tenant_id = $1 AND r.code = $3
     RETURNING id::text AS id`,
    [TENANT_A, userId, roleCode, access],
  );
  for (const storeId of stores) {
    await admin.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`, [
      m.rows[0]!.id,
      storeId,
      TENANT_A,
    ]);
  }
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await env.admin.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'actor-a@fixture.invalid', NULL)
       ON CONFLICT DO NOTHING`,
      [ACTOR_A],
    );
    await seedMember(env.admin, MANAGER_A, 'store_manager', 'specific', [STORE_A_X]);
    await seedMember(env.admin, ADMIN_A, 'tenant_admin', 'all', []);
    const primaries = await env.admin.query<{ store_id: string; id: string }>(
      `SELECT store_id::text, id::text FROM stock_locations WHERE kind = 'primary' AND store_id = ANY($1::uuid[])`,
      [[STORE_A_X, STORE_A_Y]],
    );
    primaryAX = primaries.rows.find((r) => r.store_id === STORE_A_X)!.id;
    primaryAY = primaries.rows.find((r) => r.store_id === STORE_A_Y)!.id;
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
      console.warn(`\n[position-events] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  const pool = env.app as unknown as Pool;
  inventory = new InventoryService(pool);
  service = new InventoryPositionEventsService(pool, new MembershipRepository(pool));
  // 10 ea sellable at A.X's primary location.
  await inventory.createStockMovement({
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    userId: ACTOR_A,
    movementType: 'inbound',
    quantity: '10.0000',
    stockingUnit: 'ea',
    tenantProductRef: PRODUCT_A_ACTIVE,
  });
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn('[position-events] skipping — Docker unavailable');
    return true;
  }
  return false;
}

/** The server-resolved actor, store and product every command here shares. */
function commandBase() {
  return {
    tenantId: TENANT_A,
    userId: ACTOR_A,
    isPlatformAdmin: false,
    idempotencyKey: key(),
    storeId: STORE_A_X,
    tenantProductRef: PRODUCT_A_ACTIVE,
    stockingUnit: 'ea',
    reasonCode: null,
    note: null,
  } as const;
}

function statusMove(overrides: Partial<StatusMoveInput> = {}): StatusMoveInput {
  const move = { quantity: '3', stockLocationId: null, fromStatus: 'sellable', toStatus: 'damaged' } as const;
  return { ...commandBase(), ...move, reasonCode: 'damage', ...overrides };
}

function relocation(overrides: Partial<RelocationInput> = {}): RelocationInput {
  const move = { quantity: '2', fromLocationId: primaryAX, toLocationId: BACKROOM_A_X, inventoryStatus: null };
  return { ...commandBase(), ...move, ...overrides };
}

async function onHand(): Promise<{ physical: string; sellable: string; byStatus: Record<string, string> }> {
  const o = await inventory.getOnHand({ tenantId: TENANT_A, storeId: STORE_A_X, productId: PRODUCT_A_ACTIVE });
  return {
    physical: o.quantity,
    sellable: o.sellableQuantity,
    byStatus: Object.fromEntries(o.statusQuantities.map((s) => [s.inventoryStatus, s.quantity])),
  };
}

/** Row counts that every refused command must leave unchanged. */
async function counts(): Promise<{ events: number; effects: number }> {
  const r = await env!.admin.query<{ events: number; effects: number }>(
    `SELECT (SELECT count(*)::int FROM inventory_position_events) AS events,
            (SELECT count(*)::int FROM stock_movements) AS effects`,
  );
  return r.rows[0]!;
}

async function quantityAt(locationId: string, status: string): Promise<string> {
  const r = await env!.admin.query<{ q: string }>(
    `SELECT COALESCE(SUM(quantity), 0)::numeric(19,4)::text AS q FROM stock_movements
      WHERE tenant_product_ref = $1 AND stock_location_id = $2 AND inventory_status = $3`,
    [PRODUCT_A_ACTIVE, locationId, status],
  );
  return r.rows[0]!.q;
}

describe('RT-435 status move', () => {
  it('moves 3 sellable -> damaged: physical unchanged, sellable -3, damaged +3', async () => {
    if (maybeSkip()) return;
    const before = await onHand();
    const event = await service.createStatusMove(statusMove());
    const after = await onHand();

    expect(after.physical).toBe(before.physical);
    expect(BigInt(after.sellable.replace('.', ''))).toBe(BigInt(before.sellable.replace('.', '')) - 30000n);
    expect(BigInt(after.byStatus['damaged']!.replace('.', ''))).toBe(
      BigInt(before.byStatus['damaged']!.replace('.', '')) + 30000n,
    );

    expect(event).toMatchObject({
      kind: 'status_move',
      storeId: STORE_A_X,
      quantity: '3.0000',
      fromLocationId: primaryAX,
      toLocationId: primaryAX,
      fromStatus: 'sellable',
      toStatus: 'damaged',
      reasonCode: 'damage',
      trackingIdentityId: null,
    });
    expect(event.fromEffect).toMatchObject({
      movementType: 'adjustment',
      quantity: '-3.0000',
      stockLocationId: primaryAX,
      inventoryStatus: 'sellable',
      integrationState: 'erp_neutral',
      trackingIdentityId: null,
    });
    expect(event.toEffect).toMatchObject({
      quantity: '3.0000',
      stockLocationId: primaryAX,
      inventoryStatus: 'damaged',
      integrationState: 'erp_neutral',
    });
  });

  it('writes exactly two effects under one adjustment event, keyed by DC-1, both erp_neutral, no posting intent', async () => {
    if (maybeSkip()) return;
    const postingBefore = await env!.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM erpnext_posting_status`);
    const event = await service.createStatusMove(statusMove({ quantity: '1' }));
    const effects = await env!.admin.query<{
      event_type: string;
      event_ref_id: string;
      source_system: string;
      external_id: string;
      state: string;
      posting_status_id: string | null;
    }>(
      `SELECT m.event_type, m.event_ref_id::text, m.source_system, m.external_id, i.state, i.posting_status_id
         FROM stock_movements m JOIN inventory_effect_integration i ON i.effect_id = m.id
        WHERE m.event_ref_id = $1 ORDER BY m.external_id`,
      [event.id],
    );
    expect(effects.rows).toEqual([
      {
        event_type: 'adjustment',
        event_ref_id: event.id,
        source_system: 'retail',
        external_id: `status_move:${event.id}:from`,
        state: 'erp_neutral',
        posting_status_id: null,
      },
      {
        event_type: 'adjustment',
        event_ref_id: event.id,
        source_system: 'retail',
        external_id: `status_move:${event.id}:to`,
        state: 'erp_neutral',
        posting_status_id: null,
      },
    ]);
    const postingAfter = await env!.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM erpnext_posting_status`);
    expect(postingAfter.rows[0]!.n).toBe(postingBefore.rows[0]!.n);
  });

  it('a tenant_admin may move stock out of damaged (D2), back to sellable as a correction', async () => {
    if (maybeSkip()) return;
    const before = await onHand();
    const event = await service.createStatusMove(
      statusMove({ userId: ADMIN_A, fromStatus: 'damaged', toStatus: 'sellable', reasonCode: 'correction', note: 'misfiled', quantity: '1' }),
    );
    expect(event.note).toBe('misfiled');
    const after = await onHand();
    expect(after.physical).toBe(before.physical);
  });

  it('a store_manager may not move stock out of a sensitive status (403), and nothing is written', async () => {
    if (maybeSkip()) return;
    const before = await counts();
    await expect(
      service.createStatusMove(
        statusMove({ userId: MANAGER_A, fromStatus: 'damaged', toStatus: 'sellable', reasonCode: 'correction', note: 'x' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await counts()).toEqual(before);
  });

  it('a store_manager may make a non-sensitive move', async () => {
    if (maybeSkip()) return;
    await expect(service.createStatusMove(statusMove({ userId: MANAGER_A, quantity: '1' }))).resolves.toMatchObject({
      createdBy: MANAGER_A,
    });
  });
});

describe('RT-435 relocation', () => {
  it('moves 2 sellable primary -> backroom: physical and sellable unchanged', async () => {
    if (maybeSkip()) return;
    const before = await onHand();
    const backroomBefore = await quantityAt(BACKROOM_A_X, 'sellable');
    const event = await service.createRelocation(relocation());
    const after = await onHand();

    expect(after.physical).toBe(before.physical);
    expect(after.sellable).toBe(before.sellable);
    expect(BigInt((await quantityAt(BACKROOM_A_X, 'sellable')).replace('.', ''))).toBe(
      BigInt(backroomBefore.replace('.', '')) + 20000n,
    );
    expect(event).toMatchObject({
      kind: 'relocation',
      fromLocationId: primaryAX,
      toLocationId: BACKROOM_A_X,
      fromStatus: 'sellable',
      toStatus: 'sellable',
      reasonCode: null,
    });
    expect(event.fromEffect).toMatchObject({ quantity: '-2.0000', stockLocationId: primaryAX, integrationState: 'erp_neutral' });
    expect(event.toEffect).toMatchObject({ quantity: '2.0000', stockLocationId: BACKROOM_A_X, integrationState: 'erp_neutral' });
  });

  it('relocates damaged stock and keeps its status (not sensitive: the status does not change)', async () => {
    if (maybeSkip()) return;
    const event = await service.createRelocation(
      relocation({ userId: MANAGER_A, inventoryStatus: 'damaged', quantity: '1' }),
    );
    expect(event.fromEffect.inventoryStatus).toBe('damaged');
    expect(event.toEffect.inventoryStatus).toBe('damaged');
  });
});

describe('RT-435 replay (DC-1)', () => {
  it('replaying the same command returns the recorded event and writes nothing', async () => {
    if (maybeSkip()) return;
    const cmd = statusMove({ quantity: '1' });
    const first = await service.createStatusMove(cmd);
    const before = await counts();
    const again = await service.createStatusMove(cmd);
    expect(await counts()).toEqual(before);
    expect(again.id).toBe(first.id);
    expect(again.fromEffect.id).toBe(first.fromEffect.id);
    expect(again.toEffect.id).toBe(first.toEffect.id);
    expect(again.toEffect.integrationState).toBe('erp_neutral');

    const reloc = relocation({ quantity: '1' });
    const r1 = await service.createRelocation(reloc);
    const r2 = await service.createRelocation(reloc);
    expect(r2.id).toBe(r1.id);
  });

  it('two concurrent replays of one command record one event', async () => {
    if (maybeSkip()) return;
    const cmd = statusMove({ quantity: '1' });
    const before = await counts();
    const [a, b] = await Promise.all([service.createStatusMove(cmd), service.createStatusMove(cmd)]);
    expect(a.id).toBe(b.id);
    const after = await counts();
    expect(after.events - before.events).toBe(1);
    expect(after.effects - before.effects).toBe(2);
  });

  it('the same key with a different command is a 409 and writes nothing', async () => {
    if (maybeSkip()) return;
    const cmd = statusMove({ quantity: '1' });
    await service.createStatusMove(cmd);
    const before = await counts();
    await expect(service.createStatusMove({ ...cmd, quantity: '2' })).rejects.toBeInstanceOf(ConflictException);
    expect(await counts()).toEqual(before);
  });
});

describe('RT-435 rejections write nothing', () => {
  it.each<[string, () => Promise<unknown>, new (...args: never[]) => Error]>([
    ['a relocation to a location of another store', () => service.createRelocation(relocation({ toLocationId: primaryAY })), NotFoundException],
    ['a relocation to an inactive location', () => service.createRelocation(relocation({ toLocationId: CLOSED_A_X })), BadRequestException],
    ['a relocation to the same location', () => service.createRelocation(relocation({ toLocationId: primaryAX })), BadRequestException],
    ['a status move in another tenant\'s store', () => service.createStatusMove(statusMove({ storeId: STORE_B_X })), NotFoundException],
    ['a status move to the same status', () => service.createStatusMove(statusMove({ toStatus: 'sellable' })), BadRequestException],
    ['a Reason Code that does not allow the pair', () => service.createStatusMove(statusMove({ toStatus: 'expired' })), BadRequestException],
    ['a reserved Reason Code', () => service.createStatusMove(statusMove({ toStatus: 'quality_hold', reasonCode: 'quality_hold' })), BadRequestException],
    ['a correction without a note', () => service.createStatusMove(statusMove({ reasonCode: 'correction' })), BadRequestException],
    ['a cross-unit quantity', () => service.createStatusMove(statusMove({ stockingUnit: 'box' })), BadRequestException],
    ['a status move at another store\'s location', () => service.createStatusMove(statusMove({ stockLocationId: primaryAY })), NotFoundException],
  ])('refuses %s', async (_label, run, errorType) => {
    if (maybeSkip()) return;
    const before = await counts();
    await expect(run()).rejects.toBeInstanceOf(errorType);
    expect(await counts()).toEqual(before);
  });

  it('refuses a tracked product (G7-4: no identity yet) with 409', async () => {
    if (maybeSkip()) return;
    await env!.admin.query(`UPDATE tenant_products SET tracking_mode = 'batch' WHERE id = $1`, [PRODUCT_A_RETIRED]);
    const before = await counts();
    await expect(
      service.createStatusMove(statusMove({ tenantProductRef: PRODUCT_A_RETIRED })),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await counts()).toEqual(before);
  });
});

describe('RT-435 return landing policy (Q6)', () => {
  it('defaults to sellable, is set and read per tenant, and resolveReturnLandingStatus follows it', async () => {
    if (maybeSkip()) return;
    expect(await service.getReturnLandingPolicy(TENANT_A)).toEqual({
      returnLandingStatus: 'sellable',
      updatedAt: null,
    });
    const set = await service.setReturnLandingPolicy({
      tenantId: TENANT_A,
      userId: ADMIN_A,
      returnLandingStatus: 'return_inspection',
    });
    expect(set.returnLandingStatus).toBe('return_inspection');
    expect(set.updatedAt).not.toBeNull();
    expect((await service.getReturnLandingPolicy(TENANT_A)).returnLandingStatus).toBe('return_inspection');
    // Tenant B is untouched.
    expect((await service.getReturnLandingPolicy(TENANT_B)).returnLandingStatus).toBe('sellable');

    const resolved = await runWithTenantContext(
      env!.app as unknown as Pool,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      (c) => resolveReturnLandingStatus(c, TENANT_A),
    );
    expect(resolved).toBe('return_inspection');

    await service.setReturnLandingPolicy({ tenantId: TENANT_A, userId: ADMIN_A, returnLandingStatus: 'sellable' });
    expect((await service.getReturnLandingPolicy(TENANT_A)).returnLandingStatus).toBe('sellable');
    const audits = await env!.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'inventory.return_landing.update' AND tenant_id = $1`,
      [TENANT_A],
    );
    expect(audits.rows[0]!.n).toBe(2);
  });
});
