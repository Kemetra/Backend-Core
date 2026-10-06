/**
 * 0036 — shift cash-up persistence (RT-17 slice 2; [GATED] approval: Jira
 * RT-17 comments 10760 + 10919 + 10920).
 *
 * Applies every migration before 0036 against a real Postgres, seeds a
 * legacy (audit-ingest) shift, applies 0036, then proves:
 *   - the legacy row survives as `source = 'legacy'` with no cash-up fields,
 *     and a legacy row can never carry them (nor a cash_up row lack them);
 *   - the three fact tables are RLS enabled + forced with SELECT / INSERT
 *     policies only; under the NOBYPASSRLS app role, tenant A sees nothing of
 *     tenant B's shifts, movements, closes or claims and cannot insert into
 *     tenant B;
 *   - one OPEN cash_up shift per (tenant, device), legacy rows excluded;
 *   - the shifts guard: open → closed only with the matching close, once,
 *     nothing else changes, `source` never changes, a cash_up row is never
 *     deleted, TRUNCATE is refused; legacy rows keep their old behaviour;
 *   - the composite FKs: a movement / close must match the shift's tenant,
 *     store, device and currency (and the close its opening float); a legacy
 *     shift can never be referenced; a claim's return must be of the same
 *     tenant and store, and a return is claimed at most once;
 *   - the close arithmetic CHECKs, forced_reason ⇔ forced, and the movement
 *     CHECKs; a movement on a closed shift is refused (55000);
 *   - the three fact tables are append-only for every role (42501);
 *   - the sales recompute index exists;
 *   - down → up round-trips cleanly.
 *
 * Fresh install (the whole chain from empty) is covered by the migrate CLI
 * spec's EXPECTED_MIGRATIONS ledger.
 */
import { createHash, randomUUID } from "node:crypto";
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
const UP_NAME = "0036_shift_cash_up.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0036_shift_cash_up.down.sql");

const TENANT_A = "0a000000-0000-7000-8000-000000036a01";
const TENANT_B = "0b000000-0000-7000-8000-000000036b01";
const STORE_A1 = "0a000000-0000-7000-8000-000000036a02";
const STORE_A2 = "0a000000-0000-7000-8000-000000036a03";
const STORE_B1 = "0b000000-0000-7000-8000-000000036b02";
const USER_A = "0a000000-0000-7000-8000-000000036a04";
const USER_B = "0b000000-0000-7000-8000-000000036b04";
const DEVICE_A1 = "0a000000-0000-7000-8000-000000036a05";
const DEVICE_A1_OTHER = "0a000000-0000-7000-8000-000000036a06";
const DEVICE_A2 = "0a000000-0000-7000-8000-000000036a07";
const DEVICE_B1 = "0b000000-0000-7000-8000-000000036b05";
const SALE_A1 = "0a000000-0000-7000-8000-000000036a08";
const SALE_A2 = "0a000000-0000-7000-8000-000000036a09";
const SALE_B1 = "0b000000-0000-7000-8000-000000036b08";
const RETURN_A1 = "0a000000-0000-7000-8000-000000036a0a";
const RETURN_A1_SECOND = "0a000000-0000-7000-8000-000000036a0b";
const RETURN_A2 = "0a000000-0000-7000-8000-000000036a0c";
const RETURN_B1 = "0b000000-0000-7000-8000-000000036b0a";
const LEGACY_SHIFT = "0a000000-0000-7000-8000-000000036a0d";

const FACT_TABLES = ["shift_closes", "shift_cash_movements", "shift_refund_claims"] as const;

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const skip = (): boolean => env === null;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

async function applyBefore0036(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
}

interface ShiftInput {
  id?: string;
  tenant?: string;
  store?: string;
  device?: string;
  user?: string;
  currency?: string | null;
  openingFloat?: string | null;
  businessDate?: string | null;
  receivedAt?: string | null;
  recordedBy?: string | null;
  payloadHash?: Buffer | null;
  source?: string;
}

/** A cash_up shift row (admin pool, so RLS does not apply). */
async function insertShift(input: ShiftInput = {}): Promise<string> {
  const id = input.id ?? randomUUID();
  const has = (k: keyof ShiftInput): boolean => Object.prototype.hasOwnProperty.call(input, k);
  await pg().admin.query(
    `INSERT INTO shifts
       (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at,
        source, currency_code, opening_float, business_date, received_at, recorded_by_user_id,
        payload_hash)
     VALUES ($1, $2, $3, $4, $5, '2026-10-05T08:00:00Z', $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      input.tenant ?? TENANT_A,
      input.store ?? STORE_A1,
      input.user ?? USER_A,
      input.device ?? DEVICE_A1,
      input.source ?? "cash_up",
      has("currency") ? input.currency : "EGP",
      has("openingFloat") ? input.openingFloat : "500.00",
      has("businessDate") ? input.businessDate : "2026-10-05",
      has("receivedAt") ? input.receivedAt : "2026-10-05T08:00:02Z",
      has("recordedBy") ? input.recordedBy : (input.user ?? USER_A),
      has("payloadHash") ? input.payloadHash : digest(`open:${id}`),
    ],
  );
  return id;
}

interface CloseInput {
  tenant?: string;
  store?: string;
  device?: string;
  currency?: string;
  user?: string;
  kind?: "normal" | "forced" | string;
  forcedReason?: string | null;
  openingFloat?: string;
  cashSales?: string;
  cashRefunds?: string;
  payIn?: string;
  payOut?: string;
  expected?: string;
  counted?: string;
  variance?: string;
  saleCount?: number;
  payloadHash?: Buffer;
}

/** Inserts a shift_closes row; defaults satisfy the arithmetic. */
async function insertCloseRow(
  shiftId: string,
  input: CloseInput = {},
  client: { query: PoolClient["query"] } = pg().admin,
): Promise<void> {
  await client.query(
    `INSERT INTO shift_closes
       (shift_id, tenant_id, store_id, device_id, currency_code, closed_at, closing_user_id,
        close_kind, forced_reason, opening_float, cash_sales_total, cash_refunds_total,
        pay_in_total, pay_out_total, expected_cash, counted_cash, variance, sale_count,
        recorded_by_user_id, payload_hash)
     VALUES ($1, $2, $3, $4, $5, '2026-10-05T16:00:00Z', $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $6, $18)`,
    [
      shiftId,
      input.tenant ?? TENANT_A,
      input.store ?? STORE_A1,
      input.device ?? DEVICE_A1,
      input.currency ?? "EGP",
      input.user ?? USER_A,
      input.kind ?? "normal",
      input.forcedReason ?? null,
      input.openingFloat ?? "500.00",
      input.cashSales ?? "2450.00",
      input.cashRefunds ?? "75.00",
      input.payIn ?? "0.00",
      input.payOut ?? "120.00",
      input.expected ?? "2755.00",
      input.counted ?? "2750.00",
      input.variance ?? "-5.00",
      input.saleCount ?? 37,
      input.payloadHash ?? digest(`close:${shiftId}`),
    ],
  );
}

/** Records the close and moves the shift to its closed state. */
async function closeShift(shiftId: string, input: CloseInput = {}): Promise<void> {
  await insertCloseRow(shiftId, input);
  await pg().admin.query(`UPDATE shifts SET lifecycle_state = $2 WHERE shift_id = $1`, [
    shiftId,
    input.kind === "forced" ? "closed_forced" : "closed",
  ]);
}

interface MovementInput {
  id?: string;
  tenant?: string;
  store?: string;
  device?: string;
  currency?: string;
  kind?: string;
  amount?: string;
  reason?: string;
  note?: string | null;
}

async function insertMovement(shiftId: string, input: MovementInput = {}): Promise<string> {
  const id = input.id ?? randomUUID();
  await pg().admin.query(
    `INSERT INTO shift_cash_movements
       (id, shift_id, tenant_id, store_id, device_id, currency_code, kind, amount, reason_code,
        note, occurred_at, recorded_by_user_id, payload_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '2026-10-05T11:30:00Z', $11, $12)`,
    [
      id,
      shiftId,
      input.tenant ?? TENANT_A,
      input.store ?? STORE_A1,
      input.device ?? DEVICE_A1,
      input.currency ?? "EGP",
      input.kind ?? "pay_out",
      input.amount ?? "120.00",
      input.reason ?? "petty_expense",
      input.note === undefined ? "Cleaning supplies" : input.note,
      USER_A,
      digest(`movement:${id}`),
    ],
  );
  return id;
}

async function insertClaim(
  shiftId: string,
  returnId: string,
  opts: { tenant?: string; store?: string; ordinal?: number } = {},
): Promise<void> {
  await pg().admin.query(
    `INSERT INTO shift_refund_claims (return_id, shift_id, tenant_id, store_id, ordinal)
     VALUES ($1, $2, $3, $4, $5)`,
    [returnId, shiftId, opts.tenant ?? TENANT_A, opts.store ?? STORE_A1, opts.ordinal ?? 0],
  );
}

async function seedSaleAndReturn(
  saleId: string,
  returnIds: string[],
  tenant: string,
  store: string,
  actor: string,
): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 100, '2026-10-05T09:00:00Z', '2026-10-05', 'pos', $6, $4, $5)`,
    [saleId, tenant, store, "b".repeat(64), actor, `sale-${saleId}`],
  );
  for (const [i, returnId] of returnIds.entries()) {
    await pg().admin.query(
      `INSERT INTO sale_returns
         (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code,
          return_total, source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, '2026-10-05', 'EGP', 25, 'pos', $8, $6, $7)`,
      [returnId, saleId, tenant, store, i + 1, "c".repeat(64), actor, `return-${returnId}`],
    );
  }
}

/** Runs `fn` on an app-role client inside tenant A's RLS context, then rolls back. */
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

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0036-shift-cash-up.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0036(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-17 A', 'rt17-a'), ($2, 'RT-17 B', 'rt17-b')`,
    [TENANT_A, TENANT_B],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $4, 'a1', 'A1'), ($2, $4, 'a2', 'A2'), ($3, $5, 'b1', 'B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await env.admin.query(
    `INSERT INTO users (id, email) VALUES ($1, 'a@rt17.example'), ($2, 'b@rt17.example')`,
    [USER_A, USER_B],
  );
  await env.admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES
       ($1, $5, $6, decode(repeat('a1', 32), 'hex')),
       ($2, $5, $6, decode(repeat('a2', 32), 'hex')),
       ($3, $5, $7, decode(repeat('a3', 32), 'hex')),
       ($4, $8, $9, decode(repeat('b1', 32), 'hex'))`,
    [DEVICE_A1, DEVICE_A1_OTHER, DEVICE_A2, DEVICE_B1, TENANT_A, STORE_A1, STORE_A2, TENANT_B, STORE_B1],
  );
  // A pre-0036 shift written by the audit-ingest `shift.open` path.
  await env.admin.query(
    `INSERT INTO shifts
       (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
     VALUES ($1, $2, $3, $4, $5, '2026-10-04T08:00:00Z')`,
    [LEGACY_SHIFT, TENANT_A, STORE_A1, USER_A, DEVICE_A1],
  );
  await env.admin.query(readFileSync(UP_PATH, "utf8"));
  await ensureAppRole(env);
  await seedSaleAndReturn(SALE_A1, [RETURN_A1, RETURN_A1_SECOND], TENANT_A, STORE_A1, USER_A);
  await seedSaleAndReturn(SALE_A2, [RETURN_A2], TENANT_A, STORE_A2, USER_A);
  await seedSaleAndReturn(SALE_B1, [RETURN_B1], TENANT_B, STORE_B1, USER_B);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (skip()) return;
  // The fact tables are append-only for every role, the owner included, so
  // the cleanup disables their triggers for the duration of the delete.
  await pg().admin.query(`
    BEGIN;
    ALTER TABLE shift_refund_claims DISABLE TRIGGER USER;
    ALTER TABLE shift_closes DISABLE TRIGGER USER;
    ALTER TABLE shift_cash_movements DISABLE TRIGGER USER;
    ALTER TABLE shifts DISABLE TRIGGER USER;
    DELETE FROM shift_refund_claims;
    DELETE FROM shift_closes;
    DELETE FROM shift_cash_movements;
    DELETE FROM shifts WHERE source = 'cash_up';
    ALTER TABLE shift_refund_claims ENABLE TRIGGER USER;
    ALTER TABLE shift_closes ENABLE TRIGGER USER;
    ALTER TABLE shift_cash_movements ENABLE TRIGGER USER;
    ALTER TABLE shifts ENABLE TRIGGER USER;
    COMMIT;
  `);
});

describe("0036 — the shifts table", () => {
  it("keeps the pre-0036 audit-ingest shift as a legacy row with no cash-up fields", async () => {
    if (skip()) return;
    const r = await pg().admin.query(
      `SELECT source, currency_code, opening_float, business_date, received_at,
              recorded_by_user_id, payload_hash, lifecycle_state
         FROM shifts WHERE shift_id = $1`,
      [LEGACY_SHIFT],
    );
    expect(r.rows[0]).toEqual({
      source: "legacy",
      currency_code: null,
      opening_float: null,
      business_date: null,
      received_at: null,
      recorded_by_user_id: null,
      payload_hash: null,
      lifecycle_state: "open",
    });
  });

  it("the audit-ingest insert (no new columns) still lands as a legacy row", async () => {
    if (skip()) return;
    const id = randomUUID();
    await pg().admin.query(
      `INSERT INTO shifts
         (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (shift_id) DO NOTHING`,
      [id, TENANT_A, STORE_A1, USER_A, DEVICE_A2],
    );
    const r = await pg().admin.query(`SELECT source FROM shifts WHERE shift_id = $1`, [id]);
    expect(r.rows[0]).toEqual({ source: "legacy" });
    await pg().admin.query(`DELETE FROM shifts WHERE shift_id = $1`, [id]);
  });

  it("accepts a complete cash_up row", async () => {
    if (skip()) return;
    const id = await insertShift();
    const r = await pg().admin.query(
      `SELECT source, currency_code, opening_float::text AS opening_float FROM shifts WHERE shift_id = $1`,
      [id],
    );
    expect(r.rows[0]).toEqual({ source: "cash_up", currency_code: "EGP", opening_float: "500.0000" });
  });

  it("rejects an unknown source (shifts_source_valid)", async () => {
    if (skip()) return;
    // CHECKs are evaluated in name order, so a field CHECK may report first;
    // the refusal is a 23514 either way, and the source CHECK is pinned below.
    await expect(insertShift({ source: "manual" })).rejects.toMatchObject({ code: "23514" });
    const def = await pg().admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'shifts_source_valid'`,
    );
    expect(def.rows[0]?.def).toMatch(/source = ANY \(ARRAY\['legacy'::text, 'cash_up'::text\]\)/);
  });

  it.each<[string, ShiftInput, RegExp]>([
    ["a cash_up row without a currency", { currency: null }, /shifts_cash_up_fields_present/],
    ["a cash_up row without a float", { openingFloat: null }, /shifts_cash_up_fields_present/],
    ["a cash_up row without a business date", { businessDate: null }, /shifts_cash_up_fields_present/],
    ["a cash_up row without a receipt time", { receivedAt: null }, /shifts_cash_up_fields_present/],
    ["a cash_up row without an actor", { recordedBy: null }, /shifts_cash_up_fields_present/],
    ["a cash_up row without a payload hash", { payloadHash: null }, /shifts_cash_up_fields_present/],
    ["a legacy row with cash-up fields", { source: "legacy" }, /shifts_legacy_fields_absent/],
    ["a lowercase currency", { currency: "egp" }, /shifts_currency_code_format/],
    ["a negative float", { openingFloat: "-0.01" }, /shifts_opening_float_non_negative/],
    ["a short payload hash", { payloadHash: Buffer.from("short") }, /shifts_payload_hash_len/],
  ])("rejects %s", async (_label, input, error) => {
    if (skip()) return;
    await expect(insertShift(input)).rejects.toThrow(error);
  });
});

describe("0036 — one open cash_up shift per device (uq_shifts_cash_up_open_device)", () => {
  it("rejects a second open shift on the same device", async () => {
    if (skip()) return;
    await insertShift();
    await expect(insertShift()).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_shifts_cash_up_open_device",
    });
  });

  it("allows a new open shift once the previous one is closed", async () => {
    if (skip()) return;
    const first = await insertShift();
    await closeShift(first);
    await insertShift();
  });

  it("allows open shifts on other devices, and ignores legacy open rows", async () => {
    if (skip()) return;
    // LEGACY_SHIFT is open on DEVICE_A1 and never counts.
    await insertShift();
    await insertShift({ device: DEVICE_A1_OTHER });
    await insertShift({ store: STORE_A2, device: DEVICE_A2 });
    await insertShift({ tenant: TENANT_B, store: STORE_B1, device: DEVICE_B1, user: USER_B });
  });
});

describe("0036 — the shifts guard trigger", () => {
  it("closes a cash_up shift once its normal close is recorded", async () => {
    if (skip()) return;
    const id = await insertShift();
    await closeShift(id);
    const r = await pg().admin.query(`SELECT lifecycle_state FROM shifts WHERE shift_id = $1`, [id]);
    expect(r.rows[0]).toEqual({ lifecycle_state: "closed" });
  });

  it("closes a cash_up shift as closed_forced once its forced close is recorded", async () => {
    if (skip()) return;
    const id = await insertShift();
    await closeShift(id, { kind: "forced", forcedReason: "Cashier left" });
    const r = await pg().admin.query(`SELECT lifecycle_state FROM shifts WHERE shift_id = $1`, [id]);
    expect(r.rows[0]).toEqual({ lifecycle_state: "closed_forced" });
  });

  it("refuses to close a cash_up shift without its close", async () => {
    if (skip()) return;
    const id = await insertShift();
    await expect(
      pg().admin.query(`UPDATE shifts SET lifecycle_state = 'closed' WHERE shift_id = $1`, [id]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a closed state that does not match the close kind", async () => {
    if (skip()) return;
    const id = await insertShift();
    await insertCloseRow(id);
    await expect(
      pg().admin.query(`UPDATE shifts SET lifecycle_state = 'closed_forced' WHERE shift_id = $1`, [id]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses to reopen, re-close or change another column of a cash_up shift", async () => {
    if (skip()) return;
    const id = await insertShift();
    await expect(
      pg().admin.query(`UPDATE shifts SET opening_float = 1 WHERE shift_id = $1`, [id]),
    ).rejects.toMatchObject({ code: "42501" });
    await closeShift(id);
    for (const sql of [
      `UPDATE shifts SET lifecycle_state = 'open' WHERE shift_id = $1`,
      `UPDATE shifts SET lifecycle_state = 'closed' WHERE shift_id = $1`,
      `UPDATE shifts SET opened_at = now() WHERE shift_id = $1`,
    ]) {
      await expect(pg().admin.query(sql, [id])).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("refuses to change the closing state together with another column", async () => {
    if (skip()) return;
    const id = await insertShift();
    await insertCloseRow(id);
    await expect(
      pg().admin.query(
        `UPDATE shifts SET lifecycle_state = 'closed', opened_at = now() WHERE shift_id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("never changes source, in either direction", async () => {
    if (skip()) return;
    const id = await insertShift();
    await expect(
      pg().admin.query(`UPDATE shifts SET source = 'legacy' WHERE shift_id = $1`, [id]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      pg().admin.query(`UPDATE shifts SET source = 'cash_up' WHERE shift_id = $1`, [LEGACY_SHIFT]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("never deletes a cash_up shift, even as the owner", async () => {
    if (skip()) return;
    const id = await insertShift();
    await expect(
      pg().admin.query(`DELETE FROM shifts WHERE shift_id = $1`, [id]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses TRUNCATE of shifts", async () => {
    if (skip()) return;
    await expect(pg().admin.query(`TRUNCATE shifts CASCADE`)).rejects.toMatchObject({ code: "42501" });
  });

  it("leaves legacy rows as before: updatable and deletable", async () => {
    if (skip()) return;
    const id = randomUUID();
    await pg().admin.query(
      `INSERT INTO shifts
         (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [id, TENANT_A, STORE_A1, USER_A, DEVICE_A1],
    );
    await pg().admin.query(`UPDATE shifts SET lifecycle_state = 'closed' WHERE shift_id = $1`, [id]);
    await pg().admin.query(`DELETE FROM shifts WHERE shift_id = $1`, [id]);
  });
});

describe("0036 — shift_closes", () => {
  it.each<[string, CloseInput, RegExp]>([
    ["a wrong expected cash", { expected: "2755.01", variance: "-5.01" }, /shift_closes_expected_cash_arithmetic/],
    ["a wrong variance", { variance: "5.00" }, /shift_closes_variance_arithmetic/],
    ["a negative amount", { payIn: "-1.00", expected: "2754.00", variance: "-4.00" }, /shift_closes_amounts_non_negative/],
    ["a negative sale count", { saleCount: -1 }, /shift_closes_sale_count_non_negative/],
    ["an unknown close kind", { kind: "abandoned" }, /shift_closes_close_kind_valid/],
    ["a forced close without a reason", { kind: "forced" }, /shift_closes_forced_reason_iff_forced/],
    ["a normal close with a reason", { forcedReason: "x" }, /shift_closes_forced_reason_iff_forced/],
    ["an empty forced reason", { kind: "forced", forcedReason: "" }, /shift_closes_forced_reason_length/],
    ["a 201-character forced reason", { kind: "forced", forcedReason: "r".repeat(201) }, /shift_closes_forced_reason_length/],
    ["a short payload hash", { payloadHash: Buffer.from("short") }, /shift_closes_payload_hash_len/],
  ])("rejects %s", async (_label, input, error) => {
    if (skip()) return;
    const id = await insertShift();
    await expect(insertCloseRow(id, input)).rejects.toThrow(error);
  });

  it("checks the arithmetic in exact numeric (no float rounding)", async () => {
    if (skip()) return;
    const id = await insertShift({ openingFloat: "0.1000" });
    await insertCloseRow(id, {
      openingFloat: "0.1000",
      cashSales: "0.2000",
      cashRefunds: "0.0000",
      payIn: "0.0000",
      payOut: "0.0000",
      expected: "0.3000",
      counted: "0.3000",
      variance: "0.0000",
    });
  });

  it.each<[string, CloseInput]>([
    ["an opening float other than the one recorded at open", { openingFloat: "499.00", expected: "2754.00", variance: "-4.00" }],
    ["another currency", { currency: "USD" }],
    ["another device", { device: DEVICE_A1_OTHER }],
    ["another store", { store: STORE_A2 }],
    ["another tenant", { tenant: TENANT_B }],
  ])("refuses a close with %s (fk_shift_closes_shift)", async (_label, input) => {
    if (skip()) return;
    const id = await insertShift();
    await expect(insertCloseRow(id, input)).rejects.toThrow(/fk_shift_closes_shift/);
  });

  it("can never reference a legacy shift", async () => {
    if (skip()) return;
    await expect(insertCloseRow(LEGACY_SHIFT)).rejects.toThrow(/fk_shift_closes_shift/);
  });

  it("records one close per shift", async () => {
    if (skip()) return;
    const id = await insertShift();
    await insertCloseRow(id);
    await expect(insertCloseRow(id)).rejects.toMatchObject({ code: "23505" });
  });
});

describe("0036 — shift_cash_movements", () => {
  it("records a movement on an open shift", async () => {
    if (skip()) return;
    const id = await insertShift();
    await insertMovement(id);
    await insertMovement(id, { kind: "pay_in", reason: "float_top_up", note: null, amount: "0.0001" });
  });

  it("refuses a movement once the shift is closed (55000)", async () => {
    if (skip()) return;
    const id = await insertShift();
    await closeShift(id);
    await expect(insertMovement(id)).rejects.toMatchObject({ code: "55000" });
  });

  it.each<[string, MovementInput, RegExp]>([
    ["a zero amount", { amount: "0" }, /shift_cash_movements_amount_positive/],
    ["an unknown kind", { kind: "drop" }, /shift_cash_movements_kind_valid/],
    ["an unknown reason", { reason: "tip" }, /shift_cash_movements_reason_code_valid/],
    ["an empty note", { note: "" }, /shift_cash_movements_note_length/],
    ["a 201-character note", { note: "n".repeat(201) }, /shift_cash_movements_note_length/],
  ])("rejects %s", async (_label, input, error) => {
    if (skip()) return;
    const id = await insertShift();
    await expect(insertMovement(id, input)).rejects.toThrow(error);
  });

  it.each<[string, MovementInput]>([
    ["another currency", { currency: "USD" }],
    ["another device", { device: DEVICE_A1_OTHER }],
    ["another store", { store: STORE_A2 }],
    ["another tenant", { tenant: TENANT_B }],
  ])("refuses a movement with %s (fk_shift_cash_movements_shift)", async (_label, input) => {
    if (skip()) return;
    const id = await insertShift();
    await expect(insertMovement(id, input)).rejects.toThrow(/fk_shift_cash_movements_shift/);
  });

  it("can never reference a legacy shift", async () => {
    if (skip()) return;
    await expect(insertMovement(LEGACY_SHIFT)).rejects.toThrow(/fk_shift_cash_movements_shift/);
  });
});

describe("0036 — shift_refund_claims", () => {
  it("claims returns of the close's tenant and store, in order", async () => {
    if (skip()) return;
    const id = await insertShift();
    await insertCloseRow(id);
    await insertClaim(id, RETURN_A1, { ordinal: 0 });
    await insertClaim(id, RETURN_A1_SECOND, { ordinal: 1 });
  });

  it("a return is claimed by at most one shift's close", async () => {
    if (skip()) return;
    const first = await insertShift();
    await closeShift(first);
    await insertClaim(first, RETURN_A1);
    const second = await insertShift();
    await insertCloseRow(second);
    await expect(insertClaim(second, RETURN_A1)).rejects.toMatchObject({
      code: "23505",
      constraint: "shift_refund_claims_pkey",
    });
  });

  it("refuses a return of another store or another tenant (fk_shift_refund_claims_return)", async () => {
    if (skip()) return;
    const id = await insertShift();
    await insertCloseRow(id);
    await expect(insertClaim(id, RETURN_A2)).rejects.toThrow(/fk_shift_refund_claims_return/);
    await expect(insertClaim(id, RETURN_B1)).rejects.toThrow(/fk_shift_refund_claims_return/);
  });

  it("refuses a claim without a recorded close (fk_shift_refund_claims_close)", async () => {
    if (skip()) return;
    const id = await insertShift();
    await expect(insertClaim(id, RETURN_A1)).rejects.toThrow(/fk_shift_refund_claims_close/);
  });

  it("orders the claims of one close uniquely", async () => {
    if (skip()) return;
    const id = await insertShift();
    await insertCloseRow(id);
    await insertClaim(id, RETURN_A1, { ordinal: 0 });
    await expect(insertClaim(id, RETURN_A1_SECOND, { ordinal: 0 })).rejects.toThrow(
      /uq_shift_refund_claims_shift_ordinal/,
    );
    await expect(insertClaim(id, RETURN_A1_SECOND, { ordinal: -1 })).rejects.toThrow(
      /shift_refund_claims_ordinal_non_negative/,
    );
  });
});

describe("0036 — the fact tables are append-only for every role", () => {
  it.each([
    ["shift_closes", "UPDATE shift_closes SET sale_count = 0"],
    ["shift_closes", "DELETE FROM shift_closes"],
    ["shift_closes", "TRUNCATE shift_closes CASCADE"],
    ["shift_cash_movements", "UPDATE shift_cash_movements SET note = 'x'"],
    ["shift_cash_movements", "DELETE FROM shift_cash_movements"],
    ["shift_cash_movements", "TRUNCATE shift_cash_movements"],
    ["shift_refund_claims", "UPDATE shift_refund_claims SET ordinal = 5"],
    ["shift_refund_claims", "DELETE FROM shift_refund_claims"],
    ["shift_refund_claims", "TRUNCATE shift_refund_claims"],
  ])("%s: `%s` raises 42501 even as the owner", async (_table, sql) => {
    if (skip()) return;
    const id = await insertShift();
    await insertMovement(id);
    await insertCloseRow(id);
    await insertClaim(id, RETURN_A1);
    await expect(pg().admin.query(sql)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("0036 — RLS", () => {
  it.each([...FACT_TABLES])("%s is RLS enabled and forced, with SELECT and INSERT policies only", async (table) => {
    if (skip()) return;
    const rls = await pg().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [table],
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await pg().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = $1 ORDER BY cmd`,
      [table],
    );
    expect(policies.rows.map((p) => p.cmd)).toEqual(["INSERT", "SELECT"]);
  });

  it("the app role in tenant A sees nothing of tenant B's shifts, movements, closes or claims", async () => {
    if (skip()) return;
    const theirs = await insertShift({ tenant: TENANT_B, store: STORE_B1, device: DEVICE_B1, user: USER_B });
    await pg().admin.query(
      `INSERT INTO shift_cash_movements
         (id, shift_id, tenant_id, store_id, device_id, currency_code, kind, amount, reason_code,
          occurred_at, recorded_by_user_id, payload_hash)
       VALUES ($1, $2, $3, $4, $5, 'EGP', 'pay_in', 1, 'other', now(), $6, $7)`,
      [randomUUID(), theirs, TENANT_B, STORE_B1, DEVICE_B1, USER_B, digest("m")],
    );
    await insertCloseRow(theirs, { tenant: TENANT_B, store: STORE_B1, device: DEVICE_B1, user: USER_B });
    await insertClaim(theirs, RETURN_B1, { tenant: TENANT_B, store: STORE_B1 });
    const mine = await insertShift();

    await asTenant(TENANT_A, async (client) => {
      const shifts = await client.query<{ shift_id: string }>(
        `SELECT shift_id FROM shifts WHERE source = 'cash_up'`,
      );
      expect(shifts.rows.map((r) => r.shift_id)).toEqual([mine]);
      for (const table of FACT_TABLES) {
        expect((await client.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
      }
    });
  });

  it("the app role in tenant A cannot insert tenant-B facts", async () => {
    if (skip()) return;
    const theirs = await insertShift({ tenant: TENANT_B, store: STORE_B1, device: DEVICE_B1, user: USER_B });
    await asTenant(TENANT_A, async (client) => {
      await client.query("SAVEPOINT s");
      await expect(
        insertMovementVia(client, theirs, TENANT_B, STORE_B1, DEVICE_B1, USER_B),
      ).rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK TO SAVEPOINT s");
      await expect(
        insertCloseRow(theirs, { tenant: TENANT_B, store: STORE_B1, device: DEVICE_B1, user: USER_B }, client),
      ).rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK TO SAVEPOINT s");
    });
  });

  it("the app role can insert its own tenant's facts and close its shift", async () => {
    if (skip()) return;
    const mine = await insertShift();
    await asTenant(TENANT_A, async (client) => {
      await insertMovementVia(client, mine, TENANT_A, STORE_A1, DEVICE_A1, USER_A);
      await insertCloseRow(mine, {}, client);
      await client.query(
        `INSERT INTO shift_refund_claims (return_id, shift_id, tenant_id, store_id, ordinal)
         VALUES ($1, $2, $3, $4, 0)`,
        [RETURN_A1, mine, TENANT_A, STORE_A1],
      );
      const upd = await client.query(
        `UPDATE shifts SET lifecycle_state = 'closed' WHERE shift_id = $1`,
        [mine],
      );
      expect(upd.rowCount).toBe(1);
    });
  });

  it("without a tenant GUC the app role sees no fact", async () => {
    if (skip()) return;
    const id = await insertShift();
    await insertMovement(id);
    await insertCloseRow(id);
    for (const table of FACT_TABLES) {
      expect((await pg().app.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
    }
  });
});

async function insertMovementVia(
  client: PoolClient,
  shiftId: string,
  tenant: string,
  store: string,
  device: string,
  user: string,
): Promise<void> {
  await client.query(
    `INSERT INTO shift_cash_movements
       (id, shift_id, tenant_id, store_id, device_id, currency_code, kind, amount, reason_code,
        occurred_at, recorded_by_user_id, payload_hash)
     VALUES ($1, $2, $3, $4, $5, 'EGP', 'pay_in', 1, 'other', now(), $6, $7)`,
    [randomUUID(), shiftId, tenant, store, device, user, digest("m")],
  );
}

describe("0036 — the sales recompute index", () => {
  it("indexes sales on (tenant_id, device_id, occurred_at)", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_sales_tenant_device_occurred'`,
    );
    expect(r.rows[0]?.indexdef).toMatch(/\(tenant_id, device_id, occurred_at\)/);
  });
});

describe("0036 — down → up round-trip", () => {
  it("down removes the fact tables, the guard and the columns; up re-applies them", async () => {
    if (skip()) return;
    const tables = async (): Promise<number> =>
      (
        await pg().admin.query(
          `SELECT 1 FROM information_schema.tables WHERE table_name = ANY($1::text[])`,
          [[...FACT_TABLES]],
        )
      ).rowCount ?? 0;
    const columns = async (): Promise<number> =>
      (
        await pg().admin.query(
          `SELECT 1 FROM information_schema.columns
            WHERE table_name = 'shifts'
              AND column_name IN ('source', 'currency_code', 'opening_float', 'business_date',
                                  'received_at', 'recorded_by_user_id', 'payload_hash')`,
        )
      ).rowCount ?? 0;
    const guards = async (): Promise<number> =>
      (
        await pg().admin.query(
          `SELECT 1 FROM pg_trigger WHERE tgname LIKE 'shifts_cash_up_guard%'`,
        )
      ).rowCount ?? 0;

    // A recorded cash-up history does not block the rollback.
    const id = await insertShift();
    await insertMovement(id);
    await closeShift(id);

    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    expect(await tables()).toBe(0);
    expect(await columns()).toBe(0);
    expect(await guards()).toBe(0);
    const legacy = await pg().admin.query(`SELECT 1 FROM shifts WHERE shift_id = $1`, [LEGACY_SHIFT]);
    expect(legacy.rowCount).toBe(1);
    // The cash-up row survives as a lifecycle row; remove it so up starts clean.
    await pg().admin.query(`DELETE FROM shifts WHERE shift_id = $1`, [id]);

    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    await ensureAppRole(pg());
    expect(await tables()).toBe(3);
    expect(await columns()).toBe(7);
    expect(await guards()).toBe(2);
  });
});
