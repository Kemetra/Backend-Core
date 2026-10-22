/**
 * inventory-safety.spec.ts — Jira RT-449 PR 1 (RT-50 Gate 7 G7-2 / G7-6 /
 * G7-7; owner rulings H1–H8, RT-449 comment 13434).
 *
 * Proves, against the RLS-active `env.app` pool with every migration applied:
 *   - a quality-hold placement increments the tenant's Safety Revision exactly
 *     once, with one `hold_placed` change, in its own transaction;
 *   - the quantity representation (G7-6): a hold on an identity with positive
 *     `sellable` / `return_inspection` positions writes one RT-435 status move
 *     per position, each an `erp_neutral` effect pair carrying the identity;
 *     negative and zero positions are not moved; physical on-hand is
 *     unchanged;
 *   - a release puts `quality_hold` back in `sellable` (H3) — or in
 *     `recall_hold` while a recall is active — and a recall-hold release moves
 *     nothing (H4); a released hold is final and a second release is a no-op;
 *   - a recall of 2 identities creates 2 recall holds and ONE revision step;
 *   - replays write nothing; refusals (an active hold of the same kind, a
 *     duplicate or foreign identity, another tenant's identity, a future
 *     effective time) write nothing, the revision included;
 *   - the expiry correction keeps its history and steps the revision;
 *   - a tracking-profile change steps the revision;
 *   - reads are tenant-scoped (another tenant's id is a non-disclosing 404).
 *
 * The identities and their positions are SEEDED: on `main` nothing writes
 * `tracking_identities` or identity-grain effects until RT-451 / F6, so these
 * fixtures are the only way to exercise the quantity rule (RT-449 comment
 * 13432, "Reachability gap").
 *
 * Layer: service + DB. Docker-gated (MIGRATION_TEST_ALLOW_SKIP=1 skips).
 */
import 'reflect-metadata';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
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
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
} from '../../catalog/__support__/isolation-harness';
import { TrackingProfileService } from '../../../src/catalog/tracking-profile/tracking-profile.service';
import { IdentityExpiryService } from '../../../src/inventory/safety/identity-expiry.service';
import { InventoryRecallsService } from '../../../src/inventory/safety/inventory-recalls.service';
import { TrackingHoldsService } from '../../../src/inventory/safety/tracking-holds.service';

// `0449` mnemonic, hex-safe.
const PRODUCT_T = '0a000000-0000-7000-8000-000004490001';
const PRODUCT_T2 = '0a000000-0000-7000-8000-000004490002';
const PRODUCT_UNTRACKED = '0a000000-0000-7000-8000-000004490003';
const PRODUCT_TB = '0b000000-0000-7000-8000-000004490001';
const BACKROOM_A_X = '0a000000-0000-7000-8000-000004490b01';
const IDENTITY_B = '0b000000-0000-7000-8000-000004490c01';

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let holds: TrackingHoldsService;
let recalls: InventoryRecallsService;
let expiry: IdentityExpiryService;
let profiles: TrackingProfileService;
let primaryAX = '';
let primaryAY = '';
let seq = 0;

function nextSeq(): string {
  seq += 1;
  return String(seq).padStart(6, '0');
}

function admin(): Pool {
  if (!env) throw new Error('env not initialized');
  return env.admin;
}

/** A new batch identity of `product` (tenant A unless given), with optional expiry. */
async function newIdentity(
  product = PRODUCT_T,
  opts: { tenantId?: string; expiry?: string | null; manufacturedOn?: string | null } = {},
): Promise<string> {
  const r = await admin().query<{ id: string }>(
    `INSERT INTO tracking_identities (tenant_id, tenant_product_ref, kind, code, expiry_date, manufactured_on)
     VALUES ($1, $2, 'batch', $3, $4, $5) RETURNING id::text AS id`,
    [opts.tenantId ?? TENANT_A, product, `LOT-${nextSeq()}`, opts.expiry ?? null, opts.manufacturedOn ?? null],
  );
  return r.rows[0]!.id;
}

/** One identity-grain effect: the identity, its position and a signed quantity. */
interface SeededEffect {
  readonly identity: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly status: string;
  readonly quantity: string;
}

/** Seed one identity-grain effect of PRODUCT_T (the fixture RT-451 will write for real). */
async function seedEffect(e: SeededEffect): Promise<void> {
  await admin().query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason,
        occurred_at, created_by, stock_location_id, inventory_status, tracking_identity_id)
     VALUES (gen_random_uuid(), $1, $2, 'adjustment', $3::numeric, 'ea', $4, 'rt449 fixture', now(), $5,
             $6, $7, $8)`,
    [TENANT_A, e.storeId, e.quantity, PRODUCT_T, ACTOR_A, e.locationId, e.status, e.identity],
  );
}

interface Position {
  readonly store: string;
  readonly location: string;
  readonly status: string;
  readonly qty: string;
}

/** The identity's non-zero positions, as the admin sees them. */
async function positions(identityId: string): Promise<Position[]> {
  const r = await admin().query<Position>(
    `SELECT store_id::text AS store, stock_location_id::text AS location, inventory_status AS status,
            SUM(quantity)::text AS qty
       FROM stock_movements WHERE tracking_identity_id = $1
      GROUP BY 1, 2, 3 HAVING SUM(quantity) <> 0 ORDER BY 1, 2, 3`,
    [identityId],
  );
  return r.rows;
}

async function revisionOf(tenantId: string): Promise<number> {
  const r = await admin().query<{ revision: string }>(
    `SELECT revision::text AS revision FROM tenant_inventory_safety_revisions WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(r.rows[0]?.revision ?? 0);
}

/** Row counts of everything a safety command may write, for the zero-writes checks. */
async function writeCounts(): Promise<Record<string, string>> {
  const r = await admin().query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM tenant_inventory_safety_revisions)::text AS revisions,
            (SELECT COALESCE(SUM(revision), 0) FROM tenant_inventory_safety_revisions)::text AS revision_sum,
            (SELECT count(*) FROM inventory_safety_changes)::text AS changes,
            (SELECT count(*) FROM tracking_holds)::text AS holds,
            (SELECT count(*) FROM tracking_holds WHERE released_at IS NOT NULL)::text AS released,
            (SELECT count(*) FROM inventory_recalls)::text AS recalls,
            (SELECT count(*) FROM tracking_identity_expiry_corrections)::text AS corrections,
            (SELECT count(*) FROM inventory_position_events)::text AS events,
            (SELECT count(*) FROM stock_movements)::text AS effects,
            (SELECT count(*) FROM audit_events)::text AS audits`,
  );
  return r.rows[0]!;
}

async function expectNoWrites(fn: () => Promise<unknown>, error: new (...args: never[]) => Error): Promise<void> {
  const before = await writeCounts();
  await expect(fn()).rejects.toBeInstanceOf(error);
  expect(await writeCounts()).toEqual(before);
}

function base() {
  return { tenantId: TENANT_A, userId: ACTOR_A, idempotencyKey: `rt449-key-${nextSeq()}` } as const;
}

function placeInput(identityId: string, overrides: Record<string, unknown> = {}) {
  return { ...base(), trackingIdentityId: identityId, reasonCode: 'supplier_notice', note: null, ...overrides };
}

function recallInput(identityIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    ...base(),
    tenantProductRef: PRODUCT_T,
    trackingIdentityIds: identityIds,
    reasonCode: 'authority_notice',
    reference: 'EDA-2026-117',
    note: null,
    effectiveAt: null,
    ...overrides,
  };
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await env.admin.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'actor-a@fixture.invalid', NULL) ON CONFLICT DO NOTHING`,
      [ACTOR_A],
    );
    await env.admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode) VALUES
         ($1, $5, 'Tracked', 'standard', $7, $7, 'batch'), ($2, $5, 'Tracked 2', 'standard', $7, $7, 'batch'),
         ($3, $5, 'Untracked', 'standard', $7, $7, 'none'), ($4, $6, 'Tracked B', 'standard', $7, $7, 'batch')`,
      [PRODUCT_T, PRODUCT_T2, PRODUCT_UNTRACKED, PRODUCT_TB, TENANT_A, TENANT_B, ACTOR_A],
    );
    await env.admin.query(
      `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code) VALUES ($1, $2, $3, 'batch', 'B-LOT')`,
      [IDENTITY_B, TENANT_B, PRODUCT_TB],
    );
    const primaries = await env.admin.query<{ store_id: string; id: string }>(
      `SELECT store_id::text, id::text FROM stock_locations WHERE kind = 'primary' AND store_id = ANY($1::uuid[])`,
      [[STORE_A_X, STORE_A_Y]],
    );
    primaryAX = primaries.rows.find((r) => r.store_id === STORE_A_X)!.id;
    primaryAY = primaries.rows.find((r) => r.store_id === STORE_A_Y)!.id;
    await env.admin.query(
      `INSERT INTO stock_locations (id, tenant_id, store_id, code, name, kind, is_active)
       VALUES ($1, $2, $3, 'BACKROOM', 'Backroom', 'storage', true)`,
      [BACKROOM_A_X, TENANT_A, STORE_A_X],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env['MIGRATION_TEST_ALLOW_SKIP'] === '1') {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[inventory-safety] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  const pool = env.app as unknown as Pool;
  holds = new TrackingHoldsService(pool);
  recalls = new InventoryRecallsService(pool);
  expiry = new IdentityExpiryService(pool);
  profiles = new TrackingProfileService(pool);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn('[inventory-safety] skipping — Docker unavailable');
    return true;
  }
  return false;
}

describe('quality hold placement', () => {
  it('increments the Safety Revision exactly once, with one hold_placed change', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    const before = await revisionOf(TENANT_A);
    const result = await holds.placeQualityHold(placeInput(identity));
    expect(result.safetyRevision).toBe(before + 1);
    expect(await revisionOf(TENANT_A)).toBe(before + 1);
    expect(result.hold).toMatchObject({
      trackingIdentityId: identity,
      tenantProductRef: PRODUCT_T,
      kind: 'quality_hold',
      reasonCode: 'supplier_notice',
      recallId: null,
      placedBy: ACTOR_A,
      releasedAt: null,
      active: true,
    });
    const changes = await admin().query(
      `SELECT revision::int AS revision, kind, tracking_hold_id::text AS hold, tracking_identity_id::text AS identity
         FROM inventory_safety_changes WHERE tenant_id = $1 AND revision > $2`,
      [TENANT_A, before],
    );
    expect(changes.rows).toEqual([
      { revision: before + 1, kind: 'hold_placed', hold: result.hold.id, identity },
    ]);
  });

  it('moves every positive sellable / return_inspection position into quality_hold as erp_neutral effect pairs', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    await seedEffect({ identity: identity, storeId: STORE_A_X, locationId: primaryAX, status: 'sellable', quantity: '10' });
    await seedEffect({ identity: identity, storeId: STORE_A_Y, locationId: primaryAY, status: 'return_inspection', quantity: '4.5' });
    // A negative position stays where it is (a finding, never moved).
    await seedEffect({ identity: identity, storeId: STORE_A_X, locationId: BACKROOM_A_X, status: 'sellable', quantity: '-2' });
    // A damaged position is not a placement source.
    await seedEffect({ identity: identity, storeId: STORE_A_Y, locationId: primaryAY, status: 'damaged', quantity: '1' });

    const { hold } = await holds.placeQualityHold(placeInput(identity));

    expect(await positions(identity)).toEqual(
      [
        { store: STORE_A_X, location: BACKROOM_A_X, status: 'sellable', qty: '-2.0000' },
        { store: STORE_A_X, location: primaryAX, status: 'quality_hold', qty: '10.0000' },
        { store: STORE_A_Y, location: primaryAY, status: 'damaged', qty: '1.0000' },
        { store: STORE_A_Y, location: primaryAY, status: 'quality_hold', qty: '4.5000' },
      ].sort((a, b) => (`${a.store}${a.location}${a.status}` < `${b.store}${b.location}${b.status}` ? -1 : 1)),
    );
    const events = await admin().query(
      `SELECT kind, from_status, to_status, reason_code, quantity::text AS quantity,
              tracking_identity_id::text AS identity
         FROM inventory_position_events WHERE tracking_identity_id = $1 ORDER BY from_status`,
      [identity],
    );
    expect(events.rows).toEqual([
      { kind: 'status_move', from_status: 'return_inspection', to_status: 'quality_hold', reason_code: 'quality_hold', quantity: '4.5000', identity },
      { kind: 'status_move', from_status: 'sellable', to_status: 'quality_hold', reason_code: 'quality_hold', quantity: '10.0000', identity },
    ]);
    // Exactly two effects per event, both carrying the identity, both erp_neutral.
    const effects = await admin().query<{ n: number; neutral: number; with_identity: number; net: string }>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE i.state = 'erp_neutral')::int AS neutral,
              count(*) FILTER (WHERE m.tracking_identity_id = $1)::int AS with_identity,
              SUM(m.quantity)::text AS net
         FROM stock_movements m
         JOIN inventory_position_events e ON e.id = m.event_ref_id
         LEFT JOIN inventory_effect_integration i ON i.effect_id = m.id
        WHERE e.tracking_identity_id = $1`,
      [identity],
    );
    expect(effects.rows[0]).toEqual({ n: 4, neutral: 4, with_identity: 4, net: '0.0000' });
    expect(hold.active).toBe(true);
  });

  it('moves nothing for an identity without positions, and still steps the revision', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    const before = await writeCounts();
    await holds.placeQualityHold(placeInput(identity));
    const after = await writeCounts();
    expect(after['events']).toBe(before['events']);
    expect(Number(after['revision_sum'])).toBe(Number(before['revision_sum']) + 1);
  });

  it('replays the same command without writing; the same key for another command is a 409', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    await seedEffect({ identity: identity, storeId: STORE_A_X, locationId: primaryAX, status: 'sellable', quantity: '3' });
    const input = placeInput(identity);
    const first = await holds.placeQualityHold(input);
    const before = await writeCounts();
    const again = await holds.placeQualityHold(input);
    expect(again).toEqual(first);
    expect(await writeCounts()).toEqual(before);
    await expectNoWrites(() => holds.placeQualityHold({ ...input, reasonCode: 'other_reason' }), ConflictException);
  });

  it('refuses a second active quality hold on the identity (409), writing nothing', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    await holds.placeQualityHold(placeInput(identity));
    await expectNoWrites(() => holds.placeQualityHold(placeInput(identity)), ConflictException);
  });

  it("refuses another tenant's identity with a non-disclosing 404, writing nothing", async () => {
    if (maybeSkip()) return;
    await expectNoWrites(() => holds.placeQualityHold(placeInput(IDENTITY_B)), NotFoundException);
  });

  it('serializes concurrent placements on one identity: one hold, one revision step', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    const before = await revisionOf(TENANT_A);
    const results = await Promise.allSettled([
      holds.placeQualityHold(placeInput(identity)),
      holds.placeQualityHold(placeInput(identity)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(await revisionOf(TENANT_A)).toBe(before + 1);
  });
});

describe('hold release', () => {
  it('H3: returns quality_hold to sellable as hold_release pairs, steps the revision once, and is final', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    await seedEffect({ identity: identity, storeId: STORE_A_X, locationId: primaryAX, status: 'sellable', quantity: '6' });
    const { hold } = await holds.placeQualityHold(placeInput(identity));
    const before = await revisionOf(TENANT_A);

    const released = await holds.releaseHold({ tenantId: TENANT_A, userId: ACTOR_A, holdId: hold.id, note: 'cleared' });
    expect(released.safetyRevision).toBe(before + 1);
    expect(released.hold).toMatchObject({ active: false, releasedBy: ACTOR_A, releaseNote: 'cleared' });
    expect(await positions(identity)).toEqual([
      { store: STORE_A_X, location: primaryAX, status: 'sellable', qty: '6.0000' },
    ]);
    const releaseEvents = await admin().query(
      `SELECT reason_code, from_status, to_status FROM inventory_position_events
        WHERE tracking_identity_id = $1 AND reason_code = 'hold_release'`,
      [identity],
    );
    expect(releaseEvents.rows).toEqual([{ reason_code: 'hold_release', from_status: 'quality_hold', to_status: 'sellable' }]);

    // A second release is a no-op: same hold, same revision, nothing written.
    const counts = await writeCounts();
    const again = await holds.releaseHold({ tenantId: TENANT_A, userId: ACTOR_A, holdId: hold.id, note: null });
    expect(again).toEqual(released);
    expect(await writeCounts()).toEqual(counts);
  });

  it('H3 under an active recall: quality_hold goes to recall_hold, never back to sellable', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    await seedEffect({ identity: identity, storeId: STORE_A_X, locationId: primaryAX, status: 'sellable', quantity: '5' });
    const { hold } = await holds.placeQualityHold(placeInput(identity));
    await recalls.createRecall(recallInput([identity]));
    await holds.releaseHold({ tenantId: TENANT_A, userId: ACTOR_A, holdId: hold.id, note: null });
    expect(await positions(identity)).toEqual([
      { store: STORE_A_X, location: primaryAX, status: 'recall_hold', qty: '5.0000' },
    ]);
  });

  it("H4: releasing a recall hold ends the record and moves no quantity", async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    await seedEffect({ identity: identity, storeId: STORE_A_X, locationId: primaryAX, status: 'sellable', quantity: '2' });
    const { recall } = await recalls.createRecall(recallInput([identity]));
    const recallHold = recall.holds[0]!;
    const before = await writeCounts();
    const released = await holds.releaseHold({ tenantId: TENANT_A, userId: ACTOR_A, holdId: recallHold.id, note: null });
    expect(released.hold.active).toBe(false);
    const after = await writeCounts();
    expect(after['events']).toBe(before['events']);
    expect(Number(after['revision_sum'])).toBe(Number(before['revision_sum']) + 1);
    expect(await positions(identity)).toEqual([
      { store: STORE_A_X, location: primaryAX, status: 'recall_hold', qty: '2.0000' },
    ]);
  });

  it("is a non-disclosing 404 for another tenant's hold, writing nothing", async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    const { hold } = await holds.placeQualityHold(placeInput(identity));
    await expectNoWrites(
      () => holds.releaseHold({ tenantId: TENANT_B, userId: ACTOR_A, holdId: hold.id, note: null }),
      NotFoundException,
    );
    await expect(holds.getHold(TENANT_B, hold.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await holds.getHold(TENANT_A, hold.id)).id).toBe(hold.id);
  });
});

describe('recall', () => {
  it('a recall of 2 identities creates 2 recall holds and ONE revision step', async () => {
    if (maybeSkip()) return;
    const one = await newIdentity();
    const two = await newIdentity();
    await seedEffect({ identity: one, storeId: STORE_A_X, locationId: primaryAX, status: 'sellable', quantity: '7' });
    await seedEffect({ identity: two, storeId: STORE_A_Y, locationId: primaryAY, status: 'return_inspection', quantity: '1' });
    const before = await revisionOf(TENANT_A);

    const { recall, safetyRevision } = await recalls.createRecall(recallInput([one, two]));

    expect(safetyRevision).toBe(before + 1);
    expect(await revisionOf(TENANT_A)).toBe(before + 1);
    expect(recall).toMatchObject({ tenantProductRef: PRODUCT_T, reasonCode: 'authority_notice', reference: 'EDA-2026-117' });
    const byIdentity = (a: string[], b: string[]) => a[0]!.localeCompare(b[0]!);
    expect(recall.holds.map((h) => [h.trackingIdentityId, h.kind, h.recallId!]).sort(byIdentity)).toEqual(
      [
        [one, 'recall_hold', recall.id],
        [two, 'recall_hold', recall.id],
      ].sort(byIdentity),
    );
    const changes = await admin().query(
      `SELECT kind, inventory_recall_id::text AS recall FROM inventory_safety_changes WHERE tenant_id = $1 AND revision > $2`,
      [TENANT_A, before],
    );
    expect(changes.rows).toEqual([{ kind: 'recall_created', recall: recall.id }]);
    expect(await positions(one)).toEqual([{ store: STORE_A_X, location: primaryAX, status: 'recall_hold', qty: '7.0000' }]);
    expect(await positions(two)).toEqual([{ store: STORE_A_Y, location: primaryAY, status: 'recall_hold', qty: '1.0000' }]);
    expect((await recalls.getRecall(TENANT_A, recall.id)).holds).toHaveLength(2);
    await expect(recalls.getRecall(TENANT_B, recall.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('replays the same command without writing', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    const input = recallInput([identity]);
    const first = await recalls.createRecall(input);
    const before = await writeCounts();
    expect(await recalls.createRecall(input)).toEqual(first);
    expect(await writeCounts()).toEqual(before);
    await expectNoWrites(() => recalls.createRecall({ ...input, reference: 'EDA-OTHER' }), ConflictException);
  });

  it('refuses duplicate identities (400), writing nothing', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    await expectNoWrites(() => recalls.createRecall(recallInput([identity, identity])), BadRequestException);
  });

  it('refuses a future effective time (400), writing nothing', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await expectNoWrites(() => recalls.createRecall(recallInput([identity], { effectiveAt: future })), BadRequestException);
  });

  it('refuses an effective time before year 1, which Postgres cannot store (400, not 500), writing nothing', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    await expectNoWrites(
      () => recalls.createRecall(recallInput([identity], { effectiveAt: '0000-01-01T00:00:00Z' })),
      BadRequestException,
    );
  });

  it("refuses an identity of another product or tenant with a non-disclosing 404, writing nothing", async () => {
    if (maybeSkip()) return;
    const mine = await newIdentity();
    const otherProduct = await newIdentity(PRODUCT_T2);
    await expectNoWrites(() => recalls.createRecall(recallInput([mine, otherProduct])), NotFoundException);
    await expectNoWrites(() => recalls.createRecall(recallInput([mine, IDENTITY_B])), NotFoundException);
    await expectNoWrites(
      () => recalls.createRecall(recallInput([mine], { tenantProductRef: PRODUCT_TB })),
      NotFoundException,
    );
  });

  it('refuses an identity already under an active recall hold (409), writing nothing', async () => {
    if (maybeSkip()) return;
    const held = await newIdentity();
    const fresh = await newIdentity();
    await recalls.createRecall(recallInput([held]));
    await expectNoWrites(() => recalls.createRecall(recallInput([fresh, held])), ConflictException);
  });
});

describe('identity expiry correction (G7-2)', () => {
  function correction(identityId: string, fields: { readonly expiryDate: string | null }) {
    return { ...base(), trackingIdentityId: identityId, reasonCode: 'label_misprint', note: null, ...fields };
  }

  it('keeps its history: every correction is a row (old -> new) and a revision step', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity(PRODUCT_T, { expiry: '2027-01-31' });
    const before = await revisionOf(TENANT_A);
    const first = await expiry.correctExpiry(correction(identity, { expiryDate: '2027-03-31' }));
    const second = await expiry.correctExpiry(correction(identity, { expiryDate: null }));
    expect(first.correction).toMatchObject({ oldExpiryDate: '2027-01-31', newExpiryDate: '2027-03-31' });
    expect(second.correction).toMatchObject({ oldExpiryDate: '2027-03-31', newExpiryDate: null });
    expect([first.safetyRevision, second.safetyRevision]).toEqual([before + 1, before + 2]);
    const history = await admin().query(
      `SELECT old_expiry_date::text AS old, new_expiry_date::text AS new FROM tracking_identity_expiry_corrections
        WHERE tracking_identity_id = $1 ORDER BY created_at, old_expiry_date NULLS LAST`,
      [identity],
    );
    expect(history.rows).toEqual([
      { old: '2027-01-31', new: '2027-03-31' },
      { old: '2027-03-31', new: null },
    ]);
    const current = await admin().query(`SELECT expiry_date FROM tracking_identities WHERE id = $1`, [identity]);
    expect(current.rows[0]).toEqual({ expiry_date: null });
    const changes = await admin().query(
      `SELECT kind FROM inventory_safety_changes WHERE tenant_id = $1 AND revision > $2 ORDER BY revision`,
      [TENANT_A, before],
    );
    expect(changes.rows).toEqual([{ kind: 'expiry_corrected' }, { kind: 'expiry_corrected' }]);
  });

  it('replays the same command without writing', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity(PRODUCT_T, { expiry: '2027-01-31' });
    const input = correction(identity, { expiryDate: '2027-02-28' });
    const first = await expiry.correctExpiry(input);
    const before = await writeCounts();
    expect(await expiry.correctExpiry(input)).toEqual(first);
    expect(await writeCounts()).toEqual(before);
  });

  it('refuses an unchanged expiry (409) and one before manufacture (400), writing nothing', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity(PRODUCT_T, { expiry: '2027-01-31', manufacturedOn: '2026-01-01' });
    await expectNoWrites(() => expiry.correctExpiry(correction(identity, { expiryDate: '2027-01-31' })), ConflictException);
    await expectNoWrites(() => expiry.correctExpiry(correction(identity, { expiryDate: '2025-12-31' })), BadRequestException);
  });

  it("refuses another tenant's identity with a non-disclosing 404, writing nothing", async () => {
    if (maybeSkip()) return;
    await expectNoWrites(() => expiry.correctExpiry(correction(IDENTITY_B, { expiryDate: '2027-01-31' })), NotFoundException);
  });
});

describe('tracking-profile change (G7-7)', () => {
  it('steps the revision once when the profile changes, and not when it is set unchanged', async () => {
    if (maybeSkip()) return;
    const before = await revisionOf(TENANT_A);
    const set = () =>
      profiles.set({ tenantId: TENANT_A, productId: PRODUCT_T2, trackingMode: 'none', expiryRequired: false, actorUserId: ACTOR_A });
    // PRODUCT_T2 has identities but no effect or sale line: batch -> none is allowed.
    expect((await set()).kind).toBe('ok');
    expect(await revisionOf(TENANT_A)).toBe(before + 1);
    const change = await admin().query(
      `SELECT kind, tenant_product_ref::text AS product FROM inventory_safety_changes WHERE tenant_id = $1 AND revision = $2`,
      [TENANT_A, before + 1],
    );
    expect(change.rows).toEqual([{ kind: 'tracking_profile_changed', product: PRODUCT_T2 }]);
    expect((await set()).kind).toBe('ok');
    expect(await revisionOf(TENANT_A)).toBe(before + 1);
  });
});

describe('store scope', () => {
  it('a hold reaches the identity at every store of the tenant, never another tenant', async () => {
    if (maybeSkip()) return;
    const identity = await newIdentity();
    await seedEffect({ identity: identity, storeId: STORE_A_X, locationId: primaryAX, status: 'sellable', quantity: '1' });
    await seedEffect({ identity: identity, storeId: STORE_A_Y, locationId: primaryAY, status: 'sellable', quantity: '1' });
    const bBefore = await admin().query(`SELECT count(*)::int AS n FROM stock_movements WHERE store_id = $1`, [STORE_B_X]);
    await holds.placeQualityHold(placeInput(identity));
    expect((await positions(identity)).map((p) => [p.store, p.status])).toEqual([
      [STORE_A_X, 'quality_hold'],
      [STORE_A_Y, 'quality_hold'],
    ]);
    const bAfter = await admin().query(`SELECT count(*)::int AS n FROM stock_movements WHERE store_id = $1`, [STORE_B_X]);
    expect(bAfter.rows).toEqual(bBefore.rows);
  });
});
