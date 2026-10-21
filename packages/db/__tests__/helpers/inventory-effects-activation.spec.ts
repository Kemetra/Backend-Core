/**
 * RT-427 — sale-effects activation with the Inventory Anchor, and the
 * read-only anchor-vs-Bin comparison (owner decisions 3, 4, 6), against a real
 * Postgres with every migration applied.
 *
 * Every call runs on the non-superuser `app_test` pool inside
 * `runWithTenantContext` (RLS + FORCE), as the CLI does; fixtures are seeded on
 * the superuser pool. Each case uses its own tenant so preconditions do not
 * leak between cases.
 *
 * Proves:
 *   - each decision-3 precondition refuses with its code and stores, and
 *     writes nothing;
 *   - success: one generation-1 anchor per store from the latest complete
 *     snapshot, lines only for Items that map to exactly one product, exact
 *     Bin quantities, coverage of the absorbed movements, the flag set, and
 *     no movement written (no backfill); a second activation is refused;
 *   - the effect writers see the flag right after;
 *   - comparison: anchor + effects since activation vs the latest Bin;
 *   - RLS: another tenant's context sees no anchor and cannot activate it;
 *   - activation waits for an in-flight writer's SHARED settings lock.
 */
import type { PoolClient } from "pg";

import { activateSaleEffects, compareAnchorsToBin } from "../../src/helpers/inventory-effects/activation";
import { readSaleEffectsActivation } from "../../src/helpers/inventory-effects/sale-effects";
import { runWithTenantContext } from "../../src/middleware/tenant-context";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const ACTOR = "0a000000-0000-7000-8000-000000427c00";

let env: PgTestEnv | null = null;
let seq = 0;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

function uuid(): string {
  seq += 1;
  return `0a000000-0000-7000-8000-${(0x427c00000000 + seq).toString(16)}`;
}

interface StoreOpts {
  readonly mapped?: boolean;
  readonly snapshot?: boolean;
  /** The warehouse the snapshot read (default: the mapped one). */
  readonly snapshotWarehouse?: string;
  readonly readAt?: string;
  readonly entries?: ReadonlyArray<{ item: string; quantity: string }>;
}

interface Fixture {
  readonly tenantId: string;
  readonly storeIds: string[];
  readonly products: Record<string, string>;
  readonly runIds: string[];
}

/** A tenant with products P1, P2 (ITEM-1, ITEM-2), P3 + P4 sharing ITEM-AMB, and the given stores. */
async function seedTenant(stores: readonly StoreOpts[]): Promise<Fixture> {
  const a = pg().admin;
  const tenantId = uuid();
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenantId, `rt427-act-${seq}`]);
  const products: Record<string, string> = {};
  for (const [name, item] of [
    ["P1", "ITEM-1"],
    ["P2", "ITEM-2"],
    ["P3", "ITEM-AMB"],
    ["P4", "ITEM-AMB"],
  ] as const) {
    const id = uuid();
    products[name] = id;
    await a.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by) VALUES ($1, $2, $3, 'standard', $4, $4)`,
      [id, tenantId, name, ACTOR],
    );
    await a.query(
      `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now())`,
      [tenantId, id, item, ACTOR],
    );
  }
  const storeIds: string[] = [];
  const runIds: string[] = [];
  for (const [i, s] of stores.entries()) {
    const storeId = uuid();
    storeIds.push(storeId);
    const warehouse = `WH-${seq}-${i}`;
    await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, 'S')`, [storeId, tenantId, `S${seq}`]);
    if (s.mapped !== false) {
      await a.query(
        `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
         VALUES (gen_random_uuid(), $1, $2, 'stock', $3, $4, 1)`,
        [tenantId, storeId, warehouse, ACTOR],
      );
    }
    if (s.snapshot !== false) runIds.push(await seedRun(tenantId, storeId, s.snapshotWarehouse ?? warehouse, s));
  }
  return { tenantId, storeIds, products, runIds };
}

async function seedRun(tenantId: string, storeId: string, warehouse: string, s: StoreOpts): Promise<string> {
  const runId = uuid();
  const readAt = s.readAt ?? new Date().toISOString();
  const entries = (s.entries ?? [
    { item: "ITEM-1", quantity: "10.500000" },
    { item: "ITEM-2", quantity: "-1" },
    { item: "ITEM-AMB", quantity: "4" },
    { item: "ITEM-NONE", quantity: "7" },
  ]).map((e) => ({ erpnextItemRef: e.item, quantity: e.quantity, stockUom: "Nos" }));
  const report = {
    requestRef: uuid(),
    runRef: runId,
    erpnextWarehouseRef: warehouse,
    attemptRef: null,
    readAt,
    recordedAt: readAt,
    complete: true,
    windowsRecorded: 1,
    acceptedEntryCount: entries.length,
    windows: [],
    entries,
    supersededAttemptRefs: [],
  };
  await pg().admin.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at, summary)
     VALUES ($1, $2, $3, 'stock', 'on_demand', 'completed', now(), $4::jsonb)`,
    [runId, tenantId, storeId, JSON.stringify({ bin_view_report: report })],
  );
  return runId;
}

async function seedPosting(f: Fixture, status: string, postedAt: string | null): Promise<void> {
  const saleId = uuid();
  const storeId = f.storeIds[0]!;
  await pg().admin.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 0, now(), current_date, 'pos', $4, $5, $6)`,
    [saleId, f.tenantId, storeId, `x-${saleId}`, "0".repeat(64), ACTOR],
  );
  await pg().admin.query(
    `INSERT INTO erpnext_posting_status (tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id,
                                         payload_hash, status, document_ref, posted_at)
     VALUES ($1, $2, $3, 'sale_post', $3, 'pos', $4, $5, $6, CASE WHEN $6 = 'posted' THEN '{"name":"SINV"}' END, $7)`,
    [f.tenantId, storeId, saleId, `x-${saleId}`, "0".repeat(64), status, postedAt],
  );
}

function asTenant<T>(tenantId: string, work: (c: PoolClient) => Promise<T>): Promise<T> {
  return runWithTenantContext(pg().app, { tenantId, isPlatformAdmin: false }, work);
}

async function counts(tenantId: string): Promise<[number, number, boolean]> {
  const r = await pg().admin.query<{ anchors: number; movements: number; active: boolean }>(
    `SELECT (SELECT count(*)::int FROM inventory_anchors WHERE tenant_id = $1) AS anchors,
            (SELECT count(*)::int FROM stock_movements WHERE tenant_id = $1) AS movements,
            COALESCE((SELECT sale_effects_activated_at IS NOT NULL FROM tenant_inventory_settings WHERE tenant_id = $1), false) AS active`,
    [tenantId],
  );
  const row = r.rows[0]!;
  return [row.anchors, row.movements, row.active];
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[inventory-effects-activation.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("activation preconditions (decision 3)", () => {
  it.each<[string, () => Promise<Fixture>, number]>([
    ["no_stores", () => seedTenant([]), 0],
    ["store_unmapped", () => seedTenant([{}, { mapped: false, snapshot: false }]), 1],
    ["no_snapshot", () => seedTenant([{ snapshot: false }]), 0],
    ["snapshot_remapped", () => seedTenant([{ snapshotWarehouse: "WH-OLD" }]), 0],
  ])("refuses %s and writes nothing", async (code, seed, failingStore) => {
    if (skip()) return;
    const f = await seed();
    const outcome = await asTenant(f.tenantId, (c) => activateSaleEffects(c, { tenantId: f.tenantId, actorId: ACTOR }));
    expect(outcome).toEqual({
      kind: "refused",
      refusal: { code, storeIds: code === "no_stores" ? [] : [f.storeIds[failingStore]] },
    });
    expect(await counts(f.tenantId)).toEqual([0, 0, false]);
  });

  it("refuses postings_in_flight while a posting row is pending", async () => {
    if (skip()) return;
    const f = await seedTenant([{}]);
    await seedPosting(f, "pending", null);
    const outcome = await asTenant(f.tenantId, (c) => activateSaleEffects(c, { tenantId: f.tenantId, actorId: ACTOR }));
    expect(outcome).toEqual({ kind: "refused", refusal: { code: "postings_in_flight", storeIds: [f.storeIds[0]] } });
  });

  it("refuses snapshot_stale when a document posted after the snapshot was read", async () => {
    if (skip()) return;
    const f = await seedTenant([{ readAt: "2026-10-20T10:00:00.000Z" }]);
    await seedPosting(f, "posted", "2026-10-20T11:00:00.000Z");
    const outcome = await asTenant(f.tenantId, (c) => activateSaleEffects(c, { tenantId: f.tenantId, actorId: ACTOR }));
    expect(outcome).toEqual({ kind: "refused", refusal: { code: "snapshot_stale", storeIds: [f.storeIds[0]] } });
  });

  it("refuses posting_intents_undelivered while an erpnext.posting.requested intent is undelivered", async () => {
    if (skip()) return;
    const f = await seedTenant([{}]);
    await pg().admin.query(
      `INSERT INTO outbox_events (event_id, tenant_id, store_id, event_type, payload)
       VALUES (gen_random_uuid(), $1, $2, 'erpnext.posting.requested', $3::jsonb)`,
      [f.tenantId, f.storeIds[0], JSON.stringify({ source_ref_id: uuid() })],
    );
    const outcome = await asTenant(f.tenantId, (c) => activateSaleEffects(c, { tenantId: f.tenantId, actorId: ACTOR }));
    expect(outcome).toEqual({ kind: "refused", refusal: { code: "posting_intents_undelivered", storeIds: [] } });
  });
});

describe("activation", () => {
  it("anchors every store from its snapshot, sets the flag, backfills nothing; a second run is refused", async () => {
    if (skip()) return;
    const f = await seedTenant([{}, {}]);
    // A pre-activation manual movement at the first store (absorbed, Q3).
    const primary = (
      await pg().admin.query<{ id: string }>(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [
        f.storeIds[0],
      ])
    ).rows[0]!.id;
    await pg().admin.query(
      `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref,
                                    occurred_at, created_by, stock_location_id, inventory_status)
       VALUES (gen_random_uuid(), $1, $2, 'inbound', 3, 'Nos', $3, now(), $4, $5, 'sellable')`,
      [f.tenantId, f.storeIds[0], f.products["P1"], ACTOR, primary],
    );
    await seedPosting(f, "posted", "2020-01-01T00:00:00.000Z");

    const outcome = await asTenant(f.tenantId, (c) => activateSaleEffects(c, { tenantId: f.tenantId, actorId: ACTOR }));
    expect(outcome.kind).toBe("activated");
    if (outcome.kind !== "activated") return;
    expect(outcome.stores.map((s) => [s.storeId, s.generation, s.sourceRunId, s.lines, s.unmappedBinItems])).toEqual(
      f.storeIds.map((id, i) => [id, 1, f.runIds[i], 2, 2]),
    );
    expect(outcome.stores.map((s) => s.absorbedMovements)).toEqual([1, 0]);
    // One movement (the manual one), no backfill; two anchors; the flag is ON.
    expect(await counts(f.tenantId)).toEqual([2, 1, true]);

    const lines = await pg().admin.query<{ product: string; quantity: string; uom: string; item: string }>(
      `SELECT l.tenant_product_ref AS product, l.quantity::text AS quantity, l.erp_stock_uom AS uom, l.erpnext_item_ref AS item
         FROM inventory_anchor_lines l JOIN inventory_anchors a ON a.id = l.anchor_id
        WHERE a.store_id = $1 ORDER BY l.erpnext_item_ref`,
      [f.storeIds[0]],
    );
    expect(lines.rows).toEqual([
      { product: f.products["P1"], quantity: "10.500000", uom: "Nos", item: "ITEM-1" },
      { product: f.products["P2"], quantity: "-1.000000", uom: "Nos", item: "ITEM-2" },
    ]);
    const anchor = await pg().admin.query<{ coverage: Record<string, unknown>; activated_at: Date; created_by: string }>(
      `SELECT coverage, activated_at, created_by FROM inventory_anchors WHERE store_id = $1`,
      [f.storeIds[0]],
    );
    expect(anchor.rows[0]!.coverage).toMatchObject({
      preActivationMovements: { count: 1 },
      binEntries: 4,
      unmappedBinItems: 2,
    });
    expect(anchor.rows[0]!.activated_at.toISOString()).toBe(outcome.activatedAt);
    expect(anchor.rows[0]!.created_by).toBe(ACTOR);

    expect(await asTenant(f.tenantId, (c) => readSaleEffectsActivation(c, f.tenantId))).toBe(true);
    const again = await asTenant(f.tenantId, (c) => activateSaleEffects(c, { tenantId: f.tenantId, actorId: ACTOR }));
    expect(again).toEqual({ kind: "refused", refusal: { code: "already_active", storeIds: [] } });
  });

  it("compares anchor + effects since activation with the latest Bin", async () => {
    if (skip()) return;
    const f = await seedTenant([{}]);
    await asTenant(f.tenantId, (c) => activateSaleEffects(c, { tenantId: f.tenantId, actorId: ACTOR }));
    const storeId = f.storeIds[0]!;
    const primary = (
      await pg().admin.query<{ id: string }>(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [storeId])
    ).rows[0]!.id;
    // An effect after activation (-2 of P1), and a newer Bin snapshot (P1 = 8.5).
    await pg().admin.query(
      `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref,
                                    occurred_at, created_by, stock_location_id, inventory_status)
       VALUES (gen_random_uuid(), $1, $2, 'outbound', -2, 'Nos', $3, now(), $4, $5, 'sellable')`,
      [f.tenantId, storeId, f.products["P1"], ACTOR, primary],
    );
    const mapped = (
      await pg().admin.query<{ ref: string }>(
        `SELECT erpnext_warehouse_ref AS ref FROM erpnext_warehouse_map WHERE store_id = $1`,
        [storeId],
      )
    ).rows[0]!.ref;
    await seedRun(f.tenantId, storeId, mapped, {
      readAt: new Date(Date.now() + 60_000).toISOString(),
      entries: [{ item: "ITEM-1", quantity: "8.5" }],
    });
    const rows = await asTenant(f.tenantId, (c) => compareAnchorsToBin(c));
    const p1 = rows.find((r) => r.tenantProductRef === f.products["P1"]);
    expect(p1).toMatchObject({
      storeId,
      anchorGeneration: 1,
      anchorQuantity: "10.500000",
      effectsSinceAnchor: "-2.0000",
      unconfirmedEffects: "-2.0000",
      expectedQuantity: "8.500000",
      latestBinQuantity: "8.5",
      difference: "0.000000",
      uomMismatch: false,
    });
    const p2 = rows.find((r) => r.tenantProductRef === f.products["P2"]);
    expect(p2).toMatchObject({ anchorQuantity: "-1.000000", latestBinQuantity: null, difference: null });
  });
});

describe("isolation and locking", () => {
  it("another tenant's context sees no anchor and its activation touches nothing of this tenant", async () => {
    if (skip()) return;
    const a = await seedTenant([{}]);
    const b = await seedTenant([]);
    await asTenant(a.tenantId, (c) => activateSaleEffects(c, { tenantId: a.tenantId, actorId: ACTOR }));
    const seen = await asTenant(b.tenantId, async (c) => [
      (await c.query(`SELECT 1 FROM inventory_anchors`)).rowCount,
      (await compareAnchorsToBin(c)).length,
    ]);
    expect(seen).toEqual([0, 0]);
    // Asked for tenant A from B's context: RLS hides A's stores, so nothing is anchored.
    const outcome = await asTenant(b.tenantId, (c) => activateSaleEffects(c, { tenantId: a.tenantId, actorId: ACTOR }));
    expect(outcome).toEqual({ kind: "refused", refusal: { code: "no_stores", storeIds: [] } });
    expect(await counts(a.tenantId)).toEqual([1, 0, true]);
  });

  it("waits for an in-flight writer's SHARED settings lock", async () => {
    if (skip()) return;
    const f = await seedTenant([{}]);
    const writer = await pg().admin.connect();
    const activator = await pg().app.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('tenant_inventory_settings:' || $1::text, 0))`, [
        f.tenantId,
      ]);
      await activator.query("BEGIN");
      await activator.query(`SET LOCAL lock_timeout = '300ms'`);
      await activator.query(`SELECT set_config('app.current_tenant', $1, true)`, [f.tenantId]);
      const code = await activateSaleEffects(activator, { tenantId: f.tenantId, actorId: ACTOR }).then(
        () => null,
        (err: { code?: string }) => err.code ?? "unknown",
      );
      expect(code).toBe("55P03");
    } finally {
      await activator.query("ROLLBACK").catch(() => undefined);
      await writer.query("ROLLBACK").catch(() => undefined);
      activator.release();
      writer.release();
    }
    expect(await counts(f.tenantId)).toEqual([0, 0, false]);
  });
});
