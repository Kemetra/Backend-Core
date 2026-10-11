/**
 * 0040_device_lifecycle — migration spec (RT-364, RT-287 F1).
 *
 * Seeds an active device and a legacy revoked device BEFORE 0040 runs, then:
 *   - every existing device gets expires_at = migration time + 90 days, and a
 *     device inserted the way the current pairing path does (no expires_at)
 *     gets its own insert time + 90 days;
 *   - the legacy revoked device keeps a NULL reason (not recorded, never
 *     guessed), and a reason-less SQL revoke still works, so the interim lab
 *     procedure and existing fixtures keep working until RT-365 makes the
 *     reason mandatory at the API;
 *   - each CHECK refuses the shape it guards and accepts a valid revoke, a
 *     rotation overlap and a retire;
 *   - pairing_codes gains a nullable replaces_device_id with no FK to devices;
 *   - down removes everything (revoked_at is kept); up re-applies cleanly.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0040_device_lifecycle.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0040_device_lifecycle.down.sql");

const TENANT = "0a000000-0000-7000-8000-000000040a01";
const STORE = "0a000000-0000-7000-8000-000000040a02";
const ACTOR = "0a000000-0000-7000-8000-000000040a03";
const DEVICE_ACTIVE = "0a000000-0000-7000-8000-000000040a10";
const DEVICE_LEGACY_REVOKED = "0a000000-0000-7000-8000-000000040a11";
const DEVICE_NEW = "0a000000-0000-7000-8000-000000040a12";

const LIFECYCLE_COLUMNS = [
  "expires_at",
  "last_seen_at",
  "previous_token_hash",
  "previous_valid_until",
  "retire_reason",
  "retired_at",
  "retired_by",
  "revoke_note",
  "revoke_reason",
  "revoked_by",
];

let env: PgTestEnv | null = null;
let migratedAt: Date;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function applyBefore0040(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
}

let hashSeq = 0;
function freshHash(): Buffer {
  hashSeq += 1;
  return Buffer.from(hashSeq.toString(16).padStart(64, "0"), "hex");
}

/** The INSERT shape the current pairing path uses (pairing.repository.ts). */
async function insertDevice(id: string, revoked = false): Promise<void> {
  await pg().admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, revoked_at)
     VALUES ($1, $2, $3, 'Till', $4, $5)`,
    [id, TENANT, STORE, freshHash(), revoked ? new Date() : null],
  );
}

async function device(id: string): Promise<Record<string, unknown>> {
  const r = await pg().admin.query(`SELECT * FROM devices WHERE id = $1`, [id]);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error(`device ${id} not found`);
  return row;
}

async function lifecycleColumns(): Promise<string[]> {
  const r = await pg().admin.query<{ c: string }>(
    `SELECT column_name AS c FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'devices'
        AND column_name = ANY($1) ORDER BY column_name`,
    [LIFECYCLE_COLUMNS],
  );
  return r.rows.map((row) => row.c);
}

/** Runs one UPDATE on DEVICE_ACTIVE inside a savepoint-free transaction. */
async function updateActive(setSql: string, params: unknown[] = []): Promise<void> {
  await pg().admin.query(`UPDATE devices SET ${setSql} WHERE id = $1`, [
    DEVICE_ACTIVE,
    ...params,
  ]);
}

beforeAll(async () => {
  env = await startPgEnv();
  await applyBefore0040(env);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code)
     VALUES ($1, 't0040', 'T0040', 'EGP')`,
    [TENANT],
  );
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S40', 'S40')`, [
    STORE,
    TENANT,
  ]);
  await insertDevice(DEVICE_ACTIVE);
  await insertDevice(DEVICE_LEGACY_REVOKED, true);
  migratedAt = (await a.query<{ t: Date }>(`SELECT now() AS t`)).rows[0]!.t;
  await a.query(readFileSync(UP_PATH, "utf8"));
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const TOLERANCE_MS = 5 * 60 * 1000;

describe("0040 — expiry backfill and default", () => {
  it("an existing device gets migration time + 90 days", async () => {
    const row = await device(DEVICE_ACTIVE);
    const expires = (row["expires_at"] as Date).getTime();
    expect(Math.abs(expires - (migratedAt.getTime() + NINETY_DAYS_MS))).toBeLessThan(
      TOLERANCE_MS,
    );
    expect(row["last_seen_at"]).toBeNull();
  });

  it("a device inserted by the current pairing shape gets insert time + 90 days", async () => {
    await insertDevice(DEVICE_NEW);
    const row = await device(DEVICE_NEW);
    const created = (row["created_at"] as Date).getTime();
    const expires = (row["expires_at"] as Date).getTime();
    expect(Math.abs(expires - (created + NINETY_DAYS_MS))).toBeLessThan(TOLERANCE_MS);
  });

  it("an active device has no revoke, rotation or retire data", async () => {
    const row = await device(DEVICE_ACTIVE);
    for (const col of [
      "revoked_by",
      "revoke_reason",
      "revoke_note",
      "previous_token_hash",
      "previous_valid_until",
      "retired_at",
      "retired_by",
      "retire_reason",
    ]) {
      expect(row[col]).toBeNull();
    }
  });
});

describe("0040 — legacy and reason-less revokes", () => {
  it("a revoke made before 0040 keeps a NULL reason, never a guessed one", async () => {
    const row = await device(DEVICE_LEGACY_REVOKED);
    expect(row["revoked_at"]).not.toBeNull();
    expect(row["revoke_reason"]).toBeNull();
    expect(row["revoke_note"]).toBeNull();
    expect(row["revoked_by"]).toBeNull();
  });

  it("a reason-less SQL revoke is still accepted (interim procedure until RT-365)", async () => {
    await pg().admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEVICE_NEW]);
    expect((await device(DEVICE_NEW))["revoke_reason"]).toBeNull();
    await pg().admin.query(`UPDATE devices SET revoked_at = NULL WHERE id = $1`, [DEVICE_NEW]);
  });
});

describe("0040 — CHECK constraints", () => {
  // Each refusal runs against DEVICE_ACTIVE (unrevoked) and leaves it unchanged.
  it.each([
    [
      "an unknown revoke reason",
      `revoked_at = now(), revoke_reason = 'misplaced'`,
      "devices_revoke_reason_valid",
    ],
    [
      "a reason on an unrevoked device",
      `revoke_reason = 'lost'`,
      "devices_revoke_attribution_when_revoked",
    ],
    [
      "revoke attribution on an unrevoked device",
      `revoked_by = '${ACTOR}'`,
      "devices_revoke_attribution_when_revoked",
    ],
    [
      "a blank revoke note",
      `revoked_at = now(), revoke_reason = 'lost', revoke_note = '   '`,
      "devices_revoke_note_shape",
    ],
    [
      "a revoke note over 500 characters",
      `revoked_at = now(), revoke_reason = 'lost', revoke_note = repeat('x', 501)`,
      "devices_revoke_note_shape",
    ],
    [
      "reason 'other' without a note",
      `revoked_at = now(), revoke_reason = 'other'`,
      "devices_revoke_other_requires_note",
    ],
    [
      "a previous token hash without its validity window",
      `previous_token_hash = '\\x01'::bytea`,
      "devices_previous_token_pair",
    ],
    [
      "a validity window without a previous token hash",
      `previous_valid_until = now()`,
      "devices_previous_token_pair",
    ],
    [
      "a retire on an unrevoked device",
      `retired_at = now(), retire_reason = 'decommissioned'`,
      "devices_retired_implies_revoked",
    ],
  ])("refuses %s", async (_label, setSql, constraint) => {
    await expect(updateActive(setSql)).rejects.toThrow(constraint);
    expect((await device(DEVICE_ACTIVE))["revoked_at"]).toBeNull();
  });

  it("refuses a retire with no reason, and retire fields without a retire", async () => {
    const a = pg().admin;
    await expect(
      a.query(`UPDATE devices SET retired_at = now() WHERE id = $1`, [DEVICE_LEGACY_REVOKED]),
    ).rejects.toThrow("devices_retire_fields_when_retired");
    await expect(
      a.query(`UPDATE devices SET retire_reason = 'x' WHERE id = $1`, [DEVICE_LEGACY_REVOKED]),
    ).rejects.toThrow("devices_retire_fields_when_retired");
  });

  it("refuses a previous token hash already used by another device", async () => {
    const a = pg().admin;
    await a.query(
      `UPDATE devices SET previous_token_hash = '\\xab'::bytea,
                          previous_valid_until = now() + interval '10 minutes'
        WHERE id = $1`,
      [DEVICE_NEW],
    );
    await expect(
      updateActive(
        `previous_token_hash = '\\xab'::bytea, previous_valid_until = now()`,
      ),
    ).rejects.toThrow("devices_previous_token_hash_uk");
  });

  it("accepts a security revoke, then a retire, on the same device", async () => {
    await updateActive(
      `revoked_at = now(), revoked_by = $2, revoke_reason = 'stolen',
       revoke_note = 'Taken from counter 2'`,
      [ACTOR],
    );
    await updateActive(`retired_at = now(), retired_by = $2, retire_reason = 'Written off'`, [
      ACTOR,
    ]);
    const row = await device(DEVICE_ACTIVE);
    expect(row).toMatchObject({
      revoke_reason: "stolen",
      revoked_by: ACTOR,
      retire_reason: "Written off",
      retired_by: ACTOR,
    });
  });

  it("accepts every reason in the D-Q3 enum on a revoked device", async () => {
    const reasons = [
      "lost",
      "stolen",
      "suspected_compromise",
      "hardware_failure",
      "replaced",
      "moved",
      "retired",
      "admin_error",
    ];
    for (const reason of reasons) {
      await pg().admin.query(`UPDATE devices SET revoke_reason = $2 WHERE id = $1`, [
        DEVICE_LEGACY_REVOKED,
        reason,
      ]);
    }
    await pg().admin.query(
      `UPDATE devices SET revoke_reason = 'other', revoke_note = 'Unknown' WHERE id = $1`,
      [DEVICE_LEGACY_REVOKED],
    );
    expect((await device(DEVICE_LEGACY_REVOKED))["revoke_reason"]).toBe("other");
  });
});

describe("0040 — pairing_codes.replaces_device_id", () => {
  it("is a nullable uuid with no FK onto devices", async () => {
    const col = await pg().admin.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'pairing_codes' AND column_name = 'replaces_device_id'`,
    );
    expect(col.rows[0]).toEqual({ data_type: "uuid", is_nullable: "YES" });
    const fks = await pg().admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'pairing_codes'::regclass AND contype = 'f'
          AND confrelid = 'devices'::regclass`,
    );
    expect(fks.rows[0]?.n).toBe(0);
  });
});

describe("0040 — reversible", () => {
  it("down removes the columns and keeps revoked_at; up re-applies cleanly", async () => {
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    expect(await lifecycleColumns()).toEqual([]);
    const replaces = await pg().admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'pairing_codes' AND column_name = 'replaces_device_id'`,
    );
    expect(replaces.rows[0]?.n).toBe(0);
    expect((await device(DEVICE_LEGACY_REVOKED))["revoked_at"]).not.toBeNull();
    expect((await device(DEVICE_ACTIVE))["revoked_at"]).not.toBeNull();

    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    expect(await lifecycleColumns()).toEqual(LIFECYCLE_COLUMNS);
    // Reasons were dropped with the columns; re-apply does not invent them.
    expect((await device(DEVICE_ACTIVE))["revoke_reason"]).toBeNull();
    expect((await device(DEVICE_LEGACY_REVOKED))["revoke_reason"]).toBeNull();
  });
});
