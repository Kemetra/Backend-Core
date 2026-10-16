/**
 * 0050 — shift variance policy storage (RT-385, AD-CASH-001 F2; [GATED]
 * migration). Contract: cash-variance-policy.openapi.yaml 1.0.0-draft,
 * pos-shifts 1.2.0-draft, shift-closes 1.1.0-draft (RT-384, #778).
 *
 * Applies every migration before 0050 against a real Postgres, seeds the
 * pre-0050 shapes (a legacy shift, closed cash-up shifts with and without an
 * approver), applies 0050, then proves:
 *   - UPGRADE: every existing close reads approval_required_by_policy /
 *     approval_missing = 'unknown' (the metadata-only default), every existing
 *     shift has no frozen policy, and no revision is fabricated;
 *   - the pre-RT-387 writers keep working: an open without a frozen policy
 *     and a close without the new columns;
 *   - the frozen policy on shifts: all-or-none, structural CHECKs only
 *     (accept-and-flag: an unknown revision id, a `system` limit and a
 *     currency other than the shift's are stored), cash_up rows only, set at
 *     insert or adoption and never changed after;
 *   - the close tri-states: values, the row-local approval_missing rule and
 *     the shift-side derivation rule in shift_closes_require_open_shift;
 *   - cash_variance_policy_revisions: every CHECK, the 90 × 24 h elapsed
 *     permanent horizon (DST-safe), owner approval = publisher, the linear
 *     per-scope chain, composite store / tenant FKs, append-only, FORCED RLS
 *     with SELECT + INSERT policies;
 *   - shift_close_approver_checks: one verdict per close, pinned to the
 *     close's recorded approver, append-only, FORCED RLS;
 *   - down restores the 0036 trigger functions byte-for-byte, keeps every
 *     shift and close row, and up re-applies cleanly.
 *
 * Fresh install (the whole chain from empty) is covered by the migrate CLI
 * spec's EXPECTED_MIGRATIONS ledger.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
const UP_NAME = "0050_shift_variance_policy.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0050_shift_variance_policy.down.sql");

const TENANT_A = "0a000000-0000-7000-8000-000000050a01";
const TENANT_B = "0b000000-0000-7000-8000-000000050b01";
const STORE_A1 = "0a000000-0000-7000-8000-000000050a02";
const STORE_A2 = "0a000000-0000-7000-8000-000000050a03";
const STORE_B1 = "0b000000-0000-7000-8000-000000050b02";
const OWNER_A = "0a000000-0000-7000-8000-000000050a04";
const ADMIN_A = "0a000000-0000-7000-8000-000000050a05";
const MANAGER_A = "0a000000-0000-7000-8000-000000050a06";
const USER_B = "0b000000-0000-7000-8000-000000050b04";
const LEGACY_SHIFT = "0a000000-0000-7000-8000-000000050a10";
const PRE_CLOSED_APPROVED = "0a000000-0000-7000-8000-000000050a11";
const PRE_CLOSED_ALONE = "0a000000-0000-7000-8000-000000050a12";

const REVISIONS = "cash_variance_policy_revisions";
const VERDICTS = "shift_close_approver_checks";
const NEW_TABLES = [REVISIONS, VERDICTS] as const;
const FUNCTIONS_REPLACED = ["shifts_cash_up_guard", "shift_closes_require_open_shift"] as const;

/** The admin pool or one client of either pool. */
type Queryable = { query: PoolClient["query"] };

let env: PgTestEnv | null = null;
/** pg_get_functiondef of the replaced functions before 0050. */
const before0050 = new Map<string, string>();

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const skip = (): boolean => env === null;
const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

async function applyBefore0050(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
}

async function functionDef(name: string): Promise<string> {
  const r = await pg().admin.query<{ def: string }>(
    `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`,
    [name],
  );
  // A Windows checkout ships CRLF migration files; compare bodies line by line.
  return (r.rows[0]?.def ?? "").replace(/\r\n/g, "\n");
}

/** A fresh device of the scope, so each open is the device's only open shift. */
async function newDevice(tenant = TENANT_A, store = STORE_A1): Promise<string> {
  const id = randomUUID();
  await pg().admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES ($1, $2, $3, $4)`,
    [id, tenant, store, randomBytes(32)],
  );
  return id;
}

/** The frozen policy columns of an open, as the RT-387 writer would set them. */
interface Frozen {
  source: string | null;
  revisionId?: string | null;
  mode: string | null;
  limitAmount?: string | null;
  currency?: string | null;
  flags?: string[] | null;
}

const FROZEN_COLUMNS = `frozen_policy_source, frozen_policy_revision_id, frozen_policy_mode,
  frozen_policy_limit_amount, frozen_policy_currency_code, frozen_policy_flags`;

function frozenParams(f: Frozen): unknown[] {
  return [f.source, f.revisionId ?? null, f.mode, f.limitAmount ?? null, f.currency ?? null, f.flags ?? []];
}

interface OpenInput {
  tenant?: string;
  store?: string;
  device?: string;
  frozen?: Frozen;
}

interface Opened {
  shiftId: string;
  tenant: string;
  store: string;
  device: string;
}

/** An open cash_up shift; with no `frozen`, the pre-RT-387 insert (no frozen columns). */
async function openShift(input: OpenInput = {}, client: Queryable = pg().admin): Promise<Opened> {
  const tenant = input.tenant ?? TENANT_A;
  const store = input.store ?? STORE_A1;
  const device = input.device ?? (await newDevice(tenant, store));
  const shiftId = randomUUID();
  const user = tenant === TENANT_A ? MANAGER_A : USER_B;
  const base = [shiftId, tenant, store, user, device, digest(`open:${shiftId}`)];
  const baseSql = `shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at,
    source, currency_code, opening_float, business_date, received_at, recorded_by_user_id, payload_hash`;
  const baseValues = `$1, $2, $3, $4, $5, '2026-10-05T08:00:00Z', 'cash_up', 'EGP', 500.00,
    '2026-10-05', '2026-10-05T08:00:02Z', $4, $6`;
  if (input.frozen === undefined) {
    await client.query(`INSERT INTO shifts (${baseSql}) VALUES (${baseValues})`, base);
  } else {
    await client.query(
      `INSERT INTO shifts (${baseSql}, ${FROZEN_COLUMNS})
       VALUES (${baseValues}, $7, $8, $9, $10, $11, $12)`,
      [...base, ...frozenParams(input.frozen)],
    );
  }
  return { shiftId, tenant, store, device };
}

interface CloseInput {
  /** Signed variance; counted cash is derived so the arithmetic CHECKs hold. */
  variance?: string;
  approver?: string | null;
  /** Omitted: the pre-RT-387 insert (the columns take their default). */
  required?: string;
  missing?: string;
}

/** Records the close of an open shift (expected cash 2755.00). */
async function closeShift(s: Opened, input: CloseInput = {}, client: Queryable = pg().admin): Promise<void> {
  const variance = input.variance ?? "-5.00";
  const counted = (2755 + Number(variance)).toFixed(2);
  const closer = s.tenant === TENANT_A ? MANAGER_A : USER_B;
  const params: unknown[] = [
    s.shiftId, s.tenant, s.store, s.device, closer, counted, variance,
    input.approver ?? null, digest(`close:${s.shiftId}`),
  ];
  const cols = `shift_id, tenant_id, store_id, device_id, currency_code, closed_at, closing_user_id,
    close_kind, opening_float, cash_sales_total, cash_refunds_total, pay_in_total, pay_out_total,
    expected_cash, counted_cash, variance, sale_count, variance_approved_by_user_id,
    recorded_by_user_id, payload_hash`;
  const values = `$1, $2, $3, $4, 'EGP', '2026-10-05T16:00:00Z', $5, 'normal', 500.00, 2450.00,
    75.00, 0.00, 120.00, 2755.00, $6, $7, 37, $8, $5, $9`;
  if (input.required === undefined && input.missing === undefined) {
    await client.query(`INSERT INTO shift_closes (${cols}) VALUES (${values})`, params);
    return;
  }
  await client.query(
    `INSERT INTO shift_closes (${cols}, approval_required_by_policy, approval_missing)
     VALUES (${values}, $10, $11)`,
    [
      ...params,
      input.required === undefined ? "unknown" : input.required,
      input.missing === undefined ? "unknown" : input.missing,
    ],
  );
}

async function markClosed(shiftId: string): Promise<void> {
  await pg().admin.query(`UPDATE shifts SET lifecycle_state = 'closed' WHERE shift_id = $1`, [shiftId]);
}

interface RevisionInput {
  id?: string;
  tenant?: string;
  scope?: string;
  store?: string | null;
  kind?: string;
  mode?: string | null;
  limitAmount?: string | null;
  currency?: string | null;
  reason?: string;
  from?: string;
  createdAt?: string;
  until?: string | null;
  permanent?: boolean;
  approvedBy?: string | null;
  supersedes?: string | null;
  createdBy?: string;
}

/** A revision; defaults are a valid first tenant `set` of `limit 50.00 EGP`. */
async function insertRevision(input: RevisionInput = {}, client: Queryable = pg().admin): Promise<string> {
  const id = input.id ?? randomUUID();
  const has = (k: keyof RevisionInput): boolean => Object.prototype.hasOwnProperty.call(input, k);
  const from = input.from ?? "2026-10-16T09:00:00Z";
  await client.query(
    `INSERT INTO cash_variance_policy_revisions
       (id, tenant_id, scope, store_id, kind, mode, limit_amount, currency_code, reason,
        effective_from, effective_until, permanent, approved_by_user_id, supersedes_revision_id,
        created_by_user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      id,
      input.tenant ?? TENANT_A,
      input.scope ?? "tenant",
      has("store") ? input.store : null,
      input.kind ?? "set",
      has("mode") ? input.mode : "limit",
      has("limitAmount") ? input.limitAmount : "50.00",
      has("currency") ? input.currency : "EGP",
      input.reason ?? "Quarterly review",
      from,
      has("until") ? input.until : null,
      input.permanent ?? false,
      has("approvedBy") ? input.approvedBy : null,
      has("supersedes") ? input.supersedes : null,
      input.createdBy ?? ADMIN_A,
      input.createdAt ?? from,
    ],
  );
  return id;
}

/** A store override `set` of `limit 20.00 EGP` expiring in 30 days; `extra` overrides. */
function storeSet(extra: RevisionInput = {}): RevisionInput {
  return {
    scope: "store",
    store: STORE_A1,
    limitAmount: "20.00",
    until: "2026-11-15T09:00:00Z",
    ...extra,
  };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

/** Runs `fn` on an app-role client inside a tenant's RLS context, then rolls back. */
async function asTenant<T>(tenant: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pg().app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
    await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = await pg().admin.query<{ n: string }>(sql, params);
  return Number(r.rows[0]?.n ?? "0");
}

async function seedPre0050(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-385 A', 'rt385-a'), ($2, 'RT-385 B', 'rt385-b')`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $4, 'a1', 'A1'), ($2, $4, 'a2', 'A2'), ($3, $5, 'b1', 'B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email) VALUES
       ($1, 'owner@rt385.example'), ($2, 'admin@rt385.example'),
       ($3, 'manager@rt385.example'), ($4, 'b@rt385.example')`,
    [OWNER_A, ADMIN_A, MANAGER_A, USER_B],
  );
  // A legacy (audit-ingest) open shift, adopted later.
  const legacyDevice = await newDevice();
  await pgEnv.admin.query(
    `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
     VALUES ($1, $2, $3, $4, $5, '2026-10-04T08:00:00Z')`,
    [LEGACY_SHIFT, TENANT_A, STORE_A1, MANAGER_A, legacyDevice],
  );
  // Two closed pre-0050 cash-up shifts: one with a recorded approver, one closed alone.
  for (const [id, approver] of [[PRE_CLOSED_APPROVED, OWNER_A], [PRE_CLOSED_ALONE, null]] as const) {
    const device = await newDevice();
    const s = { shiftId: id, tenant: TENANT_A, store: STORE_A1, device };
    await pgEnv.admin.query(
      `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id,
         opened_at, source, currency_code, opening_float, business_date, received_at,
         recorded_by_user_id, payload_hash)
       VALUES ($1, $2, $3, $4, $5, '2026-10-03T08:00:00Z', 'cash_up', 'EGP', 500.00, '2026-10-03',
               '2026-10-03T08:00:02Z', $4, $6)`,
      [id, TENANT_A, STORE_A1, MANAGER_A, device, digest(`open:${id}`)],
    );
    await closeShift(s, { approver }, pgEnv.admin);
    await pgEnv.admin.query(`UPDATE shifts SET lifecycle_state = 'closed' WHERE shift_id = $1`, [id]);
  }
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0050-shift-variance-policy.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0050(env);
  await seedPre0050(env);
  for (const name of FUNCTIONS_REPLACED) before0050.set(name, await functionDef(name));
  await env.admin.query(readFileSync(UP_PATH, "utf8"));
  await ensureAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0050 — upgrade of a populated database (no fabrication)", () => {
  it("reads every existing close as unknown / unknown with no rewrite", async () => {
    if (skip()) return;
    const r = await pg().admin.query(
      `SELECT shift_id, approval_required_by_policy, approval_missing FROM shift_closes
        WHERE shift_id IN ($1, $2) ORDER BY shift_id`,
      [PRE_CLOSED_APPROVED, PRE_CLOSED_ALONE],
    );
    expect(r.rows).toEqual([
      { shift_id: PRE_CLOSED_APPROVED, approval_required_by_policy: "unknown", approval_missing: "unknown" },
      { shift_id: PRE_CLOSED_ALONE, approval_required_by_policy: "unknown", approval_missing: "unknown" },
    ]);
  });

  it("leaves every existing shift without a frozen policy", async () => {
    if (skip()) return;
    expect(
      await count(`SELECT COUNT(*) AS n FROM shifts
        WHERE frozen_policy_source IS NOT NULL OR frozen_policy_revision_id IS NOT NULL
           OR frozen_policy_mode IS NOT NULL OR frozen_policy_flags IS NOT NULL`),
    ).toBe(0);
  });

  it("writes no policy revision and no approver verdict", async () => {
    if (skip()) return;
    expect(await count(`SELECT COUNT(*) AS n FROM ${REVISIONS}`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM ${VERDICTS}`)).toBe(0);
  });

  it("keeps the pre-RT-387 open and close writes working (unknown / unknown)", async () => {
    if (skip()) return;
    const s = await openShift();
    await closeShift(s, { approver: OWNER_A });
    await markClosed(s.shiftId);
    const r = await pg().admin.query(
      `SELECT approval_required_by_policy, approval_missing FROM shift_closes WHERE shift_id = $1`,
      [s.shiftId],
    );
    expect(r.rows[0]).toEqual({ approval_required_by_policy: "unknown", approval_missing: "unknown" });
  });
});

describe("0050 — the frozen policy on shifts (accept and flag)", () => {
  it.each<[string, Frozen]>([
    ["system none", { source: "system", mode: "none" }],
    ["fallback limit 0", { source: "fallback", mode: "limit", limitAmount: "0", currency: "EGP" }],
    ["tenant limit", { source: "tenant", revisionId: randomUUID(), mode: "limit", limitAmount: "50.00", currency: "EGP" }],
    ["store none", { source: "store", revisionId: randomUUID(), mode: "none" }],
  ])("stores a frozen %s", async (_label, frozen) => {
    if (skip()) return;
    const s = await openShift({ frozen });
    const r = await pg().admin.query(
      `SELECT frozen_policy_source, frozen_policy_mode, frozen_policy_flags FROM shifts WHERE shift_id = $1`,
      [s.shiftId],
    );
    expect(r.rows[0]).toEqual({
      frozen_policy_source: frozen.source,
      frozen_policy_mode: frozen.mode,
      frozen_policy_flags: [],
    });
  });

  it("stores policy-ground mismatches verbatim with their flags (never refuses)", async () => {
    if (skip()) return;
    // An unknown revision id (no FK), a `system` limit and a currency other than
    // the shift's are each a flag, never a refusal (pos-shifts openShift).
    await openShift({
      frozen: {
        source: "tenant", revisionId: randomUUID(), mode: "limit", limitAmount: "7.5", currency: "USD",
        flags: ["policy_revision_unknown", "policy_value_mismatch"],
      },
    });
    await openShift({
      frozen: { source: "system", mode: "limit", limitAmount: "1", currency: "EGP", flags: ["policy_value_mismatch"] },
    });
  });

  it.each<[string, Frozen]>([
    ["a source without a mode", { source: "tenant", revisionId: randomUUID(), mode: null }],
    ["a mode without a source", { source: null, mode: "none" }],
    ["an unknown source", { source: "region", revisionId: randomUUID(), mode: "none" }],
    ["an unknown mode", { source: "system", mode: "cap" }],
    ["a tenant source without a revision", { source: "tenant", mode: "none" }],
    ["a store source without a revision", { source: "store", mode: "none" }],
    ["a system source with a revision", { source: "system", revisionId: randomUUID(), mode: "none" }],
    ["a fallback source with a revision", { source: "fallback", revisionId: randomUUID(), mode: "none" }],
    ["a limit without an amount", { source: "system", mode: "limit", currency: "EGP" }],
    ["a limit without a currency", { source: "system", mode: "limit", limitAmount: "5" }],
    ["none with an amount", { source: "system", mode: "none", limitAmount: "5" }],
    ["none with a currency", { source: "system", mode: "none", currency: "EGP" }],
    ["a negative limit", { source: "system", mode: "limit", limitAmount: "-1", currency: "EGP" }],
    ["a NaN limit", { source: "system", mode: "limit", limitAmount: "NaN", currency: "EGP" }],
    ["a malformed currency", { source: "system", mode: "limit", limitAmount: "1", currency: "egp" }],
    ["an unknown flag", { source: "system", mode: "none", flags: ["policy_ok"] }],
    ["a repeated flag", { source: "system", mode: "none", flags: ["policy_value_mismatch", "policy_value_mismatch"] }],
    ["a NULL flag", { source: "system", mode: "none", flags: [null as unknown as string] }],
  ])("refuses %s (23514)", async (_label, frozen) => {
    if (skip()) return;
    await expectCode(openShift({ frozen }), "23514");
  });

  it("refuses flags without a frozen policy (all-or-none)", async () => {
    if (skip()) return;
    await expectCode(openShift({ frozen: { source: null, mode: null, flags: [] } }), "23514");
  });

  it("never lets a legacy row carry a frozen policy", async () => {
    if (skip()) return;
    await expectCode(
      pg().admin.query(
        `UPDATE shifts SET frozen_policy_source = 'system', frozen_policy_mode = 'none',
           frozen_policy_flags = '{}' WHERE shift_id = $1`,
        [LEGACY_SHIFT],
      ),
      "23514",
    );
  });

  it("never changes the frozen policy of a recorded cash_up open (42501)", async () => {
    if (skip()) return;
    const s = await openShift({ frozen: { source: "system", mode: "none" } });
    await expectCode(
      pg().admin.query(
        `UPDATE shifts SET frozen_policy_flags = '{policy_value_mismatch}' WHERE shift_id = $1`,
        [s.shiftId],
      ),
      "42501",
    );
    const bare = await openShift();
    await expectCode(
      pg().admin.query(
        `UPDATE shifts SET frozen_policy_source = 'system', frozen_policy_mode = 'none',
           frozen_policy_flags = '{}' WHERE shift_id = $1`,
        [bare.shiftId],
      ),
      "42501",
    );
  });

  it("adopts an open legacy row with its frozen policy, and closes it unchanged", async () => {
    if (skip()) return;
    await pg().admin.query(
      `UPDATE shifts SET source = 'cash_up', currency_code = 'EGP', opening_float = 100.00,
         business_date = '2026-10-04', received_at = '2026-10-04T08:00:03Z',
         recorded_by_user_id = opening_cashier_user_id, payload_hash = $2,
         frozen_policy_source = 'tenant', frozen_policy_revision_id = $3,
         frozen_policy_mode = 'limit', frozen_policy_limit_amount = 10.00,
         frozen_policy_currency_code = 'EGP', frozen_policy_flags = '{policy_revision_unknown}'
       WHERE shift_id = $1`,
      [LEGACY_SHIFT, digest(`adopt:${LEGACY_SHIFT}`), randomUUID()],
    );
    const row = await pg().admin.query<{ opening_device_id: string }>(
      `SELECT opening_device_id FROM shifts WHERE shift_id = $1`,
      [LEGACY_SHIFT],
    );
    const device = row.rows[0]!.opening_device_id;
    // Variance -5 within limit 10: approval not required.
    const counted = "2350.00";
    await pg().admin.query(
      `INSERT INTO shift_closes
         (shift_id, tenant_id, store_id, device_id, currency_code, closed_at, closing_user_id,
          close_kind, opening_float, cash_sales_total, cash_refunds_total, pay_in_total,
          pay_out_total, expected_cash, counted_cash, variance, sale_count, recorded_by_user_id,
          payload_hash, approval_required_by_policy, approval_missing)
       VALUES ($1, $2, $3, $4, 'EGP', '2026-10-04T16:00:00Z', $5, 'normal', 100.00, 2450.00,
               75.00, 0.00, 120.00, 2355.00, $6, -5.00, 3, $5, $7, 'no', 'no')`,
      [LEGACY_SHIFT, TENANT_A, STORE_A1, device, MANAGER_A, counted, digest(`close:${LEGACY_SHIFT}`)],
    );
    await markClosed(LEGACY_SHIFT);
    const after = await pg().admin.query(
      `SELECT lifecycle_state, frozen_policy_mode, frozen_policy_flags FROM shifts WHERE shift_id = $1`,
      [LEGACY_SHIFT],
    );
    expect(after.rows[0]).toEqual({
      lifecycle_state: "closed",
      frozen_policy_mode: "limit",
      frozen_policy_flags: ["policy_revision_unknown"],
    });
  });

  it("adopts an open legacy row without a frozen policy (the pre-RT-387 adoption)", async () => {
    if (skip()) return;
    const device = await newDevice();
    const id = randomUUID();
    await pg().admin.query(
      `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
       VALUES ($1, $2, $3, $4, $5, '2026-10-06T08:00:00Z')`,
      [id, TENANT_A, STORE_A1, MANAGER_A, device],
    );
    await pg().admin.query(
      `UPDATE shifts SET source = 'cash_up', currency_code = 'EGP', opening_float = 0,
         business_date = '2026-10-06', received_at = '2026-10-06T08:00:01Z',
         recorded_by_user_id = opening_cashier_user_id, payload_hash = $2
       WHERE shift_id = $1`,
      [id, digest(`adopt:${id}`)],
    );
  });
});

describe("0050 — the close tri-states", () => {
  const limit = (amount: string, currency = "EGP"): Frozen => ({
    source: "tenant", revisionId: randomUUID(), mode: "limit", limitAmount: amount, currency,
  });

  it.each<[string, CloseInput]>([
    ["an unknown required value", { required: "maybe", missing: "unknown" }],
    ["an unknown missing value", { required: "unknown", missing: "maybe" }],
    ["unknown required with a known missing", { required: "unknown", missing: "no" }],
    ["not required but missing", { required: "no", missing: "yes" }],
  ])("refuses %s (23514)", async (_label, input) => {
    if (skip()) return;
    await expectCode(closeShift(await openShift(), input), "23514");
  });

  it("refuses NULL tri-states (NOT NULL)", async () => {
    if (skip()) return;
    const nil = null as unknown as string;
    await expectCode(closeShift(await openShift(), { required: "unknown", missing: nil }), "23502");
    await expectCode(closeShift(await openShift(), { required: nil, missing: "unknown" }), "23502");
  });

  it("ties approval_missing to the recorded approver when approval is required", async () => {
    if (skip()) return;
    const zero = limit("0");
    await expectCode(closeShift(await openShift({ frozen: zero }), { required: "yes", missing: "no" }), "23514");
    await expectCode(
      closeShift(await openShift({ frozen: zero }), { required: "yes", missing: "yes", approver: OWNER_A }),
      "23514",
    );
    await closeShift(await openShift({ frozen: zero }), { required: "yes", missing: "yes" });
    await closeShift(await openShift({ frozen: zero }), { required: "yes", missing: "no", approver: OWNER_A });
  });

  it("refuses yes / no when the shift froze no policy", async () => {
    if (skip()) return;
    await expectCode(closeShift(await openShift(), { required: "no", missing: "no" }), "23514");
    await expectCode(closeShift(await openShift(), { required: "yes", missing: "yes" }), "23514");
  });

  async function closeValues(s: Opened): Promise<unknown> {
    const r = await pg().admin.query(
      `SELECT approval_required_by_policy AS required, approval_missing AS missing
         FROM shift_closes WHERE shift_id = $1`,
      [s.shiftId],
    );
    return r.rows[0];
  }

  it.each<[string, Frozen, CloseInput, { required: string; missing: string }]>([
    ["none", { source: "system", mode: "none" }, {}, { required: "no", missing: "no" }],
    ["limit 0, no approver", limit("0"), {}, { required: "yes", missing: "yes" }],
    ["limit 0, an approver", limit("0"), { approver: OWNER_A }, { required: "yes", missing: "no" }],
    ["limit 10", limit("10"), {}, { required: "no", missing: "no" }],
    ["a limit in another currency (D-1 has no currency condition)", limit("0", "USD"), {}, { required: "yes", missing: "yes" }],
  ])(
    "derives the values a pre-RT-387 close leaves at the default (rollback-safe): %s",
    async (_label, frozen, input, expected) => {
      if (skip()) return;
      const s = await openShift({ frozen });
      await closeShift(s, input);
      expect(await closeValues(s)).toEqual(expected);
      await markClosed(s.shiftId);
    },
  );

  it("derives from an explicit unknown / unknown, never from a half-unknown pair", async () => {
    if (skip()) return;
    const none: Frozen = { source: "system", mode: "none" };
    const s = await openShift({ frozen: none });
    await closeShift(s, { required: "unknown", missing: "unknown" });
    expect(await closeValues(s)).toEqual({ required: "no", missing: "no" });
    await expectCode(closeShift(await openShift({ frozen: none }), { required: "unknown", missing: "no" }), "23514");
  });

  it("derives `no` under a frozen `none`", async () => {
    if (skip()) return;
    const none: Frozen = { source: "system", mode: "none" };
    await expectCode(closeShift(await openShift({ frozen: none }), { required: "yes", missing: "yes" }), "23514");
    await closeShift(await openShift({ frozen: none }), { required: "no", missing: "no", variance: "-900.00" });
  });

  it("derives a same-currency limit: required exactly when |variance| > limit", async () => {
    if (skip()) return;
    // |−5| = 5 is not above 5; above 4.99; never above 10.
    await closeShift(await openShift({ frozen: limit("5") }), { required: "no", missing: "no" });
    await expectCode(closeShift(await openShift({ frozen: limit("5") }), { required: "yes", missing: "yes" }), "23514");
    await closeShift(await openShift({ frozen: limit("4.99") }), { required: "yes", missing: "yes" });
    await expectCode(closeShift(await openShift({ frozen: limit("4.99") }), { required: "no", missing: "no" }), "23514");
    await closeShift(await openShift({ frozen: limit("10") }), { required: "no", missing: "no", variance: "7.00" });
    await closeShift(await openShift({ frozen: limit("0") }), { required: "no", missing: "no", variance: "0.00" });
  });

  it("applies a frozen limit in another currency as frozen (flagged, never exempt)", async () => {
    if (skip()) return;
    await closeShift(await openShift({ frozen: limit("1", "USD") }), { required: "yes", missing: "yes" });
    await expectCode(closeShift(await openShift({ frozen: limit("1", "USD") }), { required: "no", missing: "no" }), "23514");
    await closeShift(await openShift({ frozen: limit("10", "USD") }), { required: "no", missing: "no" });
  });

  it("never keeps `unknown` on a close whose shift froze a policy", async () => {
    if (skip()) return;
    const frozenShapes: Frozen[] = [
      { source: "system", mode: "none" },
      { source: "fallback", mode: "limit", limitAmount: "0", currency: "EGP" },
      limit("3", "USD"),
    ];
    for (const frozen of frozenShapes) {
      const s = await openShift({ frozen });
      await closeShift(s);
      const v = (await closeValues(s)) as { required: string; missing: string };
      expect(v.required).not.toBe("unknown");
      expect(v.missing).not.toBe("unknown");
    }
    expect(
      await count(`SELECT COUNT(*) AS n FROM shift_closes c JOIN shifts s ON s.shift_id = c.shift_id
        WHERE s.frozen_policy_source IS NOT NULL AND c.approval_required_by_policy = 'unknown'`),
    ).toBe(0);
  });

  it("keeps shift_closes append-only (the tri-states are never updated)", async () => {
    if (skip()) return;
    await expectCode(
      pg().admin.query(
        `UPDATE shift_closes SET approval_required_by_policy = 'yes' WHERE shift_id = $1`,
        [PRE_CLOSED_ALONE],
      ),
      "42501",
    );
  });
});

describe("0050 — cash_variance_policy_revisions", () => {
  it("stores a tenant default, a store override and a clear", async () => {
    if (skip()) return;
    const t = await insertRevision({ tenant: TENANT_B, createdBy: USER_B });
    const s = await insertRevision(storeSet({ tenant: TENANT_B, store: STORE_B1, createdBy: USER_B }));
    await insertRevision({
      tenant: TENANT_B, scope: "store", store: STORE_B1, kind: "clear", mode: null, limitAmount: null,
      currency: null, supersedes: s, createdBy: USER_B,
    });
    await insertRevision({ tenant: TENANT_B, mode: "none", limitAmount: null, currency: null, supersedes: t, createdBy: USER_B });
  });

  it.each<[string, RevisionInput]>([
    ["an unknown scope", { scope: "region" }],
    ["a tenant revision with a store", { store: STORE_A2 }],
    ["a store revision without a store", { scope: "store", until: "2026-11-15T09:00:00Z" }],
    ["a tenant clear", { kind: "clear", mode: null, limitAmount: null, currency: null }],
    ["a tenant expiry", { until: "2026-11-15T09:00:00Z" }],
    ["an unknown kind", { kind: "reset" }],
    ["a set without a mode", { mode: null, limitAmount: null, currency: null }],
    ["an unknown mode", { mode: "cap" }],
    ["a limit without an amount", { limitAmount: null }],
    ["a limit without a currency", { currency: null }],
    ["none with an amount", { mode: "none", currency: null }],
    ["a negative limit", { limitAmount: "-0.01" }],
    ["a NaN limit", { limitAmount: "NaN" }],
    ["a malformed currency", { currency: "E1P" }],
    ["an empty reason", { reason: "" }],
    ["a 201-character reason", { reason: "r".repeat(201) }],
    ["a scheduled (not Apply Now) revision", { createdAt: "2026-10-16T08:00:00Z" }],
    ["a permanent tenant revision", { permanent: true, approvedBy: ADMIN_A }],
    ["an approver on a non-permanent revision", { approvedBy: ADMIN_A }],
  ])("refuses %s (23514)", async (_label, input) => {
    if (skip()) return;
    await expectCode(insertRevision(input), "23514");
  });

  it.each<[string, RevisionInput]>([
    ["a clear with a value", { kind: "clear", until: null }],
    ["a clear with an expiry", { kind: "clear", mode: null, limitAmount: null, currency: null }],
    ["an expiry not after publish", { until: "2026-10-16T09:00:00Z" }],
    ["an expiring override marked permanent", { permanent: true, approvedBy: OWNER_A, createdBy: OWNER_A }],
    ["a no-expiry override not marked permanent", { until: null }],
    ["a permanent override without its approver", { until: null, permanent: true }],
    ["an approver other than the publisher", { until: null, permanent: true, approvedBy: OWNER_A, createdBy: ADMIN_A }],
  ])("refuses a store revision with %s (23514)", async (_label, input) => {
    if (skip()) return;
    await expectCode(insertRevision(storeSet(input)), "23514");
  });

  it("marks permanent exactly beyond 90 × 24 h of elapsed time (DST-safe)", async () => {
    if (skip()) return;
    const client = await pg().admin.connect();
    try {
      // 2026-11-01 ends US DST: calendar `+ 90 days` here is 2161 h, elapsed 2160 h.
      await client.query("SET TimeZone = 'America/New_York'");
      const from = "2026-10-01T12:00:00Z";
      const at = (hours: number): string => new Date(Date.parse(from) + hours * 3_600_000).toISOString();
      const base = { from, store: STORE_A2, createdBy: OWNER_A };
      const exact = await insertRevision(storeSet({ ...base, until: at(2160) }), client);
      // 2160.5 h is beyond the horizon though before `from + 90 days` in this zone.
      await expectCode(insertRevision(storeSet({ ...base, supersedes: exact, until: at(2160.5) }), client), "23514");
      await insertRevision(
        storeSet({ ...base, supersedes: exact, until: at(2160.5), permanent: true, approvedBy: OWNER_A }),
        client,
      );
    } finally {
      await client.query("RESET TimeZone");
      client.release();
    }
  });

  it("refuses a store of another tenant and an unknown user (23503)", async () => {
    if (skip()) return;
    await expectCode(insertRevision(storeSet({ store: STORE_B1 })), "23503");
    await expectCode(
      insertRevision({ tenant: TENANT_B, createdBy: randomUUID(), supersedes: await latestTenantRevision(TENANT_B) }),
      "23503",
    );
  });

  it("keeps each scope's history one linear chain", async () => {
    if (skip()) return;
    const store = await insertStore();
    const first = await insertRevision(storeSet({ store }));
    // A second first revision of the same scope, and a fork, are refused.
    await expectCode(insertRevision(storeSet({ store })), "23505");
    const second = await insertRevision(storeSet({ store, supersedes: first }));
    await expectCode(insertRevision(storeSet({ store, supersedes: first })), "23505");
    await insertRevision(storeSet({ store, supersedes: second }));
  });

  it("refuses a child listed before its parent in one multi-row INSERT (23503)", async () => {
    if (skip()) return;
    const store = await insertStore();
    const parent = randomUUID();
    const child = randomUUID();
    const row = (id: string, scope: string, storeId: string | null, supersedes: string | null): string =>
      `('${id}', '${TENANT_A}', '${scope}', ${storeId === null ? "NULL" : `'${storeId}'`}, 'set', 'none',
        'r', false, ${supersedes === null ? "NULL" : `'${supersedes}'`}, '${ADMIN_A}')`;
    await expectCode(
      pg().admin.query(
        `INSERT INTO ${REVISIONS} (id, tenant_id, scope, store_id, kind, mode, reason, permanent,
           supersedes_revision_id, created_by_user_id)
         VALUES ${row(child, "store", store, parent)}, ${row(parent, "store", store, null)}`,
      ),
      "23503",
    );
  });

  it("refuses a revision dated before the one it supersedes (23514)", async () => {
    if (skip()) return;
    const store = await insertStore();
    const first = await insertRevision(storeSet({ store, from: "2026-10-16T09:00:00Z" }));
    await expectCode(
      insertRevision(storeSet({ store, supersedes: first, from: "2026-10-16T08:59:59Z" })),
      "23514",
    );
    await insertRevision(storeSet({ store, supersedes: first, from: "2026-10-16T09:00:00Z" }));
  });

  it("refuses a predecessor of another scope, store or tenant", async () => {
    if (skip()) return;
    const storeX = await insertStore();
    const storeY = await insertStore();
    const tenantRev = await insertRevision({ tenant: TENANT_B, createdBy: USER_B, supersedes: await latestTenantRevision(TENANT_B) });
    const x = await insertRevision(storeSet({ store: storeX }));
    await expectCode(insertRevision(storeSet({ store: storeY, supersedes: x })), "23514");
    await expectCode(insertRevision({ supersedes: x }), "23514");
    await expectCode(insertRevision(storeSet({ store: storeX, supersedes: tenantRev })), "23503");
    await expectCode(insertRevision(storeSet({ store: storeX, supersedes: randomUUID() })), "23503");
  });

  it("is append-only for every role (42501)", async () => {
    if (skip()) return;
    const id = await latestTenantRevision(TENANT_B);
    await expectCode(pg().admin.query(`UPDATE ${REVISIONS} SET reason = 'x' WHERE id = $1`, [id]), "42501");
    await expectCode(pg().admin.query(`DELETE FROM ${REVISIONS} WHERE id = $1`, [id]), "42501");
    await expectCode(pg().admin.query(`TRUNCATE ${REVISIONS} CASCADE`), "42501");
  });

  it("changes nothing for the app role under FORCE RLS (no UPDATE / DELETE policy)", async () => {
    if (skip()) return;
    const id = await insertRevision(storeSet({ store: await insertStore(), reason: "Renovation" }));
    await expectAppRoleCannotMutate(REVISIONS, "id", id, "reason = 'rewritten'");
    const r = await pg().admin.query(`SELECT reason FROM ${REVISIONS} WHERE id = $1`, [id]);
    expect(r.rows[0]).toEqual({ reason: "Renovation" });
  });

  it("indexes the keyset history of a scope", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = 'idx_cash_variance_policy_revisions_scope_history'`,
      [REVISIONS],
    );
    expect(r.rows[0]?.indexdef).toContain("(tenant_id, scope, store_id, created_at DESC, id DESC)");
  });
});

describe("0050 — RLS on the new tables", () => {
  it.each(NEW_TABLES)("%s is RLS enabled and forced with SELECT + INSERT policies only", async (table) => {
    if (skip()) return;
    const rel = await pg().admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [table],
    );
    expect(rel.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await pg().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = $1 ORDER BY cmd`,
      [table],
    );
    expect(pol.rows.map((p) => p.cmd)).toEqual(["INSERT", "SELECT"]);
  });

  it("isolates revisions by tenant under the app role", async () => {
    if (skip()) return;
    const seen = await asTenant(TENANT_A, async (c) => {
      const r = await c.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM ${REVISIONS}`);
      return r.rows.map((x) => x.tenant_id);
    });
    expect(seen).not.toContain(TENANT_B);
    // A first override of a tenant-B store, written in tenant A's context.
    const storeB = await insertStore(TENANT_B);
    await asTenant(TENANT_A, async (c) => {
      await expectCode(
        insertRevision(storeSet({ tenant: TENANT_B, store: storeB, createdBy: USER_B }), c),
        "42501",
      );
    });
  });
});

describe("0050 — shift_close_approver_checks", () => {
  async function closedWithApprover(approver: string | null): Promise<Opened> {
    const s = await openShift();
    await closeShift(s, { approver });
    return s;
  }

  async function insertVerdict(
    s: Opened,
    v: { approver?: string | null; status?: string; reason?: string | null } = {},
    client: Queryable = pg().admin,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${VERDICTS} (shift_id, tenant_id, store_id, approver_user_id, status, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [s.shiftId, s.tenant, s.store, v.approver === undefined ? OWNER_A : v.approver,
        v.status ?? "verified", v.reason === undefined ? null : v.reason],
    );
  }

  it("records one verdict for a close with an approver", async () => {
    if (skip()) return;
    const s = await closedWithApprover(OWNER_A);
    await insertVerdict(s);
    await expectCode(insertVerdict(s, { status: "unverified", reason: "not_manager" }), "23505");
  });

  it("stores each unverified reason", async () => {
    if (skip()) return;
    for (const reason of ["approver_is_closer", "inactive_membership", "not_manager", "no_store_access"]) {
      await insertVerdict(await closedWithApprover(OWNER_A), { status: "unverified", reason });
    }
  });

  it.each<[string, { status?: string; reason?: string | null }]>([
    ["verified with a reason", { reason: "not_manager" }],
    ["unverified without a reason", { status: "unverified" }],
    ["the placeholder (a missing row is the placeholder)", { status: "unverified", reason: "check_unavailable" }],
    ["not_applicable (derived from no approver)", { status: "not_applicable" }],
    ["an unknown reason", { status: "unverified", reason: "on_leave" }],
  ])("refuses %s (23514)", async (_label, v) => {
    if (skip()) return;
    await expectCode(insertVerdict(await closedWithApprover(OWNER_A), v), "23514");
  });

  it("only attaches to the close's own recorded approver (23503)", async () => {
    if (skip()) return;
    await expectCode(insertVerdict(await closedWithApprover(OWNER_A), { approver: ADMIN_A }), "23503");
    await expectCode(insertVerdict(await closedWithApprover(null), { approver: OWNER_A }), "23503");
    await expectCode(insertVerdict(await closedWithApprover(null), { approver: null }), "23502");
  });

  it("is append-only for every role (42501)", async () => {
    if (skip()) return;
    const s = await closedWithApprover(OWNER_A);
    await insertVerdict(s, { status: "unverified", reason: "not_manager" });
    await expectCode(
      pg().admin.query(`UPDATE ${VERDICTS} SET status = 'verified', reason = NULL WHERE shift_id = $1`, [s.shiftId]),
      "42501",
    );
    await expectCode(pg().admin.query(`DELETE FROM ${VERDICTS} WHERE shift_id = $1`, [s.shiftId]), "42501");
    await expectCode(pg().admin.query(`TRUNCATE ${VERDICTS}`), "42501");
  });

  it("refuses a verdict naming another approver than the close recorded (FK)", async () => {
    if (skip()) return;
    const s = await closedWithApprover(OWNER_A);
    await expectCode(insertVerdict(s, { approver: MANAGER_A }), "23503");
    expect(await count(`SELECT COUNT(*) AS n FROM ${VERDICTS} WHERE shift_id = $1`, [s.shiftId])).toBe(0);
  });

  it("changes nothing for the app role under FORCE RLS (no UPDATE / DELETE policy)", async () => {
    if (skip()) return;
    const s = await closedWithApprover(OWNER_A);
    await insertVerdict(s, { status: "unverified", reason: "not_manager" });
    await expectAppRoleCannotMutate(VERDICTS, "shift_id", s.shiftId, "status = 'verified', reason = NULL");
    const r = await pg().admin.query(`SELECT status, reason FROM ${VERDICTS} WHERE shift_id = $1`, [s.shiftId]);
    expect(r.rows[0]).toEqual({ status: "unverified", reason: "not_manager" });
  });

  it("isolates verdicts by tenant under the app role", async () => {
    if (skip()) return;
    const sb = await openShift({ tenant: TENANT_B, store: STORE_B1 });
    await closeShift(sb, { approver: USER_B });
    await asTenant(TENANT_A, async (c) => {
      await expectCode(insertVerdict(sb, { approver: USER_B }, c), "42501");
    });
    await insertVerdict(sb, { approver: USER_B });
    const seen = await asTenant(TENANT_A, async (c) =>
      (await c.query(`SELECT 1 FROM ${VERDICTS} WHERE tenant_id = $1`, [TENANT_B])).rowCount,
    );
    expect(seen).toBe(0);
  });
});

describe("0050 — trigger functions pin their search_path", () => {
  it.each([...FUNCTIONS_REPLACED, "cash_variance_policy_revisions_append_only",
    "cash_variance_policy_revisions_chain_guard", "shift_close_approver_checks_append_only"])(
    "%s sets search_path = pg_catalog, public",
    async (name) => {
      if (skip()) return;
      const r = await pg().admin.query<{ proconfig: string[] | null }>(
        `SELECT proconfig FROM pg_proc WHERE proname = $1`,
        [name],
      );
      expect(r.rows[0]?.proconfig).toEqual(["search_path=pg_catalog, public"]);
    },
  );
});

describe("0050 — down → up round-trip", () => {
  it("down restores 0036, keeps every shift and close; up re-applies", async () => {
    if (skip()) return;
    const shifts = await count(`SELECT COUNT(*) AS n FROM shifts`);
    const closes = await count(`SELECT COUNT(*) AS n FROM shift_closes`);
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    for (const name of FUNCTIONS_REPLACED) expect(await functionDef(name)).toBe(before0050.get(name));
    expect(await count(`SELECT COUNT(*) AS n FROM pg_class WHERE relname = ANY($1)`, [[...NEW_TABLES]])).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM information_schema.columns
          WHERE table_schema = 'public' AND (column_name LIKE 'frozen_policy_%'
             OR column_name IN ('approval_required_by_policy', 'approval_missing'))`,
      ),
    ).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM shifts`)).toBe(shifts);
    expect(await count(`SELECT COUNT(*) AS n FROM shift_closes`)).toBe(closes);
    expect(await count(`SELECT COUNT(*) AS n FROM pg_proc WHERE proname LIKE 'cash_variance_policy%'
      OR proname LIKE 'shift_close_approver_checks%'`)).toBe(0);

    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    await ensureAppRole(pg());
    expect(await count(`SELECT COUNT(*) AS n FROM pg_class WHERE relname = ANY($1)`, [[...NEW_TABLES]])).toBe(2);
    expect(
      await count(`SELECT COUNT(*) AS n FROM shift_closes WHERE approval_required_by_policy = 'unknown'`),
    ).toBe(closes);
  });
});

/**
 * Under tenant A's RLS context the app role sees its own row, yet UPDATE and
 * DELETE match nothing (FORCE RLS, SELECT + INSERT policies only) and TRUNCATE
 * is refused (no privilege).
 */
async function expectAppRoleCannotMutate(
  table: string,
  keyColumn: string,
  key: string,
  assignment: string,
): Promise<void> {
  await asTenant(TENANT_A, async (c) => {
    const where = `WHERE ${keyColumn} = $1`;
    expect((await c.query(`SELECT 1 FROM ${table} ${where}`, [key])).rowCount).toBe(1);
    expect((await c.query(`UPDATE ${table} SET ${assignment} ${where}`, [key])).rowCount).toBe(0);
    expect((await c.query(`DELETE FROM ${table} ${where}`, [key])).rowCount).toBe(0);
  });
  await asTenant(TENANT_A, async (c) => {
    await expectCode(c.query(`TRUNCATE ${table}`), "42501");
  });
}

async function insertStore(tenant = TENANT_A): Promise<string> {
  const id = randomUUID();
  await pg().admin.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, 'S')`, [
    id, tenant, `s-${id.slice(0, 8)}`,
  ]);
  return id;
}

async function latestTenantRevision(tenant: string): Promise<string | null> {
  const r = await pg().admin.query<{ id: string }>(
    `SELECT r.id FROM ${REVISIONS} r
      WHERE r.tenant_id = $1 AND r.scope = 'tenant'
        AND NOT EXISTS (SELECT 1 FROM ${REVISIONS} n WHERE n.supersedes_revision_id = r.id)`,
    [tenant],
  );
  return r.rows[0]?.id ?? null;
}
