/**
 * 0035 — cashier admissions + their idempotency store (RT-113 BC2).
 *
 * Applies every migration before 0035 against a real Postgres, applies 0035,
 * then proves:
 *   - both tables are RLS enabled + forced, with the expected policies
 *     (admissions: SELECT / INSERT / UPDATE, no DELETE; requests: + DELETE);
 *   - the single-active rule lives in the database: a second LIVE admission
 *     for the same (tenant, store, user) is a 23505, while an ended one, the
 *     same user in another store, and another user are all fine;
 *   - the CHECKs: mode, end_reason, ended ⇔ reason, offline time only on
 *     reconcile, a valid window, no self-takeover, 32-byte digests;
 *   - the (tenant, store) composite FK refuses a store of another tenant;
 *   - under the NOBYPASSRLS app role, tenant A sees, updates and deletes
 *     nothing of tenant B, and cannot insert a tenant-B row;
 *   - down → up round-trips cleanly.
 *
 * Fresh install (the whole chain from empty) is covered by the migrate CLI
 * spec's EXPECTED_MIGRATIONS ledger.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0035_cashier_admissions.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0035_cashier_admissions.down.sql");

const TENANT_A = "0a000000-0000-7000-8000-000000035a01";
const TENANT_B = "0b000000-0000-7000-8000-000000035b01";
const STORE_A1 = "0a000000-0000-7000-8000-000000035a02";
const STORE_A2 = "0a000000-0000-7000-8000-000000035a03";
const STORE_B1 = "0b000000-0000-7000-8000-000000035b02";
const USER_1 = "0a000000-0000-7000-8000-000000035a04";
const USER_2 = "0a000000-0000-7000-8000-000000035a05";
const DEVICE_A = "0a000000-0000-7000-8000-000000035a06";
const DEVICE_B = "0b000000-0000-7000-8000-000000035b06";

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const skip = (): boolean => env === null;

async function applyBefore0035(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
}

interface AdmissionInput {
  id?: string;
  tenant?: string;
  store?: string;
  user?: string;
  device?: string;
  mode?: string;
  offlineAdmittedAt?: string | null;
  takeoverOf?: string | null;
  endedAt?: string | null;
  endReason?: string | null;
  expiresIn?: string;
}

async function insertAdmission(input: AdmissionInput = {}): Promise<string> {
  const id = input.id ?? randomUUID();
  await pg().admin.query(
    `INSERT INTO cashier_admissions
       (id, tenant_id, store_id, user_id, device_id, mode, offline_admitted_at,
        takeover_of, expires_at, ended_at, end_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + $9::interval, $10, $11)`,
    [
      id,
      input.tenant ?? TENANT_A,
      input.store ?? STORE_A1,
      input.user ?? USER_1,
      input.device ?? DEVICE_A,
      input.mode ?? "online",
      input.offlineAdmittedAt ?? null,
      input.takeoverOf ?? null,
      input.expiresIn ?? "12 hours",
      input.endedAt ?? null,
      input.endReason ?? null,
    ],
  );
  return id;
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

async function insertRequest(
  admissionId: string,
  opts: { tenant?: string; device?: string; key?: string; keyHash?: Buffer } = {},
): Promise<void> {
  await pg().admin.query(
    `INSERT INTO cashier_admission_requests
       (tenant_id, device_id, key_hash, request_hash, admission_id, response_body, expires_at)
     VALUES ($1, $2, $3, $4, $5, '{"kind":"admitted"}'::jsonb, now() + interval '12 hours')`,
    [
      opts.tenant ?? TENANT_A,
      opts.device ?? DEVICE_A,
      opts.keyHash ?? digest(opts.key ?? randomUUID()),
      digest("body"),
      admissionId,
    ],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0035-cashier-admissions.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0035(env);
  await env.admin.query(readFileSync(UP_PATH, "utf8"));
  await ensureAppRole(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-113 A', 'rt113-a'), ($2, 'RT-113 B', 'rt113-b')`,
    [TENANT_A, TENANT_B],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $4, 'a1', 'A1'), ($2, $4, 'a2', 'A2'), ($3, $5, 'b1', 'B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await env.admin.query(
    `INSERT INTO users (id, email) VALUES ($1, 'u1@rt113.example'), ($2, 'u2@rt113.example')`,
    [USER_1, USER_2],
  );
  await env.admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES
       ($1, $3, $4, decode(repeat('a1', 32), 'hex')),
       ($2, $5, $6, decode(repeat('b1', 32), 'hex'))`,
    [DEVICE_A, DEVICE_B, TENANT_A, STORE_A1, TENANT_B, STORE_B1],
  );
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (skip()) return;
  await pg().admin.query("DELETE FROM cashier_admission_requests");
  await pg().admin.query("DELETE FROM cashier_admissions");
});

describe("0035 — RLS", () => {
  it.each(["cashier_admissions", "cashier_admission_requests"])("%s is RLS enabled and forced", async (table) => {
    if (skip()) return;
    const r = await pg().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [table],
    );
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("admissions have SELECT / INSERT / UPDATE policies and no DELETE (ended, never removed)", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = 'cashier_admissions' ORDER BY cmd`,
    );
    expect(r.rows.map((x) => x.cmd)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("the replay store also has a DELETE policy (expired entries are purged)", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = 'cashier_admission_requests' ORDER BY cmd`,
    );
    expect(r.rows.map((x) => x.cmd)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
  });

  it("the app role in tenant A sees, changes and deletes nothing of tenant B", async () => {
    if (skip()) return;
    const theirs = await insertAdmission({ tenant: TENANT_B, store: STORE_B1, device: DEVICE_B });
    await insertRequest(theirs, { tenant: TENANT_B, device: DEVICE_B });
    const mine = await insertAdmission();
    const client = await pg().app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [TENANT_A]);
      await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
      const seen = await client.query<{ id: string }>("SELECT id FROM cashier_admissions");
      expect(seen.rows.map((r) => r.id)).toEqual([mine]);
      expect((await client.query("SELECT 1 FROM cashier_admission_requests")).rowCount).toBe(0);
      const upd = await client.query(
        "UPDATE cashier_admissions SET ended_at = now(), end_reason = 'device_end' WHERE id = $1",
        [theirs],
      );
      expect(upd.rowCount).toBe(0);
      expect((await client.query("DELETE FROM cashier_admission_requests")).rowCount).toBe(0);
      // No DELETE policy on admissions: even its own rows cannot be removed.
      expect((await client.query("DELETE FROM cashier_admissions WHERE id = $1", [mine])).rowCount).toBe(0);
      await client.query("SAVEPOINT cross_insert");
      await expect(
        client.query(
          `INSERT INTO cashier_admissions (id, tenant_id, store_id, user_id, device_id, mode, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'online', now() + interval '1 hour')`,
          [randomUUID(), TENANT_B, STORE_B1, USER_2, DEVICE_B],
        ),
      ).rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK TO SAVEPOINT cross_insert");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("without a tenant GUC the app role sees nothing", async () => {
    if (skip()) return;
    await insertAdmission();
    const r = await pg().app.query("SELECT 1 FROM cashier_admissions");
    expect(r.rowCount).toBe(0);
  });
});

describe("0035 — the single-active rule (uq_cashier_admissions_live)", () => {
  it("rejects a second live admission for the same (tenant, store, user)", async () => {
    if (skip()) return;
    await insertAdmission();
    await expect(insertAdmission()).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_cashier_admissions_live",
    });
  });

  it("allows a new live admission once the previous one is ended", async () => {
    if (skip()) return;
    const prior = await insertAdmission({ endedAt: new Date().toISOString(), endReason: "takeover" });
    await insertAdmission({ takeoverOf: prior });
  });

  it("allows the same user live in another store, and another user in the same store", async () => {
    if (skip()) return;
    await insertAdmission();
    await insertAdmission({ store: STORE_A2 });
    await insertAdmission({ user: USER_2 });
  });
});

describe("0035 — constraints", () => {
  it.each<[string, AdmissionInput, RegExp]>([
    ["an unknown mode", { mode: "offline" }, /cashier_admissions_mode_valid/],
    ["an unknown end_reason", { endedAt: new Date().toISOString(), endReason: "logout" }, /cashier_admissions_end_reason_valid/],
    ["ended without a reason", { endedAt: new Date().toISOString() }, /cashier_admissions_ended_has_reason/],
    ["a reason without ended_at", { endReason: "takeover" }, /cashier_admissions_ended_has_reason/],
    ["offline time on an online admission", { offlineAdmittedAt: "2026-10-04T08:00:00Z" }, /cashier_admissions_offline_time_reconcile_only/],
    ["an expiry before the grant", { expiresIn: "-1 second" }, /cashier_admissions_window_valid/],
    ["a store of another tenant", { store: STORE_B1 }, /fk_cashier_admissions_store_tenant/],
  ])("rejects %s", async (_label, input, error) => {
    if (skip()) return;
    await expect(insertAdmission(input)).rejects.toThrow(error);
  });

  it("accepts the reconcile provenance and rejects a self-takeover", async () => {
    if (skip()) return;
    await insertAdmission({ mode: "reconcile_offline", offlineAdmittedAt: "2026-10-04T08:00:00Z" });
    const id = randomUUID();
    await expect(insertAdmission({ id, user: USER_2, takeoverOf: id })).rejects.toThrow(
      /cashier_admissions_takeover_not_self/,
    );
  });

  it("the replay store is unique per (tenant, device, key digest) and takes 32-byte digests only", async () => {
    if (skip()) return;
    const admission = await insertAdmission();
    await insertRequest(admission, { key: "k1" });
    await expect(insertRequest(admission, { key: "k1" })).rejects.toThrow(/uq_cashier_admission_requests_key/);
    await expect(insertRequest(admission, { keyHash: Buffer.from("short") })).rejects.toThrow(
      /cashier_admission_requests_key_hash_len/,
    );
  });
});

describe("0035 — down → up round-trip", () => {
  it("down removes both tables; up re-applies them", async () => {
    if (skip()) return;
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    const gone = await pg().admin.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_name IN ('cashier_admissions', 'cashier_admission_requests')`,
    );
    expect(gone.rowCount).toBe(0);
    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    await ensureAppRole(pg());
    const back = await pg().admin.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_name IN ('cashier_admissions', 'cashier_admission_requests')`,
    );
    expect(back.rowCount).toBe(2);
  });
});
