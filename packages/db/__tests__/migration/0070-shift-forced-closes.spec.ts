/**
 * 0070 — the manager's not-counted force close (Jira RT-742; [GATED];
 * contract pos-shifts.openapi.yaml 1.4.0-draft `forceCloseShift`).
 *
 * Applies every migration before 0070 against a real Postgres, seeds open
 * shifts (a cash-up one, a legacy one with no currency or float, one of
 * another store), then applies 0070 AS A NON-SUPERUSER OWNER (the production
 * migration owner is not a superuser, so FORCE RLS applies to it) and proves:
 *   - the two composite FK targets are added over the existing rows;
 *   - shift_forced_closes pins the shift to its tenant, store and opening
 *     terminal (legacy shifts included), and the calling terminal to the same
 *     tenant and store; its reason and hash CHECKs; one row per shift;
 *   - FORCED RLS with SELECT + INSERT only: another tenant neither reads nor
 *     writes it; append-only for every role (42501);
 *   - a force close only of an open shift (55000), and a cash-up close of a
 *     force-closed shift is refused the same way;
 *   - the shifts guard: a cash-up shift moves open → closed_forced with its
 *     force close and never without one;
 *   - down refuses while a force close is recorded (as the non-superuser
 *     owner, under FORCE RLS), then rolls back and round-trips with up.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0070_shift_forced_closes.sql";
const UP_SQL = (): string => readFileSync(resolve(DRIZZLE_DIR, UP_NAME), "utf8");
const DOWN_SQL = (): string => readFileSync(resolve(DRIZZLE_DIR, "0070_shift_forced_closes.down.sql"), "utf8");

const TENANT_A = "0a000000-0000-7000-8000-000000074201";
const TENANT_B = "0a000000-0000-7000-8000-000000074202";
const STORE_A1 = "0a000000-0000-7000-8000-000000074211";
const STORE_A2 = "0a000000-0000-7000-8000-000000074212";
const STORE_B1 = "0a000000-0000-7000-8000-000000074213";
const DEV_A1 = "0a000000-0000-7000-8000-000000074221";
const DEV_A1_SECOND = "0a000000-0000-7000-8000-000000074222";
const DEV_A2 = "0a000000-0000-7000-8000-000000074223";
const DEV_B1 = "0a000000-0000-7000-8000-000000074224";
const CASHIER = "0a000000-0000-7000-8000-000000074231";
const MANAGER = "0a000000-0000-7000-8000-000000074232";
const MANAGER_B = "0a000000-0000-7000-8000-000000074233";

const HASH = createHash("sha256").update("rt742").digest();
const MIGRATION_OWNER = "rt742_migration_owner";
/** Every table 0070 alters, references or replaces a function over. */
const OWNED_TABLES = ["tenants", "stores", "users", "devices", "shifts", "shift_closes"];
const OWNED_FUNCTIONS = ["shifts_cash_up_guard()", "shift_cash_up_append_only()"];

let env: PgTestEnv | null = null;
let superuser = "postgres";

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

/** The SQLSTATE `fn` fails with, or null when it succeeds. */
async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err: unknown) {
    return (err as { code?: string }).code ?? String(err);
  }
}

/** Runs `fn` as the non-superuser app role with `app.current_tenant` = `tenant`, then rolls back. */
async function asApp<T>(tenant: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pg().app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Runs `sql` as the non-superuser migration owner on one connection. */
async function asOwner(sql: string): Promise<void> {
  const client = await pg().admin.connect();
  try {
    await client.query(`SET ROLE ${MIGRATION_OWNER}`);
    await client.query(sql);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET ROLE").catch(() => undefined);
    client.release();
  }
}

/** One force close as the app role writes it; `over` replaces any column. */
interface ForceClose {
  shift_id: string;
  tenant_id: string;
  store_id: string;
  opening_device_id: string;
  closed_from_device_id: string;
  closed_by_user_id: string;
  forced_reason: string;
  payload_hash: Buffer;
}

const forceCloseOf = (shiftId: string, over: Partial<ForceClose> = {}): ForceClose => ({
  shift_id: shiftId,
  tenant_id: TENANT_A,
  store_id: STORE_A1,
  opening_device_id: DEV_A1,
  closed_from_device_id: DEV_A1_SECOND,
  closed_by_user_id: MANAGER,
  forced_reason: "Cashier left without closing",
  payload_hash: HASH,
  ...over,
});

const INSERT_FORCE_CLOSE = `
  INSERT INTO shift_forced_closes
    (shift_id, tenant_id, store_id, opening_device_id, closed_from_device_id, closed_by_user_id,
     forced_reason, payload_hash)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

function insertForceClose(client: { query: PoolClient["query"] }, row: ForceClose): Promise<unknown> {
  return client.query(INSERT_FORCE_CLOSE, [
    row.shift_id,
    row.tenant_id,
    row.store_id,
    row.opening_device_id,
    row.closed_from_device_id,
    row.closed_by_user_id,
    row.forced_reason,
    row.payload_hash,
  ]);
}

/** An open cash-up shift on `device` of store A1; returns its id. */
async function seedCashUpShift(device = DEV_A1, store = STORE_A1): Promise<string> {
  const shiftId = randomUUID();
  await pg().admin.query(
    `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at,
                         source, currency_code, opening_float, business_date, received_at, recorded_by_user_id,
                         payload_hash)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', 'cash_up', 'EGP', 500, current_date, now(), $4, $6)`,
    [shiftId, TENANT_A, store, CASHIER, device, HASH],
  );
  return shiftId;
}

/** An open legacy (audit-ingest) shift on `device`; returns its id. */
async function seedLegacyShift(device = DEV_A1, store = STORE_A1): Promise<string> {
  const shiftId = randomUUID();
  await pg().admin.query(
    `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour')`,
    [shiftId, TENANT_A, store, CASHIER, device],
  );
  return shiftId;
}

async function becomeOwner(): Promise<void> {
  superuser = (await pg().admin.query<{ u: string }>(`SELECT current_user AS u`)).rows[0]!.u;
  await pg().admin.query(`CREATE ROLE ${MIGRATION_OWNER} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await pg().admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATION_OWNER}`);
  for (const table of OWNED_TABLES) await pg().admin.query(`ALTER TABLE ${table} OWNER TO ${MIGRATION_OWNER}`);
  for (const fn of OWNED_FUNCTIONS) await pg().admin.query(`ALTER FUNCTION ${fn} OWNER TO ${MIGRATION_OWNER}`);
}

async function restoreOwner(): Promise<void> {
  const statements = [
    ...OWNED_TABLES.map((table) => `ALTER TABLE ${table} OWNER TO ${superuser}`),
    ...OWNED_FUNCTIONS.map((fn) => `ALTER FUNCTION ${fn} OWNER TO ${superuser}`),
    `ALTER TABLE IF EXISTS shift_forced_closes OWNER TO ${superuser}`,
    `ALTER FUNCTION IF EXISTS shift_forced_closes_require_open_shift() OWNER TO ${superuser}`,
    `REVOKE ALL ON SCHEMA public FROM ${MIGRATION_OWNER}`,
    `DROP ROLE ${MIGRATION_OWNER}`,
  ];
  for (const sql of statements) await pg().admin.query(sql).catch(() => undefined);
}

let cashUpShift = "";
let legacyShift = "";
let otherStoreShift = "";

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0070 spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) await env.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt742-a', 'A'), ($2, 'rt742-b', 'B')`, [TENANT_A, TENANT_B]);
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $4, 'A1', 'A1'), ($2, $4, 'A2', 'A2'), ($3, $5, 'B1', 'B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO users (id, email) VALUES ($1, 'c@rt742.example'), ($2, 'm@rt742.example'), ($3, 'mb@rt742.example')`,
    [CASHIER, MANAGER, MANAGER_B],
  );
  const devices: Array<[string, string, string]> = [
    [DEV_A1, TENANT_A, STORE_A1],
    [DEV_A1_SECOND, TENANT_A, STORE_A1],
    [DEV_A2, TENANT_A, STORE_A2],
    [DEV_B1, TENANT_B, STORE_B1],
  ];
  for (const [id, tenant, store] of devices) {
    await a.query(`INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, $5, $4)`, [
      id,
      tenant,
      store,
      createHash("sha256").update(id).digest(),
      `till-${id.slice(-4)}`,
    ]);
  }
  cashUpShift = await seedCashUpShift();
  legacyShift = await seedLegacyShift();
  otherStoreShift = await seedLegacyShift(DEV_A2, STORE_A2);
  await becomeOwner();
  await asOwner(UP_SQL());
  await ensureAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) {
    await restoreOwner();
    await stopPgEnv(env);
  }
}, 60_000);

describe("0070 up (as a non-superuser owner)", () => {
  it("adds both composite FK targets over the existing rows, which all survive", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('uq_shifts_force_close_target', 'uq_devices_tenant_store_target') ORDER BY conname`,
    );
    expect(r.rows.map((row) => row.conname)).toEqual(["uq_devices_tenant_store_target", "uq_shifts_force_close_target"]);
    const shifts = await pg().admin.query(`SELECT lifecycle_state FROM shifts WHERE shift_id = ANY($1::uuid[])`, [
      [cashUpShift, legacyShift, otherStoreShift],
    ]);
    expect(shifts.rows.map((row) => row.lifecycle_state)).toEqual(["open", "open", "open"]);
  });

  it("creates the table with FORCED RLS and SELECT + INSERT policies only", async () => {
    if (skip()) return;
    const rls = await pg().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'shift_forced_closes'`,
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await pg().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = 'shift_forced_closes' ORDER BY cmd`,
    );
    expect(policies.rows.map((row) => row.cmd)).toEqual(["INSERT", "SELECT"]);
  });
});

describe("shift_forced_closes — scope pinning (composite FKs) and CHECKs", () => {
  it.each<[string, () => Partial<ForceClose>, string | null]>([
    ["a cash-up shift of the store, from another terminal of the store", () => ({}), null],
    ["a legacy shift (NULL currency and float)", () => ({ shift_id: legacyShift }), null],
    ["from the opening terminal itself", () => ({ closed_from_device_id: DEV_A1 }), null],
    ["a shift named with another store", () => ({ store_id: STORE_A2 }), "23503"],
    ["a shift named with another opening terminal", () => ({ opening_device_id: DEV_A1_SECOND }), "23503"],
    ["a shift of another store", () => ({ shift_id: otherStoreShift }), "23503"],
    ["a calling terminal of another store", () => ({ closed_from_device_id: DEV_A2 }), "23503"],
    ["a calling terminal of another tenant", () => ({ closed_from_device_id: DEV_B1 }), "23503"],
    ["an empty reason", () => ({ forced_reason: "" }), "23514"],
    ["a 201-character reason", () => ({ forced_reason: "x".repeat(201) }), "23514"],
    ["a short hash", () => ({ payload_hash: Buffer.alloc(31) }), "23514"],
  ])("%s → %s", async (_label, over, code) => {
    if (skip()) return;
    const row = forceCloseOf(cashUpShift, over());
    expect(await asApp(TENANT_A, (c) => errorCode(() => insertForceClose(c, row)))).toBe(code);
  });

  it("another tenant can neither write nor read it (FORCED RLS)", async () => {
    if (skip()) return;
    expect(await asApp(TENANT_B, (c) => errorCode(() => insertForceClose(c, forceCloseOf(cashUpShift))))).toBe("42501");
    const seen = await asApp(TENANT_A, async (c) => {
      await insertForceClose(c, forceCloseOf(cashUpShift));
      await c.query("SELECT set_config('app.current_tenant', $1, true)", [TENANT_B]);
      return (await c.query(`SELECT 1 FROM shift_forced_closes`)).rows.length;
    });
    expect(seen).toBe(0);
  });
});

describe("shift_forced_closes — lifecycle and append-only", () => {
  it("moves a cash-up shift open → closed_forced with its force close", async () => {
    if (skip()) return;
    const state = await asApp(TENANT_A, async (c) => {
      await insertForceClose(c, forceCloseOf(cashUpShift));
      await c.query(`UPDATE shifts SET lifecycle_state = 'closed_forced' WHERE shift_id = $1`, [cashUpShift]);
      return (await c.query(`SELECT lifecycle_state FROM shifts WHERE shift_id = $1`, [cashUpShift])).rows[0];
    });
    expect(state).toEqual({ lifecycle_state: "closed_forced" });
  });

  it("never moves a cash-up shift to closed_forced without a close of either kind (42501)", async () => {
    if (skip()) return;
    const code = await asApp(TENANT_A, (c) =>
      errorCode(() => c.query(`UPDATE shifts SET lifecycle_state = 'closed_forced' WHERE shift_id = $1`, [cashUpShift])),
    );
    expect(code).toBe("42501");
  });

  it("a force close is not a `closed` (normal) close: that move stays refused (42501)", async () => {
    if (skip()) return;
    const code = await asApp(TENANT_A, async (c) => {
      await insertForceClose(c, forceCloseOf(cashUpShift));
      return errorCode(() => c.query(`UPDATE shifts SET lifecycle_state = 'closed' WHERE shift_id = $1`, [cashUpShift]));
    });
    expect(code).toBe("42501");
  });

  it("refuses a second force close and a cash-up close of a force-closed shift (55000)", async () => {
    if (skip()) return;
    const codes = await asApp(TENANT_A, async (c) => {
      await insertForceClose(c, forceCloseOf(cashUpShift));
      await c.query(`UPDATE shifts SET lifecycle_state = 'closed_forced' WHERE shift_id = $1`, [cashUpShift]);
      await c.query("SAVEPOINT again");
      const again = await errorCode(() => insertForceClose(c, forceCloseOf(cashUpShift, { forced_reason: "again" })));
      await c.query("ROLLBACK TO SAVEPOINT again");
      const cashUp = await errorCode(() =>
        c.query(
          `INSERT INTO shift_closes
             (shift_id, tenant_id, store_id, device_id, currency_code, closed_at, closing_user_id, close_kind,
              opening_float, cash_sales_total, cash_refunds_total, pay_in_total, pay_out_total, expected_cash,
              counted_cash, variance, sale_count, recorded_by_user_id, payload_hash)
           VALUES ($1, $2, $3, $4, 'EGP', now(), $5, 'normal', 500, 0, 0, 0, 0, 500, 500, 0, 0, $5, $6)`,
          [cashUpShift, TENANT_A, STORE_A1, DEV_A1, CASHIER, HASH],
        ),
      );
      return [again, cashUp];
    });
    expect(codes).toEqual(["55000", "55000"]);
  });

  it.each([
    ["UPDATE", `UPDATE shift_forced_closes SET forced_reason = 'changed'`],
    ["DELETE", `DELETE FROM shift_forced_closes`],
    ["TRUNCATE", `TRUNCATE shift_forced_closes`],
  ])("%s is refused for every role, the superuser included (42501)", async (_op, sql) => {
    if (skip()) return;
    const client = await pg().admin.connect();
    try {
      await client.query("BEGIN");
      await insertForceClose(client, forceCloseOf(legacyShift));
      expect(await errorCode(() => client.query(sql))).toBe("42501");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("0070 down (as a non-superuser owner, under FORCE RLS)", () => {
  it("refuses while a force close is recorded, and changes nothing", async () => {
    if (skip()) return;
    await insertForceClose(pg().admin, forceCloseOf(legacyShift));
    await pg().admin.query(`UPDATE shifts SET lifecycle_state = 'closed_forced' WHERE shift_id = $1`, [legacyShift]);
    await expect(asOwner(DOWN_SQL())).rejects.toThrow(/0070 down refused: 1 force close/);
    const r = await pg().admin.query(`SELECT count(*)::int AS n FROM shift_forced_closes`);
    expect(r.rows[0]).toEqual({ n: 1 });
  });

  it("rolls back once the force closes are removed explicitly, and round-trips with up", async () => {
    if (skip()) return;
    const client = await pg().admin.connect();
    try {
      // Break-glass, as an operator would: the table is append-only.
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("DELETE FROM shift_forced_closes");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await asOwner(DOWN_SQL());
    const gone = await pg().admin.query(
      `SELECT (SELECT count(*)::int FROM pg_class WHERE relname = 'shift_forced_closes') AS tables,
              (SELECT count(*)::int FROM pg_constraint
                WHERE conname IN ('uq_shifts_force_close_target', 'uq_devices_tenant_store_target')) AS targets`,
    );
    expect(gone.rows[0]).toEqual({ tables: 0, targets: 0 });
    // The 0050 guard is back: a closed_forced move needs a forced shift_closes row again.
    const code = await errorCode(() =>
      pg().admin.query(`UPDATE shifts SET lifecycle_state = 'closed_forced' WHERE shift_id = $1`, [cashUpShift]),
    );
    expect(code).toBe("42501");
    await asOwner(UP_SQL());
    await ensureAppRole(pg());
    expect(await asApp(TENANT_A, (c) => errorCode(() => insertForceClose(c, forceCloseOf(cashUpShift))))).toBeNull();
  });
});
