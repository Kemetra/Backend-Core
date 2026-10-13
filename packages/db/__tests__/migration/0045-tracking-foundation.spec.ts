/**
 * 0045 — Tracking foundation (Jira RT-448; RT-50 Gate 7 G7-1, G7-2, G7-3).
 *
 * Applies every migration before 0045 against a real Postgres, seeds products
 * for two tenants, a stock movement and a captured sale line (the UPGRADE
 * path), applies 0045, then proves:
 *   - existing products read tracking_mode 'none' / expiry_required false and
 *     existing movements are not touched (same xmin);
 *   - the profile CHECKs: a closed mode set, expiry only with batch;
 *   - the profile is locked once the product has an inventory effect or a sale
 *     line (387), for the app role and the superuser alike, while other columns
 *     and history-free products stay editable;
 *   - tracking_identities: kind / code / origin / date CHECKs, one code per
 *     (product, kind), same-tenant product FK, immutable identity for every
 *     role, tenant-isolated SELECT / INSERT only;
 *   - erpnext_tracking_map: 1:1 in both directions within (tenant, kind), kind
 *     equal to the identity's, SELECT / INSERT only;
 *   - stock_movements.tracking_identity_id names an identity of the effect's
 *     own product and tenant, and never without a product;
 *   - down refuses while tracking data exists, and otherwise round-trips.
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
const UP_NAME = "0045_tracking_foundation.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0045_tracking_foundation.down.sql");

const TENANT_A = "0a000000-0000-7000-8000-000000045a01";
const TENANT_B = "0b000000-0000-7000-8000-000000045b01";
const STORE_A = "0a000000-0000-7000-8000-000000045a02";
const STORE_B = "0b000000-0000-7000-8000-000000045b02";
const ACTOR = "0a000000-0000-7000-8000-000000045a03";
/** No history: the profile may change. */
const PRODUCT_FREE = "0a000000-0000-7000-8000-000000045a10";
/** Has a stock movement. */
const PRODUCT_STOCKED = "0a000000-0000-7000-8000-000000045a11";
/** Has a captured sale line. */
const PRODUCT_SOLD = "0a000000-0000-7000-8000-000000045a12";
/** A second history-free product (batch-tracked) for identities. */
const PRODUCT_LOT = "0a000000-0000-7000-8000-000000045a13";
const PRODUCT_B = "0b000000-0000-7000-8000-000000045b10";
const MOVE_A1 = "0a000000-0000-7000-8000-000000045a20";
const SALE_A1 = "0a000000-0000-7000-8000-000000045a30";
const HASH = "d".repeat(64);

let env: PgTestEnv | null = null;
let xminBefore = "";

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function applyBefore0045(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(pgEnv);
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

function insertIdentity(fields: {
  id?: string;
  tenant?: string;
  product?: string;
  kind?: string;
  code?: string;
  expiry?: string | null;
  manufactured?: string | null;
  origin?: string;
}): Promise<{ rows: Array<{ id: string }> }> {
  return pg().admin.query<{ id: string }>(
    `INSERT INTO tracking_identities
       (id, tenant_id, tenant_product_ref, kind, code, expiry_date, manufactured_on, origin)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      fields.id ?? null,
      fields.tenant ?? TENANT_A,
      fields.product ?? PRODUCT_LOT,
      fields.kind ?? "batch",
      fields.code ?? "LOT-001",
      fields.expiry ?? null,
      fields.manufactured ?? null,
      fields.origin ?? "erp_external",
    ],
  );
}

async function insertTrackedMovement(fields: {
  product: string | null;
  identity: string;
}): Promise<unknown> {
  return pg().admin.query(
    `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
                                  occurred_at, created_by, stock_location_id, inventory_status,
                                  tenant_product_ref, tracking_identity_id)
     VALUES (gen_random_uuid(), $1, $2, 'inbound', 1, 'ea', now(), $3, $4, 'sellable', $5, $6)`,
    [TENANT_A, STORE_A, ACTOR, await primaryOf(STORE_A), fields.product, fields.identity],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0045-tracking-foundation.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0045(env);
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'rt448-a', 'rt448-a'), ($2, 'rt448-b', 'rt448-b')`, [
    TENANT_A,
    TENANT_B,
  ]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'a-main', 'A main'), ($3, $4, 'b-main', 'B main')`, [
    STORE_A,
    TENANT_A,
    STORE_B,
    TENANT_B,
  ]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by) VALUES
       ($1, $5, 'Free', 'standard', $7, $7),
       ($2, $5, 'Stocked', 'standard', $7, $7),
       ($3, $5, 'Sold', 'standard', $7, $7),
       ($4, $5, 'Lot', 'standard', $7, $7),
       ($6, $8, 'B product', 'standard', $7, $7)`,
    [PRODUCT_FREE, PRODUCT_STOCKED, PRODUCT_SOLD, PRODUCT_LOT, TENANT_A, PRODUCT_B, ACTOR, TENANT_B],
  );
  // History written before 0045: a movement and a captured sale line.
  await a.query(
    `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
                                  occurred_at, created_by, stock_location_id, inventory_status,
                                  tenant_product_ref)
     VALUES ($1, $2, $3, 'inbound', 5, 'ea', now(), $4, $5, 'sellable', $6)`,
    [MOVE_A1, TENANT_A, STORE_A, ACTOR, await primaryOf(STORE_A), PRODUCT_STOCKED],
  );
  await a.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 5.00, now(), '2026-10-13', 'pos-0045', 'ext-0045', $4, $5)`,
    [SALE_A1, TENANT_A, STORE_A, HASH, ACTOR],
  );
  await a.query(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code,
        quantity, line_amount, tax_amount, unit, tenant_product_ref)
     VALUES (gen_random_uuid(), $1, $2, $3, 'Sold', 5.0000, 'EGP', 1.000000, 5.0000, 0.0000, 'ea', $4)`,
    [SALE_A1, TENANT_A, STORE_A, PRODUCT_SOLD],
  );
  const x = await a.query<{ xmin: string }>(`SELECT xmin::text FROM stock_movements WHERE id = $1`, [MOVE_A1]);
  xminBefore = x.rows[0]?.xmin ?? "";

  await a.query(readFileSync(UP_PATH, "utf8"));
  // Grant the app role on the tables 0045 created (as production's grant script does).
  await ensureAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

describe("0045 — upgrade over existing products and movements", () => {
  it("every existing product reads tracking_mode 'none' and no expiry requirement", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ tracking_mode: string; expiry_required: boolean; n: string }>(
      `SELECT tracking_mode, expiry_required, count(*)::text AS n FROM tenant_products
        GROUP BY tracking_mode, expiry_required`,
    );
    expect(r.rows).toEqual([{ tracking_mode: "none", expiry_required: false, n: "5" }]);
  });

  it("does not touch an existing movement (same xmin, no tracking identity)", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ xmin: string; tracking_identity_id: string | null }>(
      `SELECT xmin::text, tracking_identity_id FROM stock_movements WHERE id = $1`,
      [MOVE_A1],
    );
    expect(r.rows).toEqual([{ xmin: xminBefore, tracking_identity_id: null }]);
  });
});

describe("0045 — the Tracking Profile (G7-1)", () => {
  it("refuses an unknown mode and an expiry requirement without batch", async () => {
    if (skip()) return;
    await expect(
      pg().admin.query(`UPDATE tenant_products SET tracking_mode = 'lot' WHERE id = $1`, [PRODUCT_FREE]),
    ).rejects.toThrow(/tenant_products_tracking_mode_allowed/);
    await expect(
      pg().admin.query(`UPDATE tenant_products SET tracking_mode = 'serial', expiry_required = true WHERE id = $1`, [
        PRODUCT_FREE,
      ]),
    ).rejects.toThrow(/tenant_products_expiry_requires_batch/);
  });

  it("a history-free product's profile may be set and changed by the app role", async () => {
    if (skip()) return;
    await asTenant(TENANT_A, (c) =>
      c.query(`UPDATE tenant_products SET tracking_mode = 'serial' WHERE id = $1`, [PRODUCT_FREE]),
    );
    await asTenant(TENANT_A, (c) =>
      c.query(`UPDATE tenant_products SET tracking_mode = 'batch', expiry_required = true WHERE id = ANY($1::uuid[])`, [
        [PRODUCT_FREE, PRODUCT_LOT],
      ]),
    );
    const r = await pg().admin.query<{ tracking_mode: string; expiry_required: boolean }>(
      `SELECT tracking_mode, expiry_required FROM tenant_products WHERE id = $1`,
      [PRODUCT_FREE],
    );
    expect(r.rows).toEqual([{ tracking_mode: "batch", expiry_required: true }]);
  });

  it("locks the profile once the product has an inventory effect or a sale line (387)", async () => {
    if (skip()) return;
    for (const product of [PRODUCT_STOCKED, PRODUCT_SOLD]) {
      await expect(
        asTenant(TENANT_A, (c) => c.query(`UPDATE tenant_products SET tracking_mode = 'batch' WHERE id = $1`, [product])),
      ).rejects.toThrow(/tracking profile is locked/);
      await expect(
        pg().admin.query(`UPDATE tenant_products SET tracking_mode = 'batch' WHERE id = $1`, [product]),
      ).rejects.toThrow(/tracking profile is locked/);
    }
    const err = await pg()
      .admin.query(`UPDATE tenant_products SET tracking_mode = 'serial' WHERE id = $1`, [PRODUCT_STOCKED])
      .catch((e: { code?: string; constraint?: string }) => e);
    expect(err).toMatchObject({ code: "23514", constraint: "tenant_products_tracking_profile_locked" });
  });

  it("other columns of a product with history stay editable, and a same-value write is not a change", async () => {
    if (skip()) return;
    await asTenant(TENANT_A, async (c) => {
      await c.query(`UPDATE tenant_products SET name = 'Stocked renamed' WHERE id = $1`, [PRODUCT_STOCKED]);
      await c.query(`UPDATE tenant_products SET tracking_mode = 'none', expiry_required = false WHERE id = $1`, [
        PRODUCT_SOLD,
      ]);
    });
  });
});

describe("0045 — tracking_identities (G7-2, G7-3)", () => {
  let lot1 = "";

  it("accepts a batch of a product with its printed code and dates", async () => {
    if (skip()) return;
    const r = await insertIdentity({ code: "LOT-001", expiry: "2027-03-31", manufactured: "2026-03-31" });
    lot1 = r.rows[0]!.id;
    expect(lot1).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("one code per (product, kind); the same code is allowed on another product or kind", async () => {
    if (skip()) return;
    await expect(insertIdentity({ code: "LOT-001" })).rejects.toThrow(/uq_tracking_identities_product_kind_code/);
    await insertIdentity({ code: "LOT-001", product: PRODUCT_FREE });
    await insertIdentity({ code: "LOT-001", kind: "serial" });
  });

  it("the identity list's keyset order is served by an index range scan, without a sort", async () => {
    if (skip()) return;
    const c = await pg().admin.connect();
    try {
      await c.query("SET enable_seqscan = off");
      const plan = await c.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT id FROM tracking_identities
          WHERE tenant_product_ref = $1
            AND (kind, COALESCE(expiry_date, 'infinity'::date), code, id)
                > ('batch', '2027-01-01'::date, 'A', '00000000-0000-0000-0000-000000000000'::uuid)
          ORDER BY kind, COALESCE(expiry_date, 'infinity'::date), code, id
          LIMIT 51`,
        [PRODUCT_LOT],
      );
      const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(text).toContain("idx_tracking_identities_product_keyset");
      expect(text).not.toMatch(/\bSort\b/);
    } finally {
      await c.query("RESET enable_seqscan").catch(() => undefined);
      c.release();
    }
  });

  it("refuses an unknown kind, a padded or empty code, a non-ERP origin, inverted and infinite dates", async () => {
    if (skip()) return;
    await expect(insertIdentity({ kind: "lot", code: "X1" })).rejects.toThrow(/tracking_identities_kind_allowed/);
    await expect(insertIdentity({ code: " LOT-2" })).rejects.toThrow(/tracking_identities_code_shape/);
    await expect(insertIdentity({ code: "" })).rejects.toThrow(/tracking_identities_code_shape/);
    await expect(insertIdentity({ code: "LOT-3", origin: "retail" })).rejects.toThrow(
      /tracking_identities_origin_allowed/,
    );
    await expect(insertIdentity({ code: "LOT-4", expiry: "2026-01-01", manufactured: "2026-06-01" })).rejects.toThrow(
      /tracking_identities_dates_ordered/,
    );
    await expect(insertIdentity({ code: "LOT-5", expiry: "-infinity" })).rejects.toThrow(
      /tracking_identities_dates_finite/,
    );
    await expect(insertIdentity({ code: "LOT-6", expiry: "infinity" })).rejects.toThrow(
      /tracking_identities_dates_finite/,
    );
    await expect(insertIdentity({ code: "LOT-7", manufactured: "-infinity" })).rejects.toThrow(
      /tracking_identities_dates_finite/,
    );
  });

  it("refuses a product of another tenant", async () => {
    if (skip()) return;
    await expect(insertIdentity({ code: "LOT-5", product: PRODUCT_B })).rejects.toThrow(
      /fk_tracking_identities_product_tenant/,
    );
  });

  it("tenant, product, kind, code and origin are immutable even for the superuser; expiry may move", async () => {
    if (skip()) return;
    for (const set of ["code = 'LOT-999'", "kind = 'serial'", `tenant_product_ref = '${PRODUCT_FREE}'`]) {
      await expect(pg().admin.query(`UPDATE tracking_identities SET ${set} WHERE id = $1`, [lot1])).rejects.toThrow(
        /immutable/,
      );
    }
    await pg().admin.query(`UPDATE tracking_identities SET expiry_date = '2027-04-30' WHERE id = $1`, [lot1]);
  });

  it("a tenant reads only its own identities and cannot insert for another tenant", async () => {
    if (skip()) return;
    await insertIdentity({ tenant: TENANT_B, product: PRODUCT_B, code: "B-LOT" });
    const codes = await asTenant(TENANT_B, async (c) =>
      (await c.query<{ code: string }>(`SELECT code FROM tracking_identities`)).rows.map((r) => r.code),
    );
    expect(codes).toEqual(["B-LOT"]);
    await expect(
      asTenant(TENANT_A, (c) =>
        c.query(
          `INSERT INTO tracking_identities (tenant_id, tenant_product_ref, kind, code) VALUES ($1, $2, 'batch', 'X')`,
          [TENANT_B, PRODUCT_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("the app role inserts in its own tenant but updates and deletes nothing (no policy)", async () => {
    if (skip()) return;
    const counts = await asTenant(TENANT_A, async (c) => {
      await c.query(
        `INSERT INTO tracking_identities (tenant_id, tenant_product_ref, kind, code) VALUES ($1, $2, 'batch', 'APP-LOT')`,
        [TENANT_A, PRODUCT_LOT],
      );
      return {
        updated: (await c.query(`UPDATE tracking_identities SET expiry_date = '2030-01-01'`)).rowCount,
        deleted: (await c.query(`DELETE FROM tracking_identities`)).rowCount,
      };
    });
    expect(counts).toEqual({ updated: 0, deleted: 0 });
  });
});

describe("0045 — erpnext_tracking_map (M-4, M-9)", () => {
  async function identityId(code: string, kind = "batch", product = PRODUCT_LOT): Promise<string> {
    const r = await pg().admin.query<{ id: string }>(
      `SELECT id FROM tracking_identities WHERE tenant_product_ref = $1 AND kind = $2 AND code = $3`,
      [product, kind, code],
    );
    return r.rows[0]!.id;
  }
  const insertMap = (fields: { tenant?: string; identity: string; kind?: string; ref: string }): Promise<unknown> =>
    pg().admin.query(
      `INSERT INTO erpnext_tracking_map (tenant_id, tracking_identity_id, kind, erpnext_ref) VALUES ($1, $2, $3, $4)`,
      [fields.tenant ?? TENANT_A, fields.identity, fields.kind ?? "batch", fields.ref],
    );

  it("maps an identity 1:1 to an ERPNext name of the same kind", async () => {
    if (skip()) return;
    const lot = await identityId("LOT-001");
    await insertMap({ identity: lot, ref: "BATCH-LOT-001" });
    await expect(insertMap({ identity: lot, ref: "BATCH-OTHER" })).rejects.toThrow(/uq_erpnext_tracking_map_identity/);
    await expect(insertMap({ identity: await identityId("LOT-001", "batch", PRODUCT_FREE), ref: "BATCH-LOT-001" })).rejects.toThrow(
      /uq_erpnext_tracking_map_tenant_kind_ref/,
    );
    // The same name as a Serial No is a different ERPNext document.
    await insertMap({ identity: await identityId("LOT-001", "serial"), kind: "serial", ref: "BATCH-LOT-001" });
  });

  it("refuses a kind that differs from the identity's, and an identity of another tenant", async () => {
    if (skip()) return;
    const freeLot = await identityId("LOT-001", "batch", PRODUCT_FREE);
    await expect(insertMap({ identity: freeLot, kind: "serial", ref: "SN-1" })).rejects.toThrow(
      /fk_erpnext_tracking_map_identity/,
    );
    await expect(insertMap({ tenant: TENANT_B, identity: freeLot, ref: "B-1" })).rejects.toThrow(
      /fk_erpnext_tracking_map_identity/,
    );
  });

  it("the app role updates and deletes nothing", async () => {
    if (skip()) return;
    const counts = await asTenant(TENANT_A, async (c) => ({
      updated: (await c.query(`UPDATE erpnext_tracking_map SET erpnext_ref = 'X'`)).rowCount,
      deleted: (await c.query(`DELETE FROM erpnext_tracking_map`)).rowCount,
    }));
    expect(counts).toEqual({ updated: 0, deleted: 0 });
  });
});

describe("0045 — stock_movements.tracking_identity_id (G7-2)", () => {
  async function lotOf(product: string): Promise<string> {
    const r = await pg().admin.query<{ id: string }>(
      `SELECT id FROM tracking_identities WHERE tenant_product_ref = $1 AND kind = 'batch' AND code = 'LOT-001'`,
      [product],
    );
    return r.rows[0]!.id;
  }

  it("accepts an identity of the effect's own product", async () => {
    if (skip()) return;
    await insertTrackedMovement({ product: PRODUCT_LOT, identity: await lotOf(PRODUCT_LOT) });
  });

  it("refuses an identity of another product, and an identity without a product", async () => {
    if (skip()) return;
    await expect(insertTrackedMovement({ product: PRODUCT_FREE, identity: await lotOf(PRODUCT_LOT) })).rejects.toThrow(
      /fk_stock_movements_tracking_identity/,
    );
    await expect(insertTrackedMovement({ product: null, identity: await lotOf(PRODUCT_LOT) })).rejects.toThrow(
      /stock_movements_tracking_identity_needs_product/,
    );
  });

  it("the free-text tracking_identity column stays refused", async () => {
    if (skip()) return;
    await expect(
      pg().admin.query(
        `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
                                      occurred_at, created_by, stock_location_id, inventory_status, tracking_identity)
         VALUES (gen_random_uuid(), $1, $2, 'inbound', 1, 'ea', now(), $3, $4, 'sellable', 'LOT-1')`,
        [TENANT_A, STORE_A, ACTOR, await primaryOf(STORE_A)],
      ),
    ).rejects.toThrow(/stock_movements_tracking_none/);
  });

  it("a referenced identity cannot be deleted", async () => {
    if (skip()) return;
    await expect(
      pg().admin.query(`DELETE FROM tracking_identities WHERE id = $1`, [await lotOf(PRODUCT_LOT)]),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("0045 — down → up round-trip", () => {
  const identitiesTable = async (): Promise<string | null> =>
    (await pg().admin.query<{ t: string | null }>(`SELECT to_regclass('public.tracking_identities')::text AS t`))
      .rows[0]?.t ?? null;

  it("down refuses while an effect names an identity, identities exist or a profile is set", async () => {
    if (skip()) return;
    const down = (): Promise<unknown> => pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    await expect(down()).rejects.toThrow(/0045 down refused: \d+ stock_movements row\(s\) name a tracking identity/);
    await pg().admin.query(`DELETE FROM stock_movements WHERE tracking_identity_id IS NOT NULL`);
    await expect(down()).rejects.toThrow(/tracking identit\(ies\)/);
    await pg().admin.query(`DELETE FROM erpnext_tracking_map`);
    await pg().admin.query(`DELETE FROM tracking_identities`);
    await expect(down()).rejects.toThrow(/non-default tracking profile/);
    expect(await identitiesTable()).toBe("tracking_identities");
  });

  it("otherwise removes the tables, columns, triggers and constraints; up restores them", async () => {
    if (skip()) return;
    await pg().admin.query(`UPDATE tenant_products SET tracking_mode = 'none', expiry_required = false
                             WHERE id = ANY($1::uuid[])`, [[PRODUCT_FREE, PRODUCT_LOT]]);
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    expect(await identitiesTable()).toBeNull();
    const leftovers = await pg().admin.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'tenant_products' AND column_name IN ('tracking_mode', 'expiry_required'))
            OR (table_name = 'stock_movements' AND column_name = 'tracking_identity_id'))
       UNION ALL
       SELECT 1 FROM pg_trigger WHERE tgname = 'tenant_products_guard_tracking_profile'
       UNION ALL
       SELECT 1 FROM pg_class WHERE relname IN ('erpnext_tracking_map', 'uq_tenant_products_id_tenant')`,
    );
    expect(leftovers.rowCount).toBe(0);

    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    expect(await identitiesTable()).toBe("tracking_identities");
    const profiles = await pg().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_products WHERE tracking_mode = 'none' AND NOT expiry_required`,
    );
    expect(profiles.rows[0]?.n).toBe("5");
  });
});
