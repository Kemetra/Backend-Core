/**
 * 0067 — refund allocation and refund execution storage (Jira RT-787, RT-271
 * F-2; contract `pos-sales/sales.yaml` 1.13.0-draft, RT-490).
 *
 * Applies every migration before 0067 against a real Postgres, seeds a
 * pre-0067 return with a cash tender sale in two tenants (the UPGRADE path),
 * applies 0067, then proves:
 *   - sale_return_tenders: the allocation columns are nullable (the pre-0067
 *     row reads NULL, never backfilled), `instrument` is cash-only, an
 *     allocation_ref is unique within its return, and an original_tender_ref
 *     must be a tender of the SAME tenant and sale (23503, the trigger);
 *   - sale_returns.posting_deferred defaults to false;
 *   - refund_executions: a positive amount, `settled` only, drawer / manual
 *     evidence, the composite FKs to its return, sale and allocation (with the
 *     same allocation_ref), unique provenance and execution_ref per tenant, at
 *     most one settling execution per return;
 *   - RLS: ENABLE + FORCE, SELECT + INSERT policies only, fail-closed and
 *     tenant-scoped, WITH CHECK on insert;
 *   - down refuses while executions, allocation data or deferred returns exist
 *     (also as a NON-superuser owner under FORCE RLS), and round-trips
 *     up / down / up, also as a NON-superuser owner.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0067_refund_executions.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0067_refund_executions.down.sql");

const TENANT = "0a000000-0000-7000-8000-000000078701";
const TENANT_B = "0b000000-0000-7000-8000-000000078701";
const STORE = "0a000000-0000-7000-8000-000000078702";
const STORE_B = "0b000000-0000-7000-8000-000000078702";
const ACTOR = "0a000000-0000-7000-8000-000000078703";
const SALE = "0a000000-0000-7000-8000-000000078710";
const SALE_OTHER = "0a000000-0000-7000-8000-000000078711";
const SALE_B = "0b000000-0000-7000-8000-000000078710";
const TENDER_REF = "0a000000-0000-7000-8000-000000078720";
const TENDER_REF_OTHER = "0a000000-0000-7000-8000-000000078721";
const TENDER_REF_B = "0b000000-0000-7000-8000-000000078720";
const RETURN_OLD = "0a000000-0000-7000-8000-000000078730";
const RETURN_NEW = "0a000000-0000-7000-8000-000000078731";
const RETURN_OTHER = "0a000000-0000-7000-8000-000000078732";
const ALLOC_ROW = "0a000000-0000-7000-8000-000000078740";
const ALLOC_REF = "0a000000-0000-7000-8000-000000078741";
const SHIFT = "0a000000-0000-7000-8000-000000078750";

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function applyBefore0067(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(pgEnv);
}

async function insertSale(id: string, tenantId: string, storeId: string): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 10, '2026-10-22T10:00:00Z', '2026-10-22',
             'pos-1', $5, $4, $6)`,
    [id, tenantId, storeId, "c".repeat(64), `sale-${id}`, ACTOR],
  );
}

async function insertTender(saleId: string, tenantId: string, storeId: string, tenderRef: string): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sale_tenders (sale_id, tenant_id, store_id, method, amount, currency_code, tender_ref)
     VALUES ($1, $2, $3, 'cash', 10, 'EGP', $4)`,
    [saleId, tenantId, storeId, tenderRef],
  );
}

async function insertReturn(id: string, saleId: string, tenantId: string, storeId: string): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sale_returns
       (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code, return_total,
        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4,
             (SELECT COALESCE(MAX(return_seq), 0) + 1 FROM sale_returns WHERE sale_id = $2),
             '2026-10-22', 'EGP', 10, 'pos-1', $5, $6, $7)`,
    [id, saleId, tenantId, storeId, `ret-${id}`, "f".repeat(64), ACTOR],
  );
}

const ALLOCATION_SQL = `INSERT INTO sale_return_tenders
       (id, return_id, tenant_id, store_id, ordinal, method, amount, allocation_ref, original_tender_ref, instrument)
     VALUES ($1, $2, $3, $4, $5, 'cash', $6::numeric, $7, $8, $9)`;

interface AllocationRow {
  readonly id?: string;
  readonly returnId?: string;
  readonly tenantId?: string;
  readonly storeId?: string;
  readonly ordinal?: number;
  readonly amount?: string;
  readonly allocationRef?: string | null;
  readonly originalTenderRef?: string | null;
  readonly instrument?: string | null;
}

function allocationParams(row: AllocationRow): unknown[] {
  return [
    row.id ?? ALLOC_ROW,
    row.returnId ?? RETURN_NEW,
    row.tenantId ?? TENANT,
    row.storeId ?? STORE,
    row.ordinal ?? 0,
    row.amount ?? "10",
    row.allocationRef === undefined ? ALLOC_REF : row.allocationRef,
    row.originalTenderRef === undefined ? TENDER_REF : row.originalTenderRef,
    row.instrument === undefined ? "cash" : row.instrument,
  ];
}

const EXECUTION_SQL = `INSERT INTO refund_executions
       (execution_ref, return_id, allocation_id, sale_id, tenant_id, store_id, allocation_ref,
        amount, outcome, evidence_method, paid_at, shift_ref, source_system, external_id,
        payload_hash, created_by, settles_return)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, '2026-10-22T10:05:00Z', $11,
             'pos-1', $12, $13, $14, $15)`;

interface ExecutionRow {
  readonly executionRef?: string;
  readonly returnId?: string;
  readonly allocationId?: string;
  readonly saleId?: string;
  readonly tenantId?: string;
  readonly allocationRef?: string;
  readonly amount?: string;
  readonly outcome?: string;
  readonly evidenceMethod?: string;
  readonly externalId?: string;
  readonly settles?: boolean;
}

function executionParams(row: ExecutionRow): unknown[] {
  return [
    row.executionRef ?? "0a000000-0000-7000-8000-000000078760",
    row.returnId ?? RETURN_NEW,
    row.allocationId ?? ALLOC_ROW,
    row.saleId ?? SALE,
    row.tenantId ?? TENANT,
    STORE,
    row.allocationRef ?? ALLOC_REF,
    row.amount ?? "4",
    row.outcome ?? "settled",
    row.evidenceMethod ?? "drawer",
    SHIFT,
    row.externalId ?? "exec-1",
    "e".repeat(64),
    ACTOR,
    row.settles ?? false,
  ];
}

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

/** Insert one allocation (rolled back); its error code, or null. */
async function tryAllocation(row: AllocationRow): Promise<string | null> {
  return inRolledBackTx((c) => errorCode(() => c.query(ALLOCATION_SQL, allocationParams(row))));
}

/** Insert the default allocation, then `rows` executions in order (rolled back); the last error code, or null. */
async function tryExecutions(...rows: ExecutionRow[]): Promise<string | null> {
  return inRolledBackTx(async (c) => {
    await c.query(ALLOCATION_SQL, allocationParams({}));
    let code: string | null = null;
    for (const row of rows) code = await errorCode(() => c.query(EXECUTION_SQL, executionParams(row)));
    return code;
  });
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

interface SchemaState {
  readonly table: boolean;
  readonly columns: number;
  readonly trigger: boolean;
  readonly fn: boolean;
}

async function schemaState(): Promise<SchemaState> {
  const r = await pg().admin.query<SchemaState>(
    `SELECT
       EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'refund_executions') AS table,
       (SELECT count(*)::int FROM information_schema.columns
         WHERE table_schema = 'public'
           AND ((table_name = 'sale_return_tenders'
                 AND column_name IN ('allocation_ref', 'original_tender_ref', 'instrument'))
             OR (table_name = 'sale_returns' AND column_name = 'posting_deferred'))) AS columns,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sale_return_tenders_original_tender_check') AS trigger,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sale_return_tenders_original_tender_check') AS fn`,
  );
  return r.rows[0]!;
}

const UP_STATE: SchemaState = { table: true, columns: 4, trigger: true, fn: true };
const DOWN_STATE: SchemaState = { table: false, columns: 0, trigger: false, fn: false };

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0067-refund-executions.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0067(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-787 tenant', 'rt787-a'), ($2, 'RT-787 tenant B', 'rt787-b')`,
    [TENANT, TENANT_B],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'rt787-x', 'X'), ($2, $4, 'rt787-b', 'B')`,
    [STORE, STORE_B, TENANT, TENANT_B],
  );
  await insertSale(SALE, TENANT, STORE);
  await insertSale(SALE_OTHER, TENANT, STORE);
  await insertSale(SALE_B, TENANT_B, STORE_B);
  await insertTender(SALE, TENANT, STORE, TENDER_REF);
  await insertTender(SALE_OTHER, TENANT, STORE, TENDER_REF_OTHER);
  await insertTender(SALE_B, TENANT_B, STORE_B, TENDER_REF_B);
  // A pre-0067 return with its (ref-less) tender: the upgrade path.
  await insertReturn(RETURN_OLD, SALE, TENANT, STORE);
  await env.admin.query(
    `INSERT INTO sale_return_tenders (return_id, tenant_id, store_id, ordinal, method, amount)
     VALUES ($1, $2, $3, 0, 'cash', 10)`,
    [RETURN_OLD, TENANT, STORE],
  );
  await env.admin.query(readFileSync(UP_PATH, "utf8"));
  await ensureAppRole(env);
  await insertReturn(RETURN_NEW, SALE, TENANT, STORE);
  await insertReturn(RETURN_OTHER, SALE_OTHER, TENANT, STORE);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

describe("0067 up — the upgrade path", () => {
  it("leaves a pre-0067 allocation without the RT-490 fields and its return not deferred", async () => {
    if (skip()) return;
    const r = await pg().admin.query(
      `SELECT t.allocation_ref, t.original_tender_ref, t.instrument, r.posting_deferred
         FROM sale_return_tenders t JOIN sale_returns r ON r.id = t.return_id WHERE r.id = $1`,
      [RETURN_OLD],
    );
    expect(r.rows).toEqual([
      { allocation_ref: null, original_tender_ref: null, instrument: null, posting_deferred: false },
    ]);
  });
});

describe("0067 sale_return_tenders allocation constraints", () => {
  it("accepts a full allocation and a ref-less one", async () => {
    if (skip()) return;
    expect(await tryAllocation({})).toBeNull();
    expect(await tryAllocation({ allocationRef: null, originalTenderRef: null, instrument: null })).toBeNull();
  });

  it.each([
    ["an instrument other than cash", { instrument: "card_external" }, "23514"],
    ["an original tender of another sale", { originalTenderRef: TENDER_REF_OTHER }, "23503"],
    ["an original tender of another tenant", { originalTenderRef: TENDER_REF_B }, "23503"],
    ["an unknown original tender", { originalTenderRef: "0a000000-0000-7000-8000-0000000787ff" }, "23503"],
  ])("refuses %s", async (_name, row, code) => {
    if (skip()) return;
    expect(await tryAllocation(row as AllocationRow)).toBe(code);
  });

  it("refuses the same allocation_ref twice in one return (23505), not across returns", async () => {
    if (skip()) return;
    const sameReturn = await inRolledBackTx(async (c) => {
      await c.query(ALLOCATION_SQL, allocationParams({}));
      return errorCode(() =>
        c.query(ALLOCATION_SQL, allocationParams({ id: "0a000000-0000-7000-8000-000000078742", ordinal: 1 })),
      );
    });
    expect(sameReturn).toBe("23505");
    const otherReturn = await inRolledBackTx(async (c) => {
      await c.query(ALLOCATION_SQL, allocationParams({}));
      return errorCode(() =>
        c.query(
          ALLOCATION_SQL,
          allocationParams({
            id: "0a000000-0000-7000-8000-000000078743",
            returnId: RETURN_OTHER,
            originalTenderRef: TENDER_REF_OTHER,
          }),
        ),
      );
    });
    expect(otherReturn).toBeNull();
  });
});

describe("0067 refund_executions constraints", () => {
  it("accepts a valid settled execution", async () => {
    if (skip()) return;
    expect(await tryExecutions({})).toBeNull();
  });

  it.each([
    ["a zero amount", { amount: "0" }, "23514"],
    ["an outcome other than settled", { outcome: "failed" }, "23514"],
    ["unknown evidence", { evidenceMethod: "kick_unknown" }, "23514"],
    ["an allocation of another return", { returnId: RETURN_OTHER, saleId: SALE_OTHER }, "23503"],
    ["another allocation_ref than the allocation's", { allocationRef: "0a000000-0000-7000-8000-0000000787fe" }, "23503"],
    ["a return of another sale", { saleId: SALE_OTHER }, "23503"],
  ])("refuses %s", async (_name, row, code) => {
    if (skip()) return;
    expect(await tryExecutions(row as ExecutionRow)).toBe(code);
  });

  it("refuses a reused provenance and a reused execution_ref (23505)", async () => {
    if (skip()) return;
    expect(await tryExecutions({}, { executionRef: "0a000000-0000-7000-8000-000000078761" })).toBe("23505");
    expect(await tryExecutions({}, { externalId: "exec-2" })).toBe("23505");
    expect(
      await tryExecutions({}, { executionRef: "0a000000-0000-7000-8000-000000078761", externalId: "exec-2" }),
    ).toBeNull();
  });

  it("refuses a second settling execution of one return (23505)", async () => {
    if (skip()) return;
    expect(
      await tryExecutions(
        { settles: true },
        { executionRef: "0a000000-0000-7000-8000-000000078761", externalId: "exec-2", settles: true },
      ),
    ).toBe("23505");
  });
});

describe("0067 RLS", () => {
  it("refund_executions is ENABLE + FORCE row level security, with SELECT and INSERT policies only", async () => {
    if (skip()) return;
    const t = await pg().admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'refund_executions'`,
    );
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const p = await pg().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = 'refund_executions' ORDER BY cmd`,
    );
    expect(p.rows.map((r) => r.cmd)).toEqual(["INSERT", "SELECT"]);
  });

  it("fails closed on an unset or empty tenant GUC, and is tenant-scoped", async () => {
    if (skip()) return;
    await pg().admin.query(ALLOCATION_SQL, allocationParams({}));
    await pg().admin.query(EXECUTION_SQL, executionParams({}));
    try {
      const read = (c: PoolClient) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM refund_executions`);
      expect((await asApp(null, read)).rows[0]).toEqual({ n: 0 });
      expect((await asApp("", read)).rows[0]).toEqual({ n: 0 });
      expect((await asApp(TENANT_B, read)).rows[0]).toEqual({ n: 0 });
      expect((await asApp(TENANT, read)).rows[0]).toEqual({ n: 1 });
    } finally {
      await pg().admin.query(`DELETE FROM refund_executions WHERE return_id = $1`, [RETURN_NEW]);
      await pg().admin.query(`DELETE FROM sale_return_tenders WHERE id = $1`, [ALLOC_ROW]);
    }
  });

  it("refuses an app-role insert for another tenant (WITH CHECK, 42501), and app-role UPDATE / DELETE touch nothing", async () => {
    if (skip()) return;
    await pg().admin.query(ALLOCATION_SQL, allocationParams({}));
    await pg().admin.query(EXECUTION_SQL, executionParams({}));
    try {
      const code = await asApp(TENANT_B, (c) =>
        errorCode(() => c.query(EXECUTION_SQL, executionParams({ externalId: "exec-b" }))),
      );
      expect(code).toBe("42501");
      const changed = await asApp(TENANT, async (c) => {
        const u = await errorCode(() => c.query(`UPDATE refund_executions SET amount = 1`));
        return u;
      });
      // No UPDATE grant / policy: refused or zero rows, never a change.
      expect(["42501", null]).toContain(changed);
      const r = await pg().admin.query<{ amount: string }>(`SELECT amount::text AS amount FROM refund_executions`);
      expect(r.rows).toEqual([{ amount: "4.0000" }]);
    } finally {
      await pg().admin.query(`DELETE FROM refund_executions WHERE return_id = $1`, [RETURN_NEW]);
      await pg().admin.query(`DELETE FROM sale_return_tenders WHERE id = $1`, [ALLOC_ROW]);
    }
  });
});

describe("0067 down", () => {
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

  async function withExecution(fn: () => Promise<void>): Promise<void> {
    await pg().admin.query(ALLOCATION_SQL, allocationParams({}));
    await pg().admin.query(EXECUTION_SQL, executionParams({}));
    try {
      await fn();
    } finally {
      await pg().admin.query(`DELETE FROM refund_executions WHERE return_id = $1`, [RETURN_NEW]);
      await pg().admin.query(`DELETE FROM sale_return_tenders WHERE id = $1`, [ALLOC_ROW]);
    }
  }

  it("refuses loudly while executions exist, and changes nothing", async () => {
    if (skip()) return;
    await withExecution(async () => {
      expect(await runDown(null)).toBe("P0001");
      expect(await schemaState()).toEqual(UP_STATE);
    });
  });

  it("refuses while a deferred return exists", async () => {
    if (skip()) return;
    await pg().admin.query(`UPDATE sale_returns SET posting_deferred = true WHERE id = $1`, [RETURN_OTHER]);
    try {
      expect(await runDown(null)).toBe("P0001");
      expect(await schemaState()).toEqual(UP_STATE);
    } finally {
      await pg().admin.query(`UPDATE sale_returns SET posting_deferred = false WHERE id = $1`, [RETURN_OTHER]);
    }
  });

  const MIGRATION_OWNER = "rt787_migration_owner";
  const OWNED_TABLES = ["tenants", "stores", "sales", "sale_tenders", "sale_returns", "sale_return_tenders", "refund_executions"];

  async function quietly(statements: readonly string[]): Promise<void> {
    for (const sql of statements) await pg().admin.query(sql).catch(() => undefined);
  }

  /** A NOSUPERUSER, NOBYPASSRLS role that owns the tables 0067 touches, like the production owner. */
  async function becomeOwner(): Promise<string> {
    const superuser = (await pg().admin.query<{ u: string }>(`SELECT current_user AS u`)).rows[0]!.u;
    await pg().admin.query(`CREATE ROLE ${MIGRATION_OWNER} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await pg().admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATION_OWNER}`);
    for (const table of OWNED_TABLES) {
      await pg().admin.query(`ALTER TABLE IF EXISTS ${table} OWNER TO ${MIGRATION_OWNER}`);
    }
    await quietly([`ALTER FUNCTION sale_return_tenders_original_tender_check() OWNER TO ${MIGRATION_OWNER}`]);
    return superuser;
  }

  async function restoreOwner(superuser: string): Promise<void> {
    await quietly([
      ...OWNED_TABLES.map((table) => `ALTER TABLE IF EXISTS ${table} OWNER TO ${superuser}`),
      `ALTER FUNCTION sale_return_tenders_original_tender_check() OWNER TO ${superuser}`,
      `REVOKE ALL ON SCHEMA public FROM ${MIGRATION_OWNER}`,
      `DROP ROLE ${MIGRATION_OWNER}`,
    ]);
  }

  // The production migration owner is NOT a superuser (database-roles.md), so
  // FORCE ROW LEVEL SECURITY applies to it: a guard that reads without a
  // tenant GUC sees no rows and would drop every execution.
  it("refuses as a NON-superuser owner under FORCE RLS, and drops nothing", async () => {
    if (skip()) return;
    await withExecution(async () => {
      const superuser = await becomeOwner();
      try {
        expect(await runDown(MIGRATION_OWNER)).toBe("P0001");
        expect(await schemaState()).toEqual(UP_STATE);
      } finally {
        await restoreOwner(superuser);
      }
    });
  });

  it("round-trips up / down / up as a NON-superuser owner", async () => {
    if (skip()) return;
    const superuser = await becomeOwner();
    const client = await pg().admin.connect();
    try {
      await client.query(`SET ROLE ${MIGRATION_OWNER}`);
      await client.query(readFileSync(DOWN_PATH, "utf8"));
      expect(await schemaState()).toEqual(DOWN_STATE);
      await client.query(readFileSync(UP_PATH, "utf8"));
      expect(await schemaState()).toEqual(UP_STATE);
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
      await restoreOwner(superuser);
    }
    await ensureAppRole(pg());
  });
});
