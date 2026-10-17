/**
 * 0054 — credit-sale reversals (Jira RT-577; contract `pos-sales/sales.yaml`
 * 1.11.0-draft, owner-approved V1 decision and rulings D6 / D7 / D8,
 * 2026-10-17).
 *
 * Applies every migration before 0054 against a real Postgres, seeds approved
 * voids in two tenants (the UPGRADE path), applies 0054, then proves:
 *   - sale_approval_uses is backfilled from every tenant's approved voids, and
 *     the sale_voids trigger keeps it filled for every later approved void, so
 *     an approval id is single-use across recordVoid and the credit reversals;
 *   - sale_credit_reversals: one reversal per void / return row, kind matches
 *     its link, refundable + adjustment = total (all >= 0), an adjustment ref
 *     iff an adjustment, the second approval only on a return and all or none,
 *     a non-blank reason, unique provenance;
 *   - sale_credit_reversal_tenders: cash or card_external, a reference only on
 *     a card, non-negative, unique ordinal;
 *   - RLS: ENABLE + FORCE on all three tables, SELECT + INSERT policies only,
 *     fail-closed and tenant-scoped;
 *   - down refuses while credit reversals exist (also as a NON-superuser owner
 *     under FORCE RLS) and round-trips with up; up backfills under FORCE RLS
 *     as a NON-superuser owner.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0054_sale_credit_reversals.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0054_sale_credit_reversals.down.sql");

const TENANT = "0a000000-0000-7000-8000-000000057701";
const TENANT_B = "0b000000-0000-7000-8000-000000057701";
const STORE = "0a000000-0000-7000-8000-000000057702";
const STORE_B = "0b000000-0000-7000-8000-000000057702";
const ACTOR = "0a000000-0000-7000-8000-000000057703";
const APPROVER = "0a000000-0000-7000-8000-000000057704";
const PAYER = "0a000000-0000-7000-8000-000000057705";
const SALE_VOIDED = "0a000000-0000-7000-8000-000000057710";
const SALE_PLAIN_VOID = "0a000000-0000-7000-8000-000000057711";
const SALE_RETURNED = "0a000000-0000-7000-8000-000000057712";
const SALE_FRESH = "0a000000-0000-7000-8000-000000057713";
const SALE_B = "0b000000-0000-7000-8000-000000057710";
const VOID_A = "0a000000-0000-7000-8000-000000057720";
const VOID_PLAIN = "0a000000-0000-7000-8000-000000057721";
const VOID_B = "0b000000-0000-7000-8000-000000057720";
const RETURN_A = "0a000000-0000-7000-8000-000000057730";
const APPROVAL_A = "0a000000-0000-7000-8000-0000000577a1";
const APPROVAL_B = "0b000000-0000-7000-8000-0000000577b1";
const APPROVAL_NEW = "0a000000-0000-7000-8000-0000000577a2";
const APPROVAL_CREDIT = "0a000000-0000-7000-8000-0000000577a3";

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function applyBefore0054(pgEnv: PgTestEnv): Promise<void> {
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
     VALUES ($1, $2, $3, 'EGP', 10, '2026-10-17T10:00:00Z', '2026-10-17',
             'pos-1', $6, $4, $5)`,
    [id, tenantId, storeId, "c".repeat(64), ACTOR, `sale-${id}`],
  );
}

/** A void row; `approvalId` null records a pre-RT-530 (unapproved) void. */
async function insertVoid(
  q: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  v: { id: string; saleId: string; tenantId: string; storeId: string; approvalId: string | null },
): Promise<void> {
  const approved = v.approvalId !== null;
  await q.query(
    `INSERT INTO sale_voids
       (id, sale_id, tenant_id, store_id, business_date, source_system, external_id,
        payload_hash, created_by, approval_id, approved_by_user_id, requested_by_user_id,
        approval_policy_version, approved_at, void_business_date)
     VALUES ($1, $2, $3, $4, '2026-10-17', 'pos-1', $13, $5, $6,
             $7, $8, $9, $10, $11, $12)`,
    [
      v.id,
      v.saleId,
      v.tenantId,
      v.storeId,
      "d".repeat(64),
      ACTOR,
      v.approvalId,
      approved ? APPROVER : null,
      approved ? ACTOR : null,
      approved ? "v1" : null,
      approved ? "2026-10-17T10:00:00Z" : null,
      approved ? "2026-10-17" : null,
      `void-${v.id}`,
    ],
  );
}

interface ReversalRow {
  readonly kind?: string;
  readonly voidId?: string | null;
  readonly returnId?: string | null;
  readonly saleId?: string;
  readonly externalId?: string;
  readonly total?: string;
  readonly refundable?: string;
  readonly adjustment?: string;
  readonly adjustmentRef?: string | null;
  readonly reason?: string;
  readonly approvalId?: string | null;
  readonly approverId?: string | null;
}

const REVERSAL_SQL = `INSERT INTO sale_credit_reversals
       (id, tenant_id, store_id, sale_id, kind, void_id, return_id, source_system, external_id,
        payload_hash, business_date, currency_code, reversal_total, refundable_amount,
        adjustment_amount, payer_id, adjustment_ref, actor_user_id, actor_role, reason,
        approval_id, approved_by_user_id, requested_by_user_id, approval_policy_version, approved_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'pos-1', $7, $8, '2026-10-17', 'EGP',
             $9::numeric, $10::numeric, $11::numeric, $12, $13, $14, 'store_manager', $15,
             $16, $17, $18, $19, $20)`;

const REVERSAL_DEFAULTS = {
  kind: "void",
  voidId: VOID_A as string | null,
  returnId: null as string | null,
  saleId: SALE_VOIDED,
  externalId: "credit-1",
  total: "10",
  refundable: "4",
  adjustment: "6",
  adjustmentRef: "0a000000-0000-7000-8000-0000000577f1" as string | null,
  reason: "customer returned the goods",
  approvalId: null as string | null,
};

/** The five approval columns: all set for an approval id, else all NULL (unless overridden). */
function approvalParams(approvalId: string | null, approverId: string | null | undefined): unknown[] {
  if (approvalId === null) return [null, approverId ?? null, null, null, null];
  return [approvalId, approverId === undefined ? APPROVER : approverId, ACTOR, "v1", "2026-10-17T10:00:00Z"];
}

function reversalParams(row: ReversalRow): unknown[] {
  const r = { ...REVERSAL_DEFAULTS, ...row };
  return [
    TENANT, STORE, r.saleId, r.kind, r.voidId, r.returnId, r.externalId, "e".repeat(64),
    r.total, r.refundable, r.adjustment, PAYER, r.adjustmentRef, ACTOR, r.reason,
    ...approvalParams(r.approvalId, row.approverId),
  ];
}

const RETURN_REVERSAL: ReversalRow = {
  kind: "return",
  voidId: null,
  returnId: RETURN_A,
  saleId: SALE_RETURNED,
  externalId: "credit-return-1",
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

/** Insert one reversal as the superuser; the Postgres error code, or null (then rolled back). */
async function tryReversal(row: ReversalRow): Promise<string | null> {
  return inRolledBackTx((c) => errorCode(() => c.query(REVERSAL_SQL, reversalParams(row))));
}

const TENDER_SQL = `INSERT INTO sale_credit_reversal_tenders
       (reversal_id, tenant_id, store_id, ordinal, method, amount, tender_ref, reference)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8)`;

/** Insert a reversal then one tender row; the tender's error code, or null (then rolled back). */
async function tryTender(t: { ordinal?: number; method?: string; amount?: string; reference?: string | null }): Promise<string | null> {
  return inRolledBackTx(async (c) => {
    const r = await c.query<{ id: string }>(`${REVERSAL_SQL} RETURNING id`, reversalParams({}));
    return errorCode(() =>
      c.query(TENDER_SQL, [r.rows[0]!.id, TENANT, STORE, t.ordinal ?? 0, t.method ?? "cash", t.amount ?? "4", null, t.reference ?? null]),
    );
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

const TABLES = ["sale_credit_reversals", "sale_credit_reversal_tenders", "sale_approval_uses"] as const;

interface SchemaState {
  readonly tables: number;
  readonly trigger: boolean;
  readonly fn: boolean;
}

async function schemaState(): Promise<SchemaState> {
  const r = await pg().admin.query<SchemaState>(
    `SELECT
       (SELECT count(*)::int FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1::text[])) AS tables,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sale_voids_record_approval_use') AS trigger,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sale_voids_record_approval_use') AS fn`,
    [TABLES],
  );
  return r.rows[0]!;
}

const UP_STATE: SchemaState = { tables: 3, trigger: true, fn: true };
const DOWN_STATE: SchemaState = { tables: 0, trigger: false, fn: false };

async function approvalUses(): Promise<Array<{ tenant_id: string; approval_id: string; source: string }>> {
  const r = await pg().admin.query<{ tenant_id: string; approval_id: string; source: string }>(
    `SELECT tenant_id::text, approval_id::text, source FROM sale_approval_uses ORDER BY tenant_id, approval_id`,
  );
  return r.rows;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0054-sale-credit-reversals.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0054(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-577 tenant', 'rt577-a'), ($2, 'RT-577 tenant B', 'rt577-b')`,
    [TENANT, TENANT_B],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'rt577-x', 'X'), ($2, $4, 'rt577-b', 'B')`,
    [STORE, STORE_B, TENANT, TENANT_B],
  );
  await env.admin.query(
    `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref)
     VALUES ($1, $2, NULL, 'credit_customer', 'House', 'CUST-1')`,
    [PAYER, TENANT],
  );
  for (const [id, tenantId, storeId] of [
    [SALE_VOIDED, TENANT, STORE],
    [SALE_PLAIN_VOID, TENANT, STORE],
    [SALE_RETURNED, TENANT, STORE],
    [SALE_FRESH, TENANT, STORE],
    [SALE_B, TENANT_B, STORE_B],
  ] as const) {
    await insertSale(id, tenantId, storeId);
  }
  // Pre-0054 voids: two approved (one per tenant) and one unapproved.
  await insertVoid(env.admin, { id: VOID_A, saleId: SALE_VOIDED, tenantId: TENANT, storeId: STORE, approvalId: APPROVAL_A });
  await insertVoid(env.admin, { id: VOID_B, saleId: SALE_B, tenantId: TENANT_B, storeId: STORE_B, approvalId: APPROVAL_B });
  await insertVoid(env.admin, { id: VOID_PLAIN, saleId: SALE_PLAIN_VOID, tenantId: TENANT, storeId: STORE, approvalId: null });
  await env.admin.query(
    `INSERT INTO sale_returns
       (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code, return_total,
        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4, 1, '2026-10-17', 'EGP', 10, 'pos-1', 'ret-1', $5, $6)`,
    [RETURN_A, SALE_RETURNED, TENANT, STORE, "f".repeat(64), ACTOR],
  );
  await env.admin.query(readFileSync(UP_PATH, "utf8"));
  // The app role's grants cover the tables that existed when they ran.
  await ensureAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

describe("0054 up — the shared approval-use ledger", () => {
  it("backfills every tenant's approved voids, and no unapproved one", async () => {
    if (skip()) return;
    expect(await approvalUses()).toEqual([
      { tenant_id: TENANT, approval_id: APPROVAL_A, source: "void" },
      { tenant_id: TENANT_B, approval_id: APPROVAL_B, source: "void" },
    ]);
  });

  it("records every later approved void through the trigger, on the app role under its tenant", async () => {
    if (skip()) return;
    const rows = await asApp(TENANT, async (c) => {
      await insertVoid(c, { id: "0a000000-0000-7000-8000-000000057722", saleId: SALE_FRESH, tenantId: TENANT, storeId: STORE, approvalId: APPROVAL_NEW });
      const r = await c.query(`SELECT source FROM sale_approval_uses WHERE approval_id = $1`, [APPROVAL_NEW]);
      return r.rows;
    });
    expect(rows).toEqual([{ source: "void" }]);
  });

  it("refuses a void whose approval id a credit return already used (23505 on the shared key)", async () => {
    if (skip()) return;
    const err = await asApp(TENANT, async (c) => {
      await c.query(`INSERT INTO sale_approval_uses (tenant_id, approval_id, source) VALUES ($1, $2, 'credit_return')`, [TENANT, APPROVAL_CREDIT]);
      try {
        await insertVoid(c, { id: "0a000000-0000-7000-8000-000000057723", saleId: SALE_FRESH, tenantId: TENANT, storeId: STORE, approvalId: APPROVAL_CREDIT });
        return null;
      } catch (e) {
        return { code: (e as { code?: string }).code, constraint: (e as { constraint?: string }).constraint };
      }
    });
    expect(err).toEqual({ code: "23505", constraint: "sale_approval_uses_pkey" });
  });

  it("writes no ledger row for an unapproved void", async () => {
    if (skip()) return;
    const n = await asApp(TENANT, async (c) => {
      await insertVoid(c, { id: "0a000000-0000-7000-8000-000000057724", saleId: SALE_FRESH, tenantId: TENANT, storeId: STORE, approvalId: null });
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM sale_approval_uses`);
      return r.rows[0]!.n;
    });
    expect(n).toBe(1); // the backfilled APPROVAL_A only (tenant B is invisible under tenant A)
  });

  it("accepts only `void` or `credit_return` as the source", async () => {
    if (skip()) return;
    const code = await inRolledBackTx((c) =>
      errorCode(() =>
        c.query(`INSERT INTO sale_approval_uses (tenant_id, approval_id, source) VALUES ($1, gen_random_uuid(), 'refund')`, [TENANT]),
      ),
    );
    expect(code).toBe("23514");
  });
});

describe("0054 sale_credit_reversals constraints", () => {
  it("accepts a valid credit void and a valid credit return with a second approval", async () => {
    if (skip()) return;
    expect(await tryReversal({})).toBeNull();
    expect(await tryReversal({ ...RETURN_REVERSAL, approvalId: APPROVAL_NEW })).toBeNull();
  });

  it("accepts a full-credit reversal: no refund, the whole total as an adjustment", async () => {
    if (skip()) return;
    expect(await tryReversal({ refundable: "0", adjustment: "10" })).toBeNull();
  });

  it("accepts a fully collected reversal: no adjustment and no adjustment ref", async () => {
    if (skip()) return;
    expect(await tryReversal({ refundable: "10", adjustment: "0", adjustmentRef: null })).toBeNull();
  });

  it.each([
    ["an unknown kind", { kind: "refund" }, "23514"],
    ["a void linked to a return", { returnId: RETURN_A }, "23514"],
    ["a void with no void row", { voidId: null }, "23514"],
    ["a return linked to a void", { ...RETURN_REVERSAL, voidId: VOID_A }, "23514"],
    ["refundable + adjustment != total", { refundable: "5" }, "23514"],
    ["a negative refundable", { refundable: "-1", adjustment: "11" }, "23514"],
    ["an adjustment without a ref", { adjustmentRef: null }, "23514"],
    ["a ref without an adjustment", { refundable: "10", adjustment: "0" }, "23514"],
    ["a second approval on a void", { approvalId: APPROVAL_NEW }, "23514"],
    ["a partial approval", { ...RETURN_REVERSAL, approvalId: APPROVAL_NEW, approverId: null }, "23514"],
    ["a blank reason", { reason: " \t " }, "23514"],
    ["a void of another sale", { saleId: SALE_FRESH }, "23503"],
  ])("refuses %s", async (_name, row, code) => {
    if (skip()) return;
    expect(await tryReversal(row as ReversalRow)).toBe(code);
  });

  it("refuses a second credit reversal of the same void row, and a reused provenance (23505)", async () => {
    if (skip()) return;
    const sameVoid = await inRolledBackTx(async (c) => {
      await c.query(REVERSAL_SQL, reversalParams({}));
      return errorCode(() => c.query(REVERSAL_SQL, reversalParams({ externalId: "credit-2" })));
    });
    expect(sameVoid).toBe("23505");
    const dupProvenance = await inRolledBackTx(async (c) => {
      await c.query(REVERSAL_SQL, reversalParams({}));
      return errorCode(() => c.query(REVERSAL_SQL, reversalParams({ ...RETURN_REVERSAL, externalId: "credit-1" })));
    });
    expect(dupProvenance).toBe("23505");
  });
});

describe("0054 indexes", () => {
  it("indexes the payer FK's referencing side (tenant_id, payer_id)", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_sale_credit_reversals_tenant_payer'`,
    );
    expect(r.rows.map((x) => x.indexdef)).toEqual([expect.stringContaining("(tenant_id, payer_id)")]);
  });
});

describe("0054 sale_credit_reversal_tenders constraints", () => {
  it("accepts a cash tender and a card tender with a terminal reference", async () => {
    if (skip()) return;
    expect(await tryTender({})).toBeNull();
    expect(await tryTender({ method: "card_external", reference: "A1B2" })).toBeNull();
  });

  it.each([
    ["a cash tender with a reference", { reference: "A1B2" }, "23514"],
    ["an unknown method", { method: "voucher" }, "23514"],
    ["a negative amount", { amount: "-1" }, "23514"],
    ["a malformed card reference", { method: "card_external", reference: "1234567" }, "23514"],
  ])("refuses %s", async (_name, t, code) => {
    if (skip()) return;
    expect(await tryTender(t)).toBe(code);
  });
});

describe("0054 RLS", () => {
  it.each(TABLES)("%s is ENABLE + FORCE row level security, with SELECT and INSERT policies only", async (table) => {
    if (skip()) return;
    const t = await pg().admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [table]);
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const p = await pg().admin.query<{ cmd: string }>(`SELECT cmd FROM pg_policies WHERE tablename = $1 ORDER BY cmd`, [table]);
    expect(p.rows.map((r) => r.cmd)).toEqual(["INSERT", "SELECT"]);
  });

  it("fails closed on an unset or empty tenant GUC, and is tenant-scoped", async () => {
    if (skip()) return;
    const read = (c: PoolClient) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM sale_approval_uses`);
    expect((await asApp(null, read)).rows[0]).toEqual({ n: 0 });
    expect((await asApp("", read)).rows[0]).toEqual({ n: 0 });
    expect((await asApp(TENANT_B, read)).rows[0]).toEqual({ n: 1 });
  });

  it("refuses an app-role insert for another tenant (WITH CHECK, 42501)", async () => {
    if (skip()) return;
    const code = await asApp(TENANT_B, (c) => errorCode(() => c.query(REVERSAL_SQL, reversalParams({}))));
    expect(code).toBe("42501");
  });
});

describe("0054 down", () => {
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

  async function withCreditReversal(fn: () => Promise<void>): Promise<void> {
    await pg().admin.query(REVERSAL_SQL, reversalParams({}));
    try {
      await fn();
    } finally {
      await pg().admin.query(`DELETE FROM sale_credit_reversals WHERE external_id = 'credit-1'`);
    }
  }

  it("refuses loudly while credit reversals exist, and changes nothing", async () => {
    if (skip()) return;
    await withCreditReversal(async () => {
      expect(await runDown(null)).toBe("P0001");
      expect(await schemaState()).toEqual(UP_STATE);
    });
  });

  const MIGRATION_OWNER = "rt577_migration_owner";
  const OWNED_TABLES = ["tenants", "stores", "sales", "sale_voids", "sale_returns", "payer_account", ...TABLES];

  async function quietly(statements: readonly string[]): Promise<void> {
    for (const sql of statements) await pg().admin.query(sql).catch(() => undefined);
  }

  /** A NOSUPERUSER, NOBYPASSRLS role that owns the tables 0054 touches, like the production owner. */
  async function becomeOwner(): Promise<string> {
    const superuser = (await pg().admin.query<{ u: string }>(`SELECT current_user AS u`)).rows[0]!.u;
    await pg().admin.query(`CREATE ROLE ${MIGRATION_OWNER} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await pg().admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATION_OWNER}`);
    for (const table of OWNED_TABLES) {
      await pg().admin.query(`ALTER TABLE IF EXISTS ${table} OWNER TO ${MIGRATION_OWNER}`);
    }
    await pg().admin.query(`ALTER FUNCTION IF EXISTS sale_voids_record_approval_use() OWNER TO ${MIGRATION_OWNER}`).catch(() => undefined);
    return superuser;
  }

  async function restoreOwner(superuser: string): Promise<void> {
    await quietly([
      ...OWNED_TABLES.map((table) => `ALTER TABLE IF EXISTS ${table} OWNER TO ${superuser}`),
      `ALTER FUNCTION sale_voids_record_approval_use() OWNER TO ${superuser}`,
      `REVOKE ALL ON SCHEMA public FROM ${MIGRATION_OWNER}`,
      `DROP ROLE ${MIGRATION_OWNER}`,
    ]);
  }

  // The production migration owner is NOT a superuser (database-roles.md), so
  // FORCE ROW LEVEL SECURITY applies to it: a guard that reads without a
  // tenant GUC sees no rows and would drop every credit reversal.
  it("refuses as a NON-superuser owner under FORCE RLS, and drops nothing", async () => {
    if (skip()) return;
    await withCreditReversal(async () => {
      const superuser = await becomeOwner();
      try {
        expect(await runDown(MIGRATION_OWNER)).toBe("P0001");
        expect(await schemaState()).toEqual(UP_STATE);
      } finally {
        await restoreOwner(superuser);
      }
    });
  });

  it("round-trips: down removes every 0054 object, up restores them and re-backfills", async () => {
    if (skip()) return;
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    expect(await schemaState()).toEqual(DOWN_STATE);
    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    expect(await schemaState()).toEqual(UP_STATE);
    expect((await approvalUses()).map((u) => u.approval_id)).toEqual(
      expect.arrayContaining([APPROVAL_A, APPROVAL_B]),
    );
  });

  // The backfill reads sale_voids under FORCE RLS: as a non-superuser owner a
  // bare INSERT ... SELECT would see no rows and backfill nothing.
  it("backfills every tenant as a NON-superuser owner under FORCE RLS", async () => {
    if (skip()) return;
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    const superuser = await becomeOwner();
    const client = await pg().admin.connect();
    try {
      await client.query(`SET ROLE ${MIGRATION_OWNER}`);
      await client.query(readFileSync(UP_PATH, "utf8"));
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
      await restoreOwner(superuser);
    }
    expect((await approvalUses()).filter((u) => u.source === "void").map((u) => u.approval_id)).toEqual(
      expect.arrayContaining([APPROVAL_A, APPROVAL_B]),
    );
    await ensureAppRole(pg());
  });
});
