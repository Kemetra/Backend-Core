/**
 * 0044 — Stock Locations and the inventory position grain (Jira RT-432;
 * decisions RT-290 G4-1…G4-5, Q1 / Q3 / Q10).
 *
 * Applies every migration before 0044 against a real Postgres, seeds stores
 * (one soft-deleted) and pre-0044 movements for two tenants (the UPGRADE path),
 * applies 0044, then proves:
 *   - every existing store, soft-deleted included, gets exactly one active
 *     `primary` location, and a store created later gets one in the same
 *     transaction (the stores trigger, under the inserting tenant's RLS);
 *   - existing movements are not touched (same xmin, NULL position — G4-5);
 *   - a new movement must carry a location and status, the status is from the
 *     closed enum, tracking is NULL, and the location is of the same store and
 *     tenant;
 *   - `erp_neutral` is an allowed integration state that names no ERP intent or
 *     document;
 *   - stock_locations is tenant-isolated (SELECT / INSERT only, no UPDATE /
 *     DELETE through RLS), its identity is immutable for every role, and a store
 *     purge removes its unused locations while a location in use blocks it;
 *   - down refuses while an effect carries a position or an erp_neutral state,
 *     and otherwise round-trips with up.
 *
 * Fresh install (the whole chain from empty) is covered by the migrate CLI
 * spec's EXPECTED_MIGRATIONS ledger.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0044_stock_locations_position_grain.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0044_stock_locations_position_grain.down.sql");

const TENANT_A = "0a000000-0000-7000-8000-000000044a01";
const TENANT_B = "0b000000-0000-7000-8000-000000044b01";
const STORE_A = "0a000000-0000-7000-8000-000000044a02";
const STORE_A2 = "0a000000-0000-7000-8000-000000044a03";
const STORE_A_DELETED = "0a000000-0000-7000-8000-000000044a05";
const STORE_B = "0b000000-0000-7000-8000-000000044b02";
const STORE_A_NEW = "0a000000-0000-7000-8000-000000044a06";
const STORE_A_PURGE = "0a000000-0000-7000-8000-000000044a07";
const ACTOR = "0a000000-0000-7000-8000-000000044a04";
const MOVE_A1 = "0a000000-0000-7000-8000-000000044a11";
const MOVE_A2 = "0a000000-0000-7000-8000-000000044a12";
const MOVE_B1 = "0b000000-0000-7000-8000-000000044b11";
const MOVE_A_NEW = "0a000000-0000-7000-8000-000000044a13";

let env: PgTestEnv | null = null;
/** xmin of every pre-0044 movement, captured before 0044 runs. */
let xminBefore: Record<string, string> = {};

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function applyBefore0044(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(pgEnv);
}

async function insertLegacyMovement(id: string, tenant: string, store: string): Promise<void> {
  await pg().admin.query(
    `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
                                  occurred_at, created_by)
     VALUES ($1, $2, $3, 'inbound', 1, 'ea', '2026-10-01T10:00:00Z', $4)`,
    [id, tenant, store, ACTOR],
  );
}

async function primaryOf(store: string): Promise<string> {
  const r = await pg().admin.query<{ id: string }>(
    `SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`,
    [store],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`no primary location for store ${store}`);
  return id;
}

/** Insert a new movement with an explicit position (as the RT-432 writers do). */
function insertPositioned(fields: {
  id?: string;
  tenant?: string;
  store?: string;
  location?: string | null;
  status?: string | null;
  tracking?: string | null;
}): Promise<unknown> {
  return pg().admin.query(
    `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
                                  occurred_at, created_by, stock_location_id, inventory_status,
                                  tracking_identity)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, 'inbound', 1, 'ea', now(), $4, $5, $6, $7)`,
    [
      fields.id ?? null,
      fields.tenant ?? TENANT_A,
      fields.store ?? STORE_A,
      ACTOR,
      fields.location ?? null,
      fields.status ?? null,
      fields.tracking ?? null,
    ],
  );
}

/** Run `fn` on the non-superuser app pool inside `tenant`'s RLS context. */
async function asTenant<T>(tenant: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pg().app.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenant]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0044-stock-locations-position-grain.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0044(env);
  await env.admin.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'rt432-a', 'rt432-a'), ($2, 'rt432-b', 'rt432-b')`, [
    TENANT_A,
    TENANT_B,
  ]);
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name, deleted_at) VALUES
       ($1, $4, 'a-main', 'A main', NULL),
       ($2, $4, 'a-two', 'A two', NULL),
       ($3, $4, 'a-gone', 'A gone', now()),
       ($5, $6, 'b-main', 'B main', NULL)`,
    [STORE_A, STORE_A2, STORE_A_DELETED, TENANT_A, STORE_B, TENANT_B],
  );
  // Pre-0044 movements, written by the 009/RT-425 writers (no position).
  await insertLegacyMovement(MOVE_A1, TENANT_A, STORE_A);
  await insertLegacyMovement(MOVE_A2, TENANT_A, STORE_A2);
  await insertLegacyMovement(MOVE_B1, TENANT_B, STORE_B);
  const x = await env.admin.query<{ id: string; xmin: string }>(`SELECT id, xmin::text FROM stock_movements`);
  xminBefore = Object.fromEntries(x.rows.map((r) => [r.id, r.xmin]));

  await env.admin.query(readFileSync(UP_PATH, "utf8"));
  // Grant the app role on the table 0044 created (as production's grant script does).
  await ensureAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

describe("0044 — upgrade over existing stores and movements", () => {
  it("gives every existing store, soft-deleted included, exactly one active primary location", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ store_id: string; tenant_id: string; n: string; active: boolean; code: string }>(
      `SELECT s.id AS store_id, s.tenant_id, count(l.id)::text AS n,
              bool_and(l.is_active) AS active, min(l.code) AS code
         FROM stores s
         LEFT JOIN stock_locations l ON l.store_id = s.id AND l.kind = 'primary'
        GROUP BY s.id, s.tenant_id
        ORDER BY s.id`,
    );
    expect(r.rows).toEqual(
      [
        { store_id: STORE_A, tenant_id: TENANT_A, n: "1", active: true, code: "PRIMARY" },
        { store_id: STORE_A2, tenant_id: TENANT_A, n: "1", active: true, code: "PRIMARY" },
        { store_id: STORE_A_DELETED, tenant_id: TENANT_A, n: "1", active: true, code: "PRIMARY" },
        { store_id: STORE_B, tenant_id: TENANT_B, n: "1", active: true, code: "PRIMARY" },
      ].sort((a, b) => a.store_id.localeCompare(b.store_id)),
    );
    const tenantMatch = await pg().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_locations l JOIN stores s ON s.id = l.store_id
        WHERE l.tenant_id <> s.tenant_id`,
    );
    expect(tenantMatch.rows[0]?.n).toBe("0");
  });

  it("does not touch any existing movement (same xmin, NULL position — G4-5)", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{
      id: string;
      xmin: string;
      stock_location_id: string | null;
      inventory_status: string | null;
      tracking_identity: string | null;
    }>(
      `SELECT id, xmin::text, stock_location_id, inventory_status, tracking_identity
         FROM stock_movements WHERE id = ANY($1::uuid[])`,
      [[MOVE_A1, MOVE_A2, MOVE_B1]],
    );
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.xmin).toBe(xminBefore[row.id]);
      expect(row.stock_location_id).toBeNull();
      expect(row.inventory_status).toBeNull();
      expect(row.tracking_identity).toBeNull();
    }
  });

  it("a store created later gets its primary in the same transaction, under the tenant's RLS", async () => {
    if (skip()) return;
    const ids = await asTenant(TENANT_A, async (c) => {
      await c.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'a-new', 'A new')`, [
        STORE_A_NEW,
        TENANT_A,
      ]);
      return (
        await c.query<{ kind: string; code: string }>(`SELECT kind, code FROM stock_locations WHERE store_id = $1`, [
          STORE_A_NEW,
        ])
      ).rows;
    });
    expect(ids).toEqual([{ kind: "primary", code: "PRIMARY" }]);
  });

  it("refuses a second primary for one store and a duplicate code", async () => {
    if (skip()) return;
    await expect(
      pg().admin.query(
        `INSERT INTO stock_locations (tenant_id, store_id, code, name, kind) VALUES ($1, $2, 'second', 'Second', 'primary')`,
        [TENANT_A, STORE_A],
      ),
    ).rejects.toThrow(/uq_stock_locations_store_primary/);
    await expect(
      pg().admin.query(
        `INSERT INTO stock_locations (tenant_id, store_id, code, name, kind) VALUES ($1, $2, 'primary', 'Dup', 'storage')`,
        [TENANT_A, STORE_A],
      ),
    ).rejects.toThrow(/uq_stock_locations_store_code/);
  });

  it("refuses an unknown kind, an inactive primary and a location of another tenant's store", async () => {
    if (skip()) return;
    const insert = (fields: { tenant: string; store: string; kind: string; active?: boolean }): Promise<unknown> =>
      pg().admin.query(
        `INSERT INTO stock_locations (tenant_id, store_id, code, name, kind, is_active)
         VALUES ($1, $2, gen_random_uuid()::text, 'X', $3, $4)`,
        [fields.tenant, fields.store, fields.kind, fields.active ?? true],
      );
    await expect(insert({ tenant: TENANT_A, store: STORE_A, kind: "bin" })).rejects.toThrow(
      /stock_locations_kind_allowed/,
    );
    await expect(insert({ tenant: TENANT_A, store: STORE_A2, kind: "primary", active: false })).rejects.toThrow(
      /stock_locations_primary_active|uq_stock_locations_store_primary/,
    );
    await expect(insert({ tenant: TENANT_A, store: STORE_B, kind: "storage" })).rejects.toThrow(
      /fk_stock_locations_store_tenant/,
    );
  });
});

describe("0044 — position constraints on new movements", () => {
  it("accepts a movement at its own store's location in a known status", async () => {
    if (skip()) return;
    await insertPositioned({ id: MOVE_A_NEW, location: await primaryOf(STORE_A), status: "sellable" });
  });

  it("refuses a new movement without a location or without a status", async () => {
    if (skip()) return;
    await expect(insertPositioned({ status: "sellable" })).rejects.toThrow(/stock_movements_position_required/);
    await expect(insertPositioned({ location: await primaryOf(STORE_A) })).rejects.toThrow(
      /stock_movements_position_required/,
    );
    await expect(insertPositioned({})).rejects.toThrow(/stock_movements_position_required/);
  });

  it("refuses an unknown status and any tracking identity (until Gate 7)", async () => {
    if (skip()) return;
    const loc = await primaryOf(STORE_A);
    await expect(insertPositioned({ location: loc, status: "on_shelf" })).rejects.toThrow(
      /stock_movements_inventory_status_allowed/,
    );
    await expect(insertPositioned({ location: loc, status: "sellable", tracking: "LOT-1" })).rejects.toThrow(
      /stock_movements_tracking_none/,
    );
  });

  it("accepts each of the six statuses", async () => {
    if (skip()) return;
    const loc = await primaryOf(STORE_A);
    for (const status of ["sellable", "return_inspection", "quality_hold", "damaged", "expired", "recall_hold"]) {
      await insertPositioned({ location: loc, status });
    }
  });

  it("refuses a location of another store of the same tenant, and of another tenant", async () => {
    if (skip()) return;
    await expect(insertPositioned({ location: await primaryOf(STORE_A2), status: "sellable" })).rejects.toThrow(
      /fk_stock_movements_location_store_tenant/,
    );
    await expect(insertPositioned({ location: await primaryOf(STORE_B), status: "sellable" })).rejects.toThrow(
      /fk_stock_movements_location_store_tenant/,
    );
  });
});

describe("0044 — erp_neutral integration state", () => {
  const insertState = (fields: Record<string, unknown>): Promise<unknown> => {
    const cols = Object.keys(fields);
    return pg().admin.query(
      `INSERT INTO inventory_effect_integration (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(fields),
    );
  };

  it("names no ERP document and no posting intent", async () => {
    if (skip()) return;
    await expect(
      insertState({ effect_id: MOVE_A_NEW, tenant_id: TENANT_A, state: "erp_neutral", erp_document_ref: "SINV-1" }),
    ).rejects.toThrow(/inventory_effect_integration_erp_neutral_bare/);
    await expect(
      insertState({
        effect_id: MOVE_A_NEW,
        tenant_id: TENANT_A,
        state: "erp_neutral",
        posting_status_id: "0a000000-0000-7000-8000-000000044a99",
      }),
    ).rejects.toThrow(/inventory_effect_integration_intent_link/);
  });

  it("is an allowed state, and an unknown state is still refused", async () => {
    if (skip()) return;
    await expect(insertState({ effect_id: MOVE_A_NEW, tenant_id: TENANT_A, state: "neutral" })).rejects.toThrow(
      /inventory_effect_integration_state_allowed/,
    );
    await insertState({ effect_id: MOVE_A_NEW, tenant_id: TENANT_A, state: "erp_neutral" });
  });
});

describe("0044 — stock_locations RLS and immutability", () => {
  it("a tenant reads only its own locations", async () => {
    if (skip()) return;
    const stores = await asTenant(TENANT_B, async (c) =>
      (await c.query<{ store_id: string }>(`SELECT store_id FROM stock_locations`)).rows.map((r) => r.store_id),
    );
    expect(stores).toEqual([STORE_B]);
  });

  it("a tenant cannot insert a location for another tenant", async () => {
    if (skip()) return;
    await expect(
      asTenant(TENANT_A, (c) =>
        c.query(
          `INSERT INTO stock_locations (tenant_id, store_id, code, name, kind) VALUES ($1, $2, 'x', 'X', 'storage')`,
          [TENANT_B, STORE_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("no UPDATE or DELETE policy: the app role changes and removes nothing", async () => {
    if (skip()) return;
    const counts = await asTenant(TENANT_A, async (c) => ({
      updated: (await c.query(`UPDATE stock_locations SET name = 'Renamed'`)).rowCount,
      deleted: (await c.query(`DELETE FROM stock_locations`)).rowCount,
    }));
    expect(counts).toEqual({ updated: 0, deleted: 0 });
  });

  it("a location's tenant, store, kind and code are immutable even for the superuser", async () => {
    if (skip()) return;
    const loc = await primaryOf(STORE_A);
    for (const set of ["kind = 'storage'", "code = 'OTHER'", `store_id = '${STORE_A2}'`]) {
      await expect(pg().admin.query(`UPDATE stock_locations SET ${set} WHERE id = $1`, [loc])).rejects.toThrow(
        /immutable/,
      );
    }
    // A non-identity field may change (name), and updated_at moves with it.
    await pg().admin.query(`UPDATE stock_locations SET name = 'Main floor' WHERE id = $1`, [loc]);
  });

  it("a store purge removes its unused locations; a location in use blocks it", async () => {
    if (skip()) return;
    await pg().admin.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'a-purge', 'A purge')`, [
      STORE_A_PURGE,
      TENANT_A,
    ]);
    // Purged by the app role inside its tenant context, as the soft-delete sweep does.
    await asTenant(TENANT_A, (c) => c.query(`DELETE FROM stores WHERE id = $1`, [STORE_A_PURGE]));
    const left = await pg().admin.query(`SELECT 1 FROM stock_locations WHERE store_id = $1`, [STORE_A_PURGE]);
    expect(left.rowCount).toBe(0);
    // STORE_A has movements (some at its primary): its own RESTRICT FK keeps it.
    await expect(pg().admin.query(`DELETE FROM stores WHERE id = $1`, [STORE_A])).rejects.toThrow(/foreign key/);
  });
});

describe("0044 — down → up round-trip", () => {
  const locationsTable = async (): Promise<string | null> =>
    (await pg().admin.query<{ t: string | null }>(`SELECT to_regclass('public.stock_locations')::text AS t`)).rows[0]
      ?.t ?? null;

  it("down refuses while an effect carries a position or an erp_neutral state", async () => {
    if (skip()) return;
    await expect(pg().admin.query(readFileSync(DOWN_PATH, "utf8"))).rejects.toThrow(
      /0044 down refused: \d+ stock_movements row\(s\) carry a position/,
    );
    // Remove positioned movements but keep an erp_neutral record on a legacy one.
    await pg().admin.query(
      `DELETE FROM inventory_effect_integration
        WHERE effect_id IN (SELECT id FROM stock_movements WHERE stock_location_id IS NOT NULL)`,
    );
    await pg().admin.query(`DELETE FROM stock_movements WHERE stock_location_id IS NOT NULL`);
    await pg().admin.query(
      `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state) VALUES ($1, $2, 'erp_neutral')
       ON CONFLICT (effect_id) DO UPDATE SET state = 'erp_neutral'`,
      [MOVE_A1, TENANT_A],
    );
    await expect(pg().admin.query(readFileSync(DOWN_PATH, "utf8"))).rejects.toThrow(/erp_neutral/);
    expect(await locationsTable()).toBe("stock_locations");
  });

  it("otherwise removes the table, the trigger and the constraints; up restores them", async () => {
    if (skip()) return;
    await pg().admin.query(`UPDATE inventory_effect_integration SET state = 'not_posted' WHERE effect_id = $1`, [
      MOVE_A1,
    ]);
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    expect(await locationsTable()).toBeNull();
    const constraints = await pg().admin.query(
      `SELECT 1 FROM pg_constraint WHERE conname IN
         ('stock_movements_position_required', 'stock_movements_inventory_status_allowed',
          'stock_movements_tracking_none', 'fk_stock_movements_location_store_tenant')`,
    );
    expect(constraints.rowCount).toBe(0);
    // A legacy-shaped movement is accepted again without a position.
    await insertLegacyMovement("0a000000-0000-7000-8000-000000044a21", TENANT_A, STORE_A);
    await expect(
      pg().admin.query(
        `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state) VALUES ($1, $2, 'erp_neutral')`,
        ["0a000000-0000-7000-8000-000000044a21", TENANT_A],
      ),
    ).rejects.toThrow(/inventory_effect_integration_state_allowed/);

    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    expect(await locationsTable()).toBe("stock_locations");
    const primaries = await pg().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_locations WHERE kind = 'primary'`,
    );
    const stores = await pg().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM stores`);
    expect(primaries.rows[0]?.n).toBe(stores.rows[0]?.n);
  });
});
