/**
 * 0042 + 0043 — Inventory Effects Journal (Jira RT-425; decisions RT-289
 * G2-2 / G2-3 / G2-4, Q1 / Q2 / Q6).
 *
 * Applies every migration before 0042 against a real Postgres, seeds pre-0042
 * movements for two tenants (the UPGRADE path), applies 0042 and 0043, then
 * proves:
 *   - existing movements become `retail` effects with no owning event (history
 *     is not rewritten) and each gets exactly one `not_posted` integration
 *     record, per tenant;
 *   - 0043 is idempotent and catches up a movement written without a record
 *     (the deploy catch-up script re-runs it);
 *   - the new CHECKs and same-tenant FKs hold;
 *   - the integration record is tenant-isolated: SELECT / INSERT / UPDATE by
 *     tenant, no DELETE, and no re-homing to another tenant;
 *   - erpnext_posting_status.posted_at exists and only a posted row may carry it;
 *   - down refuses while an effect carries post-0042 data, and otherwise
 *     round-trips with up.
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
const UP_NAME = "0042_inventory_effects_journal.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0042_inventory_effects_journal.down.sql");
const BACKFILL_PATH = resolve(DRIZZLE_DIR, "0043_inventory_effect_integration_backfill.sql");

const TENANT_A = "0a000000-0000-7000-8000-000000042a01";
const TENANT_B = "0b000000-0000-7000-8000-000000042b01";
const STORE_A = "0a000000-0000-7000-8000-000000042a02";
const STORE_B = "0b000000-0000-7000-8000-000000042b02";
const ACTOR = "0a000000-0000-7000-8000-000000042a04";
const MOVE_A1 = "0a000000-0000-7000-8000-000000042a11";
const MOVE_A2 = "0a000000-0000-7000-8000-000000042a12";
const MOVE_B1 = "0b000000-0000-7000-8000-000000042b11";
const MOVE_B2 = "0b000000-0000-7000-8000-000000042b12";
const MOVE_A_LATE = "0a000000-0000-7000-8000-000000042a13";
const MOVE_A_EVENT = "0a000000-0000-7000-8000-000000042a14";

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function applyBefore0042(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(pgEnv);
}

async function insertMovement(
  id: string,
  tenant: string,
  store: string,
  extra: { eventType?: string; eventRefId?: string; origin?: string } = {},
): Promise<void> {
  const cols = ["id", "tenant_id", "store_id", "movement_type", "quantity", "stocking_unit", "occurred_at", "created_by"];
  const vals: unknown[] = [id, tenant, store, "inbound", "1", "ea", "2026-10-01T10:00:00Z", ACTOR];
  if (extra.origin) {
    cols.push("origin");
    vals.push(extra.origin);
  }
  if (extra.eventType) {
    cols.push("event_type", "event_ref_id");
    vals.push(extra.eventType, extra.eventRefId);
  }
  await pg().admin.query(
    `INSERT INTO stock_movements (${cols.join(", ")})
     VALUES (${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
    vals,
  );
}

/** Run `fn` on the non-superuser app pool inside `tenant`'s RLS context. */
async function asTenant<T>(tenant: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pg().app.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenant]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function integrationStates(): Promise<Array<{ effect_id: string; tenant_id: string; state: string }>> {
  const r = await pg().admin.query<{ effect_id: string; tenant_id: string; state: string }>(
    `SELECT effect_id, tenant_id, state FROM inventory_effect_integration ORDER BY effect_id`,
  );
  return r.rows;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0042-inventory-effects-journal.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0042(env);
  for (const [tenant, store, slug] of [
    [TENANT_A, STORE_A, "rt425-a"],
    [TENANT_B, STORE_B, "rt425-b"],
  ] as const) {
    await env.admin.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)`, [tenant, slug]);
    await env.admin.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, $3)`, [
      store,
      tenant,
      slug,
    ]);
  }
  // Pre-0042 movements, written by the 009 writers.
  await insertMovement(MOVE_A1, TENANT_A, STORE_A);
  await insertMovement(MOVE_A2, TENANT_A, STORE_A);
  await insertMovement(MOVE_B1, TENANT_B, STORE_B);

  await env.admin.query(readFileSync(UP_PATH, "utf8"));
  await env.admin.query(readFileSync(BACKFILL_PATH, "utf8"));
  // Grant the app role on the table 0042 created (as production's grant script does).
  await ensureAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

describe("0042/0043 — upgrade over existing movements", () => {
  it("makes every existing movement a retail effect with no owning event (history untouched)", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ origin: string; event_type: string | null; event_ref_id: string | null }>(
      `SELECT DISTINCT origin, event_type, event_ref_id FROM stock_movements`,
    );
    expect(r.rows).toEqual([{ origin: "retail", event_type: null, event_ref_id: null }]);
  });

  it("gives each existing movement exactly one not_posted record, in its own tenant", async () => {
    if (skip()) return;
    expect(await integrationStates()).toEqual(
      [
        { effect_id: MOVE_A1, tenant_id: TENANT_A, state: "not_posted" },
        { effect_id: MOVE_A2, tenant_id: TENANT_A, state: "not_posted" },
        { effect_id: MOVE_B1, tenant_id: TENANT_B, state: "not_posted" },
      ].sort((x, y) => x.effect_id.localeCompare(y.effect_id)),
    );
  });

  it("0043 is idempotent and catches up a movement written without a record", async () => {
    if (skip()) return;
    await insertMovement(MOVE_A_LATE, TENANT_A, STORE_A);
    await pg().admin.query(readFileSync(BACKFILL_PATH, "utf8"));
    await pg().admin.query(readFileSync(BACKFILL_PATH, "utf8"));
    const states = await integrationStates();
    expect(states).toHaveLength(4);
    expect(states.find((s) => s.effect_id === MOVE_A_LATE)?.state).toBe("not_posted");
  });
});

describe("0042 — effect constraints", () => {
  it("accepts a retail effect with a Retail event, and refuses a half event pair", async () => {
    if (skip()) return;
    await insertMovement(MOVE_A_EVENT, TENANT_A, STORE_A, { eventType: "adjustment", eventRefId: MOVE_A_EVENT });
    await expect(
      pg().admin.query(
        `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
                                      occurred_at, created_by, event_type)
         VALUES (gen_random_uuid(), $1, $2, 'inbound', 1, 'ea', now(), $3, 'adjustment')`,
        [TENANT_A, STORE_A, ACTOR],
      ),
    ).rejects.toThrow(/stock_movements_event_pair/);
  });

  it("refuses an event type of the other origin, an unknown origin and an unknown event type", async () => {
    if (skip()) return;
    const ref = "0a000000-0000-7000-8000-000000042aff";
    await expect(
      insertMovement("0a000000-0000-7000-8000-000000042a21", TENANT_A, STORE_A, {
        eventType: "erp_opening_stock",
        eventRefId: ref,
      }),
    ).rejects.toThrow(/stock_movements_event_origin_consistent/);
    await expect(
      insertMovement("0a000000-0000-7000-8000-000000042a22", TENANT_A, STORE_A, {
        origin: "erp_external",
        eventType: "sale",
        eventRefId: ref,
      }),
    ).rejects.toThrow(/stock_movements_event_origin_consistent/);
    await expect(
      insertMovement("0a000000-0000-7000-8000-000000042a23", TENANT_A, STORE_A, { origin: "pos" }),
    ).rejects.toThrow(/stock_movements_origin_allowed/);
    await expect(
      insertMovement("0a000000-0000-7000-8000-000000042a24", TENANT_A, STORE_A, {
        origin: "erp_external",
        eventType: "refund",
        eventRefId: ref,
      }),
    ).rejects.toThrow(/stock_movements_event_type_allowed|stock_movements_event_origin_consistent/);
  });

  it("allows an ERP-origin effect with an ERP event type", async () => {
    if (skip()) return;
    await insertMovement("0a000000-0000-7000-8000-000000042a25", TENANT_A, STORE_A, {
      origin: "erp_external",
      eventType: "erp_procurement_receipt",
      eventRefId: "0a000000-0000-7000-8000-000000042afe",
    });
  });

  it("a compensating effect must name another effect of the same tenant", async () => {
    if (skip()) return;
    const insertComp = (id: string, compensates: string): Promise<unknown> =>
      pg().admin.query(
        `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
                                      occurred_at, created_by, compensates_effect_id)
         VALUES ($1, $2, $3, 'outbound', -1, 'ea', now(), $4, $5)`,
        [id, TENANT_A, STORE_A, ACTOR, compensates],
      );
    const self = "0a000000-0000-7000-8000-000000042a31";
    await expect(insertComp(self, self)).rejects.toThrow(/stock_movements_compensates_not_self/);
    await expect(insertComp("0a000000-0000-7000-8000-000000042a32", MOVE_B1)).rejects.toThrow(
      /fk_stock_movements_compensates_tenant/,
    );
    await insertComp("0a000000-0000-7000-8000-000000042a33", MOVE_A1);
  });
});

describe("0042 — integration record constraints", () => {
  const insertState = (fields: Record<string, unknown>): Promise<unknown> => {
    const cols = Object.keys(fields);
    return pg().admin.query(
      `INSERT INTO inventory_effect_integration (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(fields),
    );
  };

  it("an intent-bearing state needs a posting intent, and not_posted forbids one", async () => {
    if (skip()) return;
    await expect(insertState({ effect_id: MOVE_A_EVENT, tenant_id: TENANT_A, state: "pending" })).rejects.toThrow(
      /inventory_effect_integration_intent_link/,
    );
    await expect(
      insertState({
        effect_id: MOVE_A_EVENT,
        tenant_id: TENANT_A,
        state: "not_posted",
        posting_status_id: "0a000000-0000-7000-8000-000000042a99",
      }),
    ).rejects.toThrow(/inventory_effect_integration_intent_link/);
  });

  it("only a confirmed effect carries erp_confirmed_at, and an unknown state is refused", async () => {
    if (skip()) return;
    await expect(
      insertState({ effect_id: MOVE_A_EVENT, tenant_id: TENANT_A, state: "not_posted", erp_confirmed_at: new Date() }),
    ).rejects.toThrow(/inventory_effect_integration_confirmed_at/);
    await expect(insertState({ effect_id: MOVE_A_EVENT, tenant_id: TENANT_A, state: "shipped" })).rejects.toThrow(
      /inventory_effect_integration_state_allowed/,
    );
  });

  it("refuses a record for another tenant's effect and a second record for one effect", async () => {
    if (skip()) return;
    // A tenant-B effect with no record yet, so the same-tenant FK (not the PK) decides.
    await insertMovement(MOVE_B2, TENANT_B, STORE_B);
    await expect(insertState({ effect_id: MOVE_B2, tenant_id: TENANT_A, state: "not_posted" })).rejects.toThrow(
      /fk_inventory_effect_integration_effect_tenant/,
    );
    await expect(insertState({ effect_id: MOVE_A1, tenant_id: TENANT_A, state: "not_posted" })).rejects.toThrow(
      /inventory_effect_integration_pkey/,
    );
  });
});

describe("0042 — integration record RLS (non-superuser app role)", () => {
  it("a tenant reads only its own records", async () => {
    if (skip()) return;
    const ids = await asTenant(TENANT_B, async (c) =>
      (await c.query<{ effect_id: string }>(`SELECT effect_id FROM inventory_effect_integration`)).rows.map(
        (r) => r.effect_id,
      ),
    );
    expect(ids).toEqual([MOVE_B1]);
  });

  it("a tenant cannot insert a record for another tenant", async () => {
    if (skip()) return;
    await expect(
      asTenant(TENANT_A, (c) =>
        c.query(
          `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state) VALUES ($1, $2, 'not_posted')`,
          [MOVE_A_EVENT, TENANT_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("updates reach only the tenant's own rows and cannot re-home a row", async () => {
    if (skip()) return;
    const crossTenant = await asTenant(TENANT_A, async (c) =>
      (await c.query(`UPDATE inventory_effect_integration SET state_reason = 'x' WHERE effect_id = $1`, [MOVE_B1]))
        .rowCount,
    );
    expect(crossTenant).toBe(0);
    const own = await asTenant(TENANT_A, async (c) =>
      (await c.query(`UPDATE inventory_effect_integration SET state_reason = 'x' WHERE effect_id = $1`, [MOVE_A1]))
        .rowCount,
    );
    expect(own).toBe(1);
    await expect(
      asTenant(TENANT_A, (c) =>
        c.query(`UPDATE inventory_effect_integration SET tenant_id = $1 WHERE effect_id = $2`, [TENANT_B, MOVE_A1]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("no DELETE policy: a delete removes nothing, and stock_movements stays append-only", async () => {
    if (skip()) return;
    const counts = await asTenant(TENANT_A, async (c) => ({
      deleted: (await c.query(`DELETE FROM inventory_effect_integration`)).rowCount,
      updatedMovements: (await c.query(`UPDATE stock_movements SET origin = 'erp_external'`)).rowCount,
    }));
    expect(counts).toEqual({ deleted: 0, updatedMovements: 0 });
  });
});

describe("0042 — erpnext_posting_status.posted_at", () => {
  it("adds a nullable posted_at guarded to posted rows", async () => {
    if (skip()) return;
    const col = await pg().admin.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'erpnext_posting_status' AND column_name = 'posted_at'`,
    );
    expect(col.rows).toEqual([{ is_nullable: "YES" }]);
    const chk = await pg().admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'erpnext_posting_status_posted_at_when_posted'`,
    );
    expect(chk.rows[0]?.def).toMatch(/posted_at IS NULL\) OR \(status = 'posted'/);
  });
});

describe("0042 — down → up round-trip", () => {
  const effectColumns = async (): Promise<number> =>
    (
      await pg().admin.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'stock_movements'
            AND column_name IN ('origin', 'event_type', 'event_ref_id', 'compensates_effect_id',
                                'stock_location_id', 'inventory_status', 'tracking_identity')`,
      )
    ).rowCount ?? 0;

  it("down refuses while an effect carries post-0042 data (nothing is silently dropped)", async () => {
    if (skip()) return;
    await expect(pg().admin.query(readFileSync(DOWN_PATH, "utf8"))).rejects.toThrow(/0042 down refused/);
    expect(await effectColumns()).toBe(7);
  });

  it("down removes the effect columns, the integration table and posted_at; up + 0043 restore them", async () => {
    if (skip()) return;
    // Remove the post-0042 rows (and their records) so the guard allows the down.
    await pg().admin.query(`DELETE FROM inventory_effect_integration`);
    await pg().admin.query(
      `DELETE FROM stock_movements
        WHERE origin <> 'retail' OR event_type IS NOT NULL OR compensates_effect_id IS NOT NULL`,
    );
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    expect(await effectColumns()).toBe(0);
    const table = await pg().admin.query(`SELECT to_regclass('public.inventory_effect_integration') AS t`);
    expect(table.rows[0]?.t).toBeNull();

    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    await pg().admin.query(readFileSync(BACKFILL_PATH, "utf8"));
    expect(await effectColumns()).toBe(7);
    const states = await integrationStates();
    expect(states.every((s) => s.state === "not_posted")).toBe(true);
    expect(states.map((s) => s.effect_id)).toEqual(expect.arrayContaining([MOVE_A1, MOVE_A2, MOVE_B1, MOVE_A_LATE]));
  });
});
