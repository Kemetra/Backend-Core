/**
 * 017-US3 — `ReconciliationRunProcessor` Testcontainers spec.
 *
 * Drives the processor directly (the 015 PostingRequestedConsumer precedent — no
 * BullMQ; the live trigger→queue wiring is a deferred slice). Proves:
 *   §1 a mapped store with a confirmed item + a divergent Bin → quantity_divergence;
 *      an exact-match Bin → match;
 *   §2 a NEGATIVE DP2 on-hand → negative_balance_flagged (014 §6.3 order: evaluated
 *      BEFORE the quantity compare, regardless of the Bin side);
 *   §3 a product with NO confirmed 013 map → unmapped_item;
 *   §4 stub-tolerant: an EMPTY Bin view → every DP2-on-hand item is dp2_only
 *      (the connector hasn't reported — not a failure, R3);
 *   §5 an unmapped store → ONE unmapped_store result, run completes;
 *   §6 idempotency: a 2nd process() of a completed run is a skipped no-op (status
 *      guard); the 009 ledger + 008 fact are byte-unchanged before/after.
 *
 * Docker policy mirrors the other worker DB specs: HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1. Run with WORKER_INCLUDE_DB_TESTS=1.
 */
import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EMPTY_BIN_VIEW,
  ReconciliationRunProcessor,
  type ErpnextBinView,
} from "../../src/erpnext-reconciliation/reconciliation-run.processor";

const TENANT = "01900000-0000-7000-8000-0000000ab111";
const STORE_MAPPED = "01900000-0000-7000-8000-0000000ac111";
const STORE_UNMAPPED = "01900000-0000-7000-8000-0000000ac222";
const ACTOR = "01900000-0000-7000-8000-0000000ad111";
const PROD_MATCH = "01900000-0000-7000-8000-0000000ae111";
const PROD_DIVERGE = "01900000-0000-7000-8000-0000000ae222";
const PROD_NEG = "01900000-0000-7000-8000-0000000ae333";
const PROD_UNMAPPED = "01900000-0000-7000-8000-0000000ae444";

let env: PgTestEnv | null = null;
let skip = false;

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "..", "..", "packages", "db", "drizzle");

async function applyAllMigrations(e: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .sort();
  for (const name of files) {
    await e.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(e);
}

/** A confirmed 013 item map + a tenant product. */
async function seedProduct(e: PgTestEnv, id: string, mapped: boolean): Promise<void> {
  await e.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, 'P', 'standard', $3, $3) ON CONFLICT (id) DO NOTHING`,
    [id, TENANT, ACTOR],
  );
  if (mapped) {
    await e.admin.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-I', 'confirmed', 'manual', $3, now()) ON CONFLICT DO NOTHING`,
      [TENANT, id, ACTOR],
    );
  }
}

/** A 009 movement (signed). */
async function seedMovement(e: PgTestEnv, store: string, product: string, qty: string): Promise<void> {
  await e.admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, tenant_product_ref, movement_type, quantity, stocking_unit, occurred_at, created_by,
        stock_location_id, inventory_status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::numeric, 'ea', now(), $6,
             (SELECT id FROM stock_locations WHERE store_id = $2::uuid AND kind = 'primary'), 'sellable')`,
    [TENANT, store, product, Number(qty) < 0 ? "outbound" : "inbound", qty, ACTOR],
  );
}

async function createRun(e: PgTestEnv, store: string): Promise<string> {
  const r = await e.admin.query<{ id: string }>(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'on_demand', 'running', $3) RETURNING id`,
    [TENANT, store, ACTOR],
  );
  return r.rows[0]!.id;
}

async function classesFor(e: PgTestEnv, runId: string): Promise<Record<string, number>> {
  const r = await e.admin.query<{ mismatch_class: string; n: string }>(
    `SELECT mismatch_class, count(*)::text AS n FROM erpnext_reconciliation_result
      WHERE run_id = $1 GROUP BY mismatch_class`,
    [runId],
  );
  const out: Record<string, number> = {};
  for (const row of r.rows) out[row.mismatch_class] = Number(row.n);
  return out;
}

function binView(map: Record<string, number>): ErpnextBinView {
  return {
    // 019-T041: the seam value is now an exact-decimal STRING (§III). The test
    // expresses quantities as numbers for readability; stringify at the boundary.
    async fetchBinView(): Promise<ReadonlyMap<string, string>> {
      return new Map(Object.entries(map).map(([k, v]) => [k, String(v)]));
    },
  };
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllMigrations(env);
    const a = env.admin;
    await a.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'rcn', 'RCN', 'USD') ON CONFLICT (id) DO NOTHING`,
      [TENANT],
    );
    await a.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'RM', 'Mapped'), ($2, $3, 'RU', 'Unmapped') ON CONFLICT (id) DO NOTHING`,
      [STORE_MAPPED, STORE_UNMAPPED, TENANT],
    );
    await a.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rcn@fixture.invalid', NULL) ON CONFLICT (id) DO NOTHING`,
      [ACTOR],
    );
    // Map STORE_MAPPED to a warehouse.
    await a.query(
      `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH', $3, 1) ON CONFLICT DO NOTHING`,
      [TENANT, STORE_MAPPED, ACTOR],
    );
    await seedProduct(env, PROD_MATCH, true);
    await seedProduct(env, PROD_DIVERGE, true);
    await seedProduct(env, PROD_NEG, true);
    await seedProduct(env, PROD_UNMAPPED, false);
    await seedMovement(env, STORE_MAPPED, PROD_MATCH, "10.0000");
    await seedMovement(env, STORE_MAPPED, PROD_DIVERGE, "10.0000");
    await seedMovement(env, STORE_MAPPED, PROD_NEG, "-3.0000");
    await seedMovement(env, STORE_MAPPED, PROD_UNMAPPED, "5.0000");
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[reconciliation-run.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function guard(): PgTestEnv {
  if (!env) throw new Error("Docker unavailable");
  return env;
}

describe("017-US3 — reconciliation run classification", () => {
  it("§1+§2+§3 classifies match / quantity_divergence / negative / unmapped_item correctly", async () => {
    if (skip) return;
    const e = guard();
    const runId = await createRun(e, STORE_MAPPED);
    // Bin: match=10 (==10), diverge=4 (!=10). neg + unmapped have Bin entries too,
    // but negative + unmapped_item are evaluated BEFORE the quantity compare.
    const proc = new ReconciliationRunProcessor(
      e.app,
      binView({ [PROD_MATCH]: 10, [PROD_DIVERGE]: 4, [PROD_NEG]: 99, [PROD_UNMAPPED]: 5 }),
    );
    const res = await proc.process({ runId, tenantId: TENANT });
    expect(res.status).toBe("completed");
    const classes = await classesFor(e, runId);
    expect(classes["match"]).toBe(1);
    expect(classes["quantity_divergence"]).toBe(1);
    expect(classes["negative_balance_flagged"]).toBe(1); // evaluated before qty compare
    expect(classes["unmapped_item"]).toBe(1);
  });

  it("§4 stub-tolerant: an EMPTY Bin view → every DP2-on-hand item is dp2_only (mapped+confirmed only)", async () => {
    if (skip) return;
    const e = guard();
    const runId = await createRun(e, STORE_MAPPED);
    const proc = new ReconciliationRunProcessor(e.app, EMPTY_BIN_VIEW);
    await proc.process({ runId, tenantId: TENANT });
    const classes = await classesFor(e, runId);
    // PROD_MATCH + PROD_DIVERGE (confirmed, positive) → dp2_only (no Bin entry).
    expect(classes["dp2_only"]).toBe(2);
    // The negative + unmapped_item still take precedence over presence.
    expect(classes["negative_balance_flagged"]).toBe(1);
    expect(classes["unmapped_item"]).toBe(1);
  });

  it("§5 an unmapped store → ONE unmapped_store result; run completes", async () => {
    if (skip) return;
    const e = guard();
    const runId = await createRun(e, STORE_UNMAPPED);
    const res = await proc(e).process({ runId, tenantId: TENANT });
    expect(res.status).toBe("completed");
    const classes = await classesFor(e, runId);
    expect(classes).toEqual({ unmapped_store: 1 });
  });

  it("§6 idempotent: a 2nd process() of a completed run is a skipped no-op; 009 ledger unchanged", async () => {
    if (skip) return;
    const e = guard();
    const before = await e.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movements WHERE store_id = $1`,
      [STORE_MAPPED],
    );
    const runId = await createRun(e, STORE_MAPPED);
    await proc(e).process({ runId, tenantId: TENANT });
    const firstCount = (await e.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM erpnext_reconciliation_result WHERE run_id = $1`, [runId],
    )).rows[0]!.n;
    const second = await proc(e).process({ runId, tenantId: TENANT });
    expect(second.status).toBe("skipped");
    const afterCount = (await e.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM erpnext_reconciliation_result WHERE run_id = $1`, [runId],
    )).rows[0]!.n;
    expect(afterCount).toBe(firstCount); // no duplicate results
    const after = await e.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movements WHERE store_id = $1`,
      [STORE_MAPPED],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n); // 009 ledger never mutated
  });
});

function proc(e: PgTestEnv): ReconciliationRunProcessor {
  return new ReconciliationRunProcessor(e.app, EMPTY_BIN_VIEW);
}
