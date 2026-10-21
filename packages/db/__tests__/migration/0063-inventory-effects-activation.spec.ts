/**
 * 0063 — sale-effects activation flag and Inventory Anchors (Jira RT-427;
 * owner approval 2026-10-21: migration 0063 as proposed).
 *
 * Applies every migration before 0063 against a real Postgres, seeds two
 * tenants with a store each (the stores trigger gives each a primary
 * location), a product and a stock reconciliation run per tenant, applies
 * 0063, then proves:
 *   - tenant_inventory_settings: the activation columns default to NULL (OFF)
 *     and are both set or both NULL;
 *   - inventory_anchors: generation >= 1, a closed status, a bounded warehouse
 *     reference, an object coverage, one anchor per (tenant, store,
 *     generation), and the location tied to the anchor's store and tenant;
 *   - inventory_anchor_lines: one line per (anchor, product), the anchor and
 *     the product of the line's tenant, an exact 6-decimal quantity;
 *   - RLS: ENABLE + FORCE, SELECT + INSERT only, fail-closed and
 *     tenant-scoped;
 *   - down refuses while an anchor or an activated tenant exists and
 *     round-trips with up.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0063_inventory_effects_activation.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0063_inventory_effects_activation.down.sql");

const TENANT = "0a000000-0000-7000-8000-000000042701";
const TENANT_B = "0b000000-0000-7000-8000-000000042701";
const STORE = "0a000000-0000-7000-8000-000000042702";
const STORE_2 = "0a000000-0000-7000-8000-000000042703";
const STORE_B = "0b000000-0000-7000-8000-000000042702";
const ACTOR = "0a000000-0000-7000-8000-000000042704";
const PRODUCT = "0a000000-0000-7000-8000-000000042710";
const PRODUCT_B = "0b000000-0000-7000-8000-000000042710";
const RUN = "0a000000-0000-7000-8000-000000042720";
const RUN_B = "0b000000-0000-7000-8000-000000042720";
const ANCHOR = "0a000000-0000-7000-8000-000000042730";

let env: PgTestEnv | null = null;
const primaries = new Map<string, string>();

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const skip = (): boolean => env === null;

async function applyBefore0063(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
}

interface AnchorRow {
  readonly id?: string;
  readonly tenantId?: string;
  readonly storeId?: string;
  readonly location?: string;
  readonly status?: string;
  readonly generation?: number;
  readonly runId?: string;
  readonly warehouseRef?: string;
  readonly coverage?: string;
}

const ANCHOR_SQL = `INSERT INTO inventory_anchors
       (id, tenant_id, store_id, stock_location_id, inventory_status, generation, source_run_id,
        snapshot_read_at, snapshot_recorded_at, erpnext_warehouse_ref, activated_at, coverage, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8, now(), $9::jsonb, $10)`;

function anchorParams(row: AnchorRow): unknown[] {
  const storeId = row.storeId ?? STORE;
  return [
    row.id ?? ANCHOR,
    row.tenantId ?? TENANT,
    storeId,
    row.location ?? primaries.get(storeId)!,
    row.status ?? "sellable",
    row.generation ?? 1,
    row.runId ?? RUN,
    row.warehouseRef ?? "Stores - A",
    row.coverage ?? "{}",
    ACTOR,
  ];
}

const LINE_SQL = `INSERT INTO inventory_anchor_lines
       (id, anchor_id, tenant_id, tenant_product_ref, quantity, erp_stock_uom, erpnext_item_ref)
     VALUES (gen_random_uuid(), $1, $2, $3, $4::numeric, $5, $6)`;

/** Run `fn` on one superuser connection in a transaction that is always rolled back. */
async function inRolledBackTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pg().admin.connect();
  try {
    await client.query("BEGIN");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

async function tryAnchor(row: AnchorRow): Promise<string | null> {
  return inRolledBackTx((c) => errorCode(() => c.query(ANCHOR_SQL, anchorParams(row))));
}

/** Runs `fn` as the non-superuser app role with `app.current_tenant` set to `guc`, then rolls back. */
async function asApp<T>(guc: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pg().app.connect();
  try {
    await client.query("BEGIN");
    if (guc !== null) await client.query("SELECT set_config('app.current_tenant', $1, true)", [guc]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const TABLES = ["inventory_anchor_lines", "inventory_anchors"] as const;

async function tableCount(): Promise<number> {
  const r = await pg().admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [TABLES],
  );
  return r.rows[0]!.n;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0063-inventory-effects-activation.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0063(env);
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'rt427-a', 'rt427-a'), ($2, 'rt427-b', 'rt427-b')`, [
    TENANT,
    TENANT_B,
  ]);
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $4, 'a-main', 'A main'), ($2, $4, 'a-two', 'A two'), ($3, $5, 'b-main', 'B main')`,
    [STORE, STORE_2, STORE_B, TENANT, TENANT_B],
  );
  for (const store of [STORE, STORE_2, STORE_B]) {
    const r = await a.query<{ id: string }>(
      `SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`,
      [store],
    );
    primaries.set(store, r.rows[0]!.id);
  }
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by) VALUES
       ($1, $3, 'P', 'standard', $5, $5), ($2, $4, 'PB', 'standard', $5, $5)`,
    [PRODUCT, PRODUCT_B, TENANT, TENANT_B, ACTOR],
  );
  await a.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at)
     VALUES ($1, $3, $4, 'stock', 'on_demand', 'completed', now()),
            ($2, $5, $6, 'stock', 'on_demand', 'completed', now())`,
    [RUN, RUN_B, TENANT, STORE, TENANT_B, STORE_B],
  );
  await a.query(readFileSync(UP_PATH, "utf8"));
  await ensureAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0063 tenant_inventory_settings activation flag", () => {
  it("defaults to OFF (both NULL) and accepts both set", async () => {
    if (skip()) return;
    const result = await inRolledBackTx(async (c) => {
      const r = await c.query<{ at: Date | null; by: string | null }>(
        `INSERT INTO tenant_inventory_settings (tenant_id, updated_by) VALUES ($1, $2)
         RETURNING sale_effects_activated_at AS at, sale_effects_activated_by AS by`,
        [TENANT, ACTOR],
      );
      await c.query(
        `UPDATE tenant_inventory_settings
            SET sale_effects_activated_at = now(), sale_effects_activated_by = $2
          WHERE tenant_id = $1`,
        [TENANT, ACTOR],
      );
      return r.rows[0];
    });
    expect(result).toEqual({ at: null, by: null });
  });

  it.each<[string, string]>([
    ["a time without an actor", "sale_effects_activated_at = now()"],
    ["an actor without a time", `sale_effects_activated_by = '${ACTOR}'`],
  ])("refuses %s (23514)", async (_label, set) => {
    if (skip()) return;
    const code = await inRolledBackTx(async (c) => {
      await c.query(`INSERT INTO tenant_inventory_settings (tenant_id, updated_by) VALUES ($1, $2)`, [TENANT, ACTOR]);
      return errorCode(() => c.query(`UPDATE tenant_inventory_settings SET ${set} WHERE tenant_id = $1`, [TENANT]));
    });
    expect(code).toBe("23514");
  });
});

describe("0063 inventory_anchors constraints", () => {
  it("accepts an anchor at the store's primary / sellable", async () => {
    if (skip()) return;
    expect(await tryAnchor({})).toBeNull();
  });

  it.each<[string, AnchorRow]>([
    ["generation 0", { generation: 0 }],
    ["an unknown status", { status: "on_shelf" }],
    ["an empty warehouse reference", { warehouseRef: "" }],
    ["a non-object coverage", { coverage: "[]" }],
  ])("refuses %s (23514)", async (_label, row) => {
    if (skip()) return;
    expect(await tryAnchor(row)).toBe("23514");
  });

  it("refuses a location of another store and an unknown run (23503)", async () => {
    if (skip()) return;
    expect(await tryAnchor({ location: primaries.get(STORE_2)! })).toBe("23503");
    expect(await tryAnchor({ runId: "0a000000-0000-7000-8000-0000000427ff" })).toBe("23503");
  });

  it("refuses a second anchor of the same generation for a store (23505), not the next one", async () => {
    if (skip()) return;
    const codes = await inRolledBackTx(async (c) => {
      await c.query(ANCHOR_SQL, anchorParams({}));
      const same = await errorCode(async () => {
        await c.query("SAVEPOINT s");
        try {
          await c.query(ANCHOR_SQL, anchorParams({ id: "0a000000-0000-7000-8000-000000042731" }));
        } finally {
          await c.query("ROLLBACK TO SAVEPOINT s");
        }
      });
      const next = await errorCode(() =>
        c.query(ANCHOR_SQL, anchorParams({ id: "0a000000-0000-7000-8000-000000042732", generation: 2 })),
      );
      return [same, next];
    });
    expect(codes).toEqual(["23505", null]);
  });
});

describe("0063 inventory_anchor_lines constraints", () => {
  it("keeps the exact Bin quantity, one line per product, own-tenant anchor and product only", async () => {
    if (skip()) return;
    const result = await inRolledBackTx(async (c) => {
      await c.query(ANCHOR_SQL, anchorParams({}));
      await c.query(LINE_SQL, [ANCHOR, TENANT, PRODUCT, "12.345678", "Nos", "ITEM-1"]);
      const q = await c.query<{ q: string }>(`SELECT quantity::text AS q FROM inventory_anchor_lines`);
      const dup = await errorCode(async () => {
        await c.query("SAVEPOINT s");
        try {
          await c.query(LINE_SQL, [ANCHOR, TENANT, PRODUCT, "1", "Nos", "ITEM-1"]);
        } finally {
          await c.query("ROLLBACK TO SAVEPOINT s");
        }
      });
      const foreignProduct = await errorCode(async () => {
        await c.query("SAVEPOINT s");
        try {
          await c.query(LINE_SQL, [ANCHOR, TENANT, PRODUCT_B, "1", "Nos", "ITEM-B"]);
        } finally {
          await c.query("ROLLBACK TO SAVEPOINT s");
        }
      });
      const foreignAnchor = await errorCode(() => c.query(LINE_SQL, [ANCHOR, TENANT_B, PRODUCT_B, "1", "Nos", "ITEM-B"]));
      return [q.rows[0]!.q, dup, foreignProduct, foreignAnchor];
    });
    expect(result).toEqual(["12.345678", "23505", "23503", "23503"]);
  });
});

describe("0063 RLS", () => {
  it("enables and forces RLS with SELECT + INSERT only on both tables", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ relname: string; on: boolean; forced: boolean; cmds: string }>(
      `SELECT c.relname, c.relrowsecurity AS on, c.relforcerowsecurity AS forced,
              string_agg(p.cmd, ',' ORDER BY p.cmd) AS cmds
         FROM pg_class c JOIN pg_policies p ON p.tablename = c.relname
        WHERE c.relname = ANY($1::text[])
        GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
        ORDER BY c.relname`,
      [TABLES],
    );
    expect(r.rows).toEqual([
      { relname: "inventory_anchor_lines", on: true, forced: true, cmds: "INSERT,SELECT" },
      { relname: "inventory_anchors", on: true, forced: true, cmds: "INSERT,SELECT" },
    ]);
  });

  it("is tenant-scoped, fails closed on an unset GUC, refuses cross-tenant inserts, never updates or deletes", async () => {
    if (skip()) return;
    await pg().admin.query(ANCHOR_SQL, anchorParams({}));
    await pg().admin.query(LINE_SQL, [ANCHOR, TENANT, PRODUCT, "3", "Nos", "ITEM-1"]);
    try {
      const seen = async (guc: string | null): Promise<number[]> =>
        asApp(guc, async (c) => [
          (await c.query(`SELECT 1 FROM inventory_anchors`)).rowCount ?? 0,
          (await c.query(`SELECT 1 FROM inventory_anchor_lines`)).rowCount ?? 0,
        ]);
      expect(await seen(TENANT)).toEqual([1, 1]);
      expect(await seen(TENANT_B)).toEqual([0, 0]);
      expect(await seen("")).toEqual([0, 0]);
      const crossTenant = await asApp(TENANT_B, (c) =>
        errorCode(() => c.query(ANCHOR_SQL, anchorParams({ id: "0a000000-0000-7000-8000-000000042733", generation: 3 }))),
      );
      expect(crossTenant).toBe("42501");
      const changed = await asApp(TENANT, async (c) => [
        (await c.query(`UPDATE inventory_anchors SET generation = 9`)).rowCount,
        (await c.query(`DELETE FROM inventory_anchor_lines`)).rowCount,
        (await c.query(`DELETE FROM inventory_anchors`)).rowCount,
      ]);
      expect(changed).toEqual([0, 0, 0]);
    } finally {
      await pg().admin.query(`DELETE FROM inventory_anchor_lines WHERE anchor_id = $1`, [ANCHOR]);
      await pg().admin.query(`DELETE FROM inventory_anchors WHERE id = $1`, [ANCHOR]);
    }
  });
});

describe("0063 down", () => {
  async function runDown(): Promise<string | null> {
    const client = await pg().admin.connect();
    try {
      return await errorCode(() => client.query(readFileSync(DOWN_PATH, "utf8")));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  it("refuses while an anchor exists, and changes nothing", async () => {
    if (skip()) return;
    await pg().admin.query(ANCHOR_SQL, anchorParams({}));
    try {
      expect(await runDown()).toBe("P0001");
      expect(await tableCount()).toBe(2);
    } finally {
      await pg().admin.query(`DELETE FROM inventory_anchors WHERE id = $1`, [ANCHOR]);
    }
  });

  it("refuses while a tenant is activated", async () => {
    if (skip()) return;
    await pg().admin.query(
      `INSERT INTO tenant_inventory_settings (tenant_id, updated_by, sale_effects_activated_at, sale_effects_activated_by)
       VALUES ($1, $2, now(), $2)`,
      [TENANT_B, ACTOR],
    );
    try {
      expect(await runDown()).toBe("P0001");
      expect(await tableCount()).toBe(2);
    } finally {
      await pg().admin.query(`DELETE FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_B]);
    }
  });

  it("round-trips: down removes the tables and columns, up restores them", async () => {
    if (skip()) return;
    const columns = async (): Promise<number> =>
      (
        await pg().admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_name = 'tenant_inventory_settings' AND column_name LIKE 'sale_effects_%'`,
        )
      ).rows[0]!.n;
    expect(await runDown()).toBeNull();
    expect([await tableCount(), await columns()]).toEqual([0, 0]);
    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    expect([await tableCount(), await columns()]).toEqual([2, 2]);
  });
});
