/**
 * 0055 — inventory position events and tenant inventory settings (Jira
 * RT-435; owner decisions D1–D4, RT-435 comment 12993).
 *
 * Applies every migration before 0055 against a real Postgres, seeds two
 * tenants with a store each (the stores trigger gives each a primary location)
 * and a storage location, applies 0055, then proves:
 *   - inventory_position_events: kind, positive quantity, statuses in the
 *     closed enum, the status-move shape (same location, different status, a
 *     reason code), the relocation shape (different location, same status), the
 *     governed reason codes, a note on `correction`, the fingerprint shape and
 *     its per-tenant uniqueness;
 *   - the composite FKs: a location of another store or tenant, a product of
 *     another tenant, and a tracking identity of another product are refused;
 *   - tenant_inventory_settings: `sellable` default, only `sellable` |
 *     `return_inspection`;
 *   - RLS: ENABLE + FORCE; events SELECT + INSERT only (no UPDATE / DELETE),
 *     settings SELECT + INSERT + UPDATE (no DELETE); fail-closed and
 *     tenant-scoped;
 *   - down refuses while an event or a non-default setting exists (also as a
 *     NON-superuser owner under FORCE RLS) and round-trips with up.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0055_inventory_position_events.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0055_inventory_position_events.down.sql");

const TENANT = "0a000000-0000-7000-8000-000000043501";
const TENANT_B = "0b000000-0000-7000-8000-000000043501";
const STORE = "0a000000-0000-7000-8000-000000043502";
const STORE_2 = "0a000000-0000-7000-8000-000000043503";
const STORE_B = "0b000000-0000-7000-8000-000000043502";
const ACTOR = "0a000000-0000-7000-8000-000000043504";
const PRODUCT = "0a000000-0000-7000-8000-000000043510";
const PRODUCT_2 = "0a000000-0000-7000-8000-000000043511";
const PRODUCT_B = "0b000000-0000-7000-8000-000000043510";
const BACKROOM = "0a000000-0000-7000-8000-0000000435b1";
const IDENTITY_OF_PRODUCT_2 = "0a000000-0000-7000-8000-0000000435c1";

let env: PgTestEnv | null = null;
const primaries = new Map<string, string>();

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const skip = (): boolean => env === null;

async function applyBefore0055(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
}

interface EventRow {
  readonly tenantId?: string;
  readonly storeId?: string;
  readonly kind?: string;
  readonly productId?: string;
  readonly quantity?: string;
  readonly unit?: string;
  readonly fromLocation?: string;
  readonly toLocation?: string | undefined;
  readonly fromStatus?: string;
  readonly toStatus?: string;
  readonly reasonCode?: string | null;
  readonly note?: string | null;
  readonly trackingIdentityId?: string | null;
  readonly fingerprint?: string;
}

const EVENT_SQL = `INSERT INTO inventory_position_events
       (id, tenant_id, store_id, kind, tenant_product_ref, quantity, stocking_unit,
        from_location_id, to_location_id, from_status, to_status, reason_code, note,
        tracking_identity_id, command_fingerprint, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`;

/** A valid status move (sellable -> damaged at the primary) unless overridden. */
function eventParams(row: EventRow): unknown[] {
  const primary = primaries.get(row.storeId ?? STORE)!;
  return [
    row.tenantId ?? TENANT,
    row.storeId ?? STORE,
    row.kind ?? "status_move",
    row.productId ?? PRODUCT,
    row.quantity ?? "2",
    row.unit ?? "ea",
    row.fromLocation ?? primary,
    row.toLocation ?? primary,
    row.fromStatus ?? "sellable",
    row.toStatus ?? "damaged",
    row.reasonCode === undefined ? "damage" : row.reasonCode,
    row.note === undefined ? null : row.note,
    row.trackingIdentityId === undefined ? null : row.trackingIdentityId,
    row.fingerprint ?? "a".repeat(64),
    ACTOR,
  ];
}

const RELOCATION: EventRow = {
  kind: "relocation",
  toLocation: BACKROOM,
  toStatus: "sellable",
  reasonCode: null,
};

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

async function tryEvent(row: EventRow): Promise<string | null> {
  return inRolledBackTx((c) => errorCode(() => c.query(EVENT_SQL, eventParams(row))));
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

const TABLES = ["inventory_position_events", "tenant_inventory_settings"] as const;

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
      console.warn(`\n[0055-inventory-position-events.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0055(env);
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'rt435-a', 'rt435-a'), ($2, 'rt435-b', 'rt435-b')`, [
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
    `INSERT INTO stock_locations (id, tenant_id, store_id, code, name, kind) VALUES ($1, $2, $3, 'BACK', 'Backroom', 'storage')`,
    [BACKROOM, TENANT, STORE],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by) VALUES
       ($1, $4, 'P', 'standard', $6, $6), ($2, $4, 'P2', 'standard', $6, $6), ($3, $5, 'PB', 'standard', $6, $6)`,
    [PRODUCT, PRODUCT_2, PRODUCT_B, TENANT, TENANT_B, ACTOR],
  );
  await a.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code) VALUES ($1, $2, $3, 'batch', 'LOT-1')`,
    [IDENTITY_OF_PRODUCT_2, TENANT, PRODUCT_2],
  );
  await a.query(readFileSync(UP_PATH, "utf8"));
  await ensureAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0055 inventory_position_events constraints", () => {
  it("accepts a status move and a relocation", async () => {
    if (skip()) return;
    expect(await tryEvent({})).toBeNull();
    expect(await tryEvent(RELOCATION)).toBeNull();
  });

  it.each<[string, EventRow]>([
    ["an unknown kind", { kind: "transfer" }],
    ["a zero quantity", { quantity: "0" }],
    ["a negative quantity", { quantity: "-1" }],
    ["an unknown status", { toStatus: "on_shelf" }],
    ["a status move to the same status", { toStatus: "sellable" }],
    ["a status move across locations", { toLocation: BACKROOM }],
    ["a status move without a reason code", { reasonCode: null }],
    ["a relocation to the same location", { ...RELOCATION, toLocation: undefined }],
    ["a relocation that changes the status", { ...RELOCATION, toStatus: "damaged" }],
    ["an unknown reason code", { reasonCode: "shrinkage" }],
    ["a correction without a note", { reasonCode: "correction" }],
    ["an empty note", { note: "" }],
    ["a malformed fingerprint", { fingerprint: "not-hex" }],
    ["an empty unit", { unit: "" }],
  ])("refuses %s (23514)", async (_label, row) => {
    if (skip()) return;
    expect(await tryEvent(row)).toBe("23514");
  });

  it.each<[string, EventRow]>([
    ["a location of another store of the tenant", { toLocation: primaries.get(STORE_2) ?? "", kind: "relocation", reasonCode: null, toStatus: "sellable" }],
    ["a product of another tenant", { productId: PRODUCT_B }],
    ["a tracking identity of another product", { trackingIdentityId: IDENTITY_OF_PRODUCT_2 }],
  ])("refuses %s (23503)", async (_label, row) => {
    if (skip()) return;
    // `primaries` is filled in beforeAll, after it.each built its table.
    const fixed = row.toLocation === "" ? { ...row, toLocation: primaries.get(STORE_2)! } : row;
    expect(await tryEvent(fixed)).toBe("23503");
  });

  it("accepts a correction with a note, and an identity of the event's own product", async () => {
    if (skip()) return;
    expect(await tryEvent({ reasonCode: "correction", note: "miscount" })).toBeNull();
    expect(await tryEvent({ productId: PRODUCT_2, trackingIdentityId: IDENTITY_OF_PRODUCT_2 })).toBeNull();
  });

  it("refuses a second event with the same fingerprint in one tenant (23505), not across tenants", async () => {
    if (skip()) return;
    const codes = await inRolledBackTx(async (c) => {
      await c.query(EVENT_SQL, eventParams({}));
      const sameTenant = await errorCode(async () => {
        await c.query("SAVEPOINT s");
        try {
          await c.query(EVENT_SQL, eventParams({}));
        } finally {
          await c.query("ROLLBACK TO SAVEPOINT s");
        }
      });
      const otherTenant = await errorCode(() =>
        c.query(EVENT_SQL, eventParams({ tenantId: TENANT_B, storeId: STORE_B, productId: PRODUCT_B })),
      );
      return [sameTenant, otherTenant];
    });
    expect(codes).toEqual(["23505", null]);
  });
});

describe("0055 tenant_inventory_settings constraints", () => {
  it("defaults to sellable and accepts return_inspection; refuses anything else", async () => {
    if (skip()) return;
    const result = await inRolledBackTx(async (c) => {
      const r = await c.query<{ s: string }>(
        `INSERT INTO tenant_inventory_settings (tenant_id, updated_by) VALUES ($1, $2) RETURNING return_landing_status AS s`,
        [TENANT, ACTOR],
      );
      await c.query(`UPDATE tenant_inventory_settings SET return_landing_status = 'return_inspection' WHERE tenant_id = $1`, [
        TENANT,
      ]);
      const bad = await errorCode(() =>
        c.query(`UPDATE tenant_inventory_settings SET return_landing_status = 'damaged' WHERE tenant_id = $1`, [TENANT]),
      );
      return [r.rows[0]!.s, bad];
    });
    expect(result).toEqual(["sellable", "23514"]);
  });
});

describe("0055 RLS", () => {
  it("enables and forces RLS with SELECT + INSERT on events and SELECT + INSERT + UPDATE on settings", async () => {
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
      { relname: "inventory_position_events", on: true, forced: true, cmds: "INSERT,SELECT" },
      { relname: "tenant_inventory_settings", on: true, forced: true, cmds: "INSERT,SELECT,UPDATE" },
    ]);
  });

  it("is tenant-scoped and fails closed on an unset tenant GUC", async () => {
    if (skip()) return;
    await pg().admin.query(EVENT_SQL, eventParams({ fingerprint: "b".repeat(64) }));
    try {
      const seen = async (guc: string | null): Promise<number> =>
        asApp(guc, async (c) => (await c.query(`SELECT 1 FROM inventory_position_events`)).rowCount ?? 0);
      expect(await seen(TENANT)).toBe(1);
      expect(await seen(TENANT_B)).toBe(0);
      expect(await seen("")).toBe(0);
    } finally {
      await pg().admin.query(`DELETE FROM inventory_position_events WHERE command_fingerprint = $1`, ["b".repeat(64)]);
    }
  });

  it("refuses an app-role insert for another tenant (42501) and never updates or deletes an event", async () => {
    if (skip()) return;
    const crossTenant = await asApp(TENANT_B, (c) => errorCode(() => c.query(EVENT_SQL, eventParams({}))));
    expect(crossTenant).toBe("42501");
    const changed = await asApp(TENANT, async (c) => {
      await c.query(EVENT_SQL, eventParams({ fingerprint: "c".repeat(64) }));
      const updated = (await c.query(`UPDATE inventory_position_events SET note = 'x'`)).rowCount;
      const deleted = (await c.query(`DELETE FROM inventory_position_events`)).rowCount;
      return [updated, deleted];
    });
    expect(changed).toEqual([0, 0]);
  });
});

describe("0055 down", () => {
  async function runDown(role: string | null): Promise<string | null> {
    const client = await pg().admin.connect();
    try {
      if (role !== null) await client.query(`SET ROLE ${role}`);
      return await errorCode(() => client.query(readFileSync(DOWN_PATH, "utf8")));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  }

  async function withEvent(fn: () => Promise<void>): Promise<void> {
    await pg().admin.query(EVENT_SQL, eventParams({ fingerprint: "d".repeat(64) }));
    try {
      await fn();
    } finally {
      await pg().admin.query(`DELETE FROM inventory_position_events WHERE command_fingerprint = $1`, ["d".repeat(64)]);
    }
  }

  it("refuses loudly while an event exists, and changes nothing", async () => {
    if (skip()) return;
    await withEvent(async () => {
      expect(await runDown(null)).toBe("P0001");
      expect(await tableCount()).toBe(2);
    });
  });

  it("refuses while a tenant has a non-default return landing status", async () => {
    if (skip()) return;
    await pg().admin.query(
      `INSERT INTO tenant_inventory_settings (tenant_id, return_landing_status, updated_by) VALUES ($1, 'return_inspection', $2)`,
      [TENANT_B, ACTOR],
    );
    try {
      expect(await runDown(null)).toBe("P0001");
      expect(await tableCount()).toBe(2);
    } finally {
      await pg().admin.query(`DELETE FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_B]);
    }
  });

  const MIGRATION_OWNER = "rt435_migration_owner";
  const OWNED_TABLES = ["tenants", ...TABLES];

  // The production migration owner is NOT a superuser, so FORCE ROW LEVEL
  // SECURITY applies to it: a guard reading without a tenant GUC would see no
  // rows and drop every event.
  it("refuses as a NON-superuser owner under FORCE RLS, and drops nothing", async () => {
    if (skip()) return;
    await withEvent(async () => {
      const superuser = (await pg().admin.query<{ u: string }>(`SELECT current_user AS u`)).rows[0]!.u;
      await pg().admin.query(`CREATE ROLE ${MIGRATION_OWNER} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await pg().admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATION_OWNER}`);
      for (const table of OWNED_TABLES) await pg().admin.query(`ALTER TABLE ${table} OWNER TO ${MIGRATION_OWNER}`);
      try {
        expect(await runDown(MIGRATION_OWNER)).toBe("P0001");
        expect(await tableCount()).toBe(2);
      } finally {
        for (const table of OWNED_TABLES) {
          await pg().admin.query(`ALTER TABLE ${table} OWNER TO ${superuser}`).catch(() => undefined);
        }
        await pg().admin.query(`REVOKE ALL ON SCHEMA public FROM ${MIGRATION_OWNER}`).catch(() => undefined);
        await pg().admin.query(`DROP ROLE ${MIGRATION_OWNER}`).catch(() => undefined);
      }
    });
  });

  it("round-trips: down removes both tables, up restores them", async () => {
    if (skip()) return;
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    expect(await tableCount()).toBe(0);
    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    expect(await tableCount()).toBe(2);
    await ensureAppRole(pg());
  });
});
