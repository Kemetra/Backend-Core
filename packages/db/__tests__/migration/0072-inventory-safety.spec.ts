/**
 * 0072 — tracking holds, recall, expiry correction and the Inventory Safety
 * Revision (Jira RT-449, RT-50 Gate 7 G7-6 / G7-7; owner rulings H1–H8,
 * RT-449 comment 13434).
 *
 * Applies every migration before 0072 against a real Postgres, seeds two
 * tenants with a product, its identities and a pre-0072 settings row (the
 * UPGRADE path), applies 0072, then proves:
 *   - tenant_inventory_safety_revisions: a positive revision, one row per
 *     tenant, SELECT + INSERT + UPDATE tenant policies;
 *   - inventory_safety_changes: one change per (tenant, revision), the
 *     reference each kind names, append-only;
 *   - inventory_recalls: reference shape, replay fingerprint, the product of
 *     its own tenant, append-only;
 *   - tracking_holds: an identity of the hold's own product and tenant, a
 *     recall hold names its recall (of the same product), one active hold per
 *     (identity, kind), a release is set once and a released hold is final;
 *   - tracking_identity_expiry_corrections: old and new differ, append-only;
 *   - tracking_identities: an UPDATE policy, `manufactured_on` frozen and an
 *     `expiry_date` change refused unless its correction row was written in
 *     the same transaction (G7-2: never a silent UPDATE);
 *   - tenant_inventory_settings.safety_ttl_seconds: NULL or 60–900 (H8);
 *   - RLS: ENABLE + FORCE, fail-closed, tenant-scoped, WITH CHECK;
 *   - down refuses while safety data exists (also as a NON-superuser owner
 *     under FORCE RLS), restores the 0045 guard, and round-trips.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import {
  applyMigrationsBefore,
  asApp,
  asMigrationOwner,
  errorCode,
  inRolledBackTx,
  runSqlFile,
  type MigrationOwner,
} from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0072_inventory_safety.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0072_inventory_safety.down.sql");

const TENANT = "0a000000-0000-7000-8000-000000044901";
const TENANT_B = "0b000000-0000-7000-8000-000000044901";
const ACTOR = "0a000000-0000-7000-8000-000000044903";
const PRODUCT = "0a000000-0000-7000-8000-000000044910";
const PRODUCT_2 = "0a000000-0000-7000-8000-000000044911";
const PRODUCT_B = "0b000000-0000-7000-8000-000000044910";
const IDENTITY = "0a000000-0000-7000-8000-000000044920";
const IDENTITY_2 = "0a000000-0000-7000-8000-000000044921";
const IDENTITY_OF_PRODUCT_2 = "0a000000-0000-7000-8000-000000044922";
const IDENTITY_B = "0b000000-0000-7000-8000-000000044920";
const RECALL = "0a000000-0000-7000-8000-000000044930";
const RECALL_OF_PRODUCT_2 = "0a000000-0000-7000-8000-000000044931";
const HOLD = "0a000000-0000-7000-8000-000000044940";

const FP = (n: number): string => n.toString(16).padStart(64, "0");

let env: PgTestEnv | null = null;
/** 0045's guard body, read before 0072 replaces it (the down must restore it exactly). */
let guardBody0045 = "";

async function guardBody(): Promise<string> {
  const r = await pg().admin.query<{ def: string }>(
    `SELECT pg_get_functiondef('tracking_identities_guard_identity()'::regprocedure) AS def`,
  );
  // Line endings follow the checkout (a Windows working tree may hold CRLF).
  return r.rows[0]!.def.replaceAll("\r\n", "\n");
}

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const RECALL_SQL = `INSERT INTO inventory_recalls
       (id, tenant_id, tenant_product_ref, reason_code, reference, note, effective_at,
        command_fingerprint, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8)`;

interface RecallRow {
  readonly id?: string;
  readonly tenantId?: string;
  readonly productId?: string;
  readonly reasonCode?: string;
  readonly reference?: string;
  readonly fingerprint?: string;
}

function recallParams(row: RecallRow): unknown[] {
  return [
    row.id ?? RECALL,
    row.tenantId ?? TENANT,
    row.productId ?? PRODUCT,
    row.reasonCode ?? "authority_notice",
    row.reference ?? "EDA-2026-117",
    null,
    row.fingerprint ?? FP(1),
    ACTOR,
  ];
}

const HOLD_SQL = `INSERT INTO tracking_holds
       (id, tenant_id, tracking_identity_id, tenant_product_ref, kind, reason_code, note,
        recall_id, command_fingerprint, placed_by)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9)`;

interface HoldRow {
  readonly id?: string;
  readonly tenantId?: string;
  readonly identityId?: string;
  readonly productId?: string;
  readonly kind?: string;
  readonly reasonCode?: string;
  readonly recallId?: string | null;
  readonly fingerprint?: string | null;
}

function holdParams(row: HoldRow): unknown[] {
  return [
    row.id ?? HOLD,
    row.tenantId ?? TENANT,
    row.identityId ?? IDENTITY,
    row.productId ?? PRODUCT,
    row.kind ?? "quality_hold",
    row.reasonCode ?? "supplier_notice",
    row.recallId === undefined ? null : row.recallId,
    row.fingerprint === undefined ? FP(2) : row.fingerprint,
    ACTOR,
  ];
}

const CHANGE_SQL = `INSERT INTO inventory_safety_changes
       (tenant_id, revision, kind, tracking_hold_id, inventory_recall_id, tracking_identity_id,
        tenant_product_ref, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

interface ChangeRow {
  readonly tenantId?: string;
  readonly revision?: number;
  readonly kind?: string;
  readonly holdId?: string | null;
  readonly recallId?: string | null;
  readonly identityId?: string | null;
  readonly productId?: string;
}

function changeParams(row: ChangeRow): unknown[] {
  return [
    row.tenantId ?? TENANT,
    row.revision ?? 1,
    row.kind ?? "hold_placed",
    row.holdId === undefined ? HOLD : row.holdId,
    row.recallId === undefined ? null : row.recallId,
    row.identityId === undefined ? IDENTITY : row.identityId,
    row.productId ?? PRODUCT,
    ACTOR,
  ];
}

const CORRECTION_SQL = `INSERT INTO tracking_identity_expiry_corrections
       (tenant_id, tracking_identity_id, tenant_product_ref, old_expiry_date, new_expiry_date,
        reason_code, note, command_fingerprint, created_by)
     VALUES ($1, $2, $3, $4::date, $5::date, 'label_misprint', NULL, $6, $7)`;

function correctionParams(oldDate: string | null, newDate: string | null, fp = FP(3)): unknown[] {
  return [TENANT, IDENTITY, PRODUCT, oldDate, newDate, fp, ACTOR];
}

/** Run `statements` in order in one rolled-back transaction; the last error code, or null. */
async function tryAll(...statements: Array<(c: PoolClient) => Promise<unknown>>): Promise<string | null> {
  return inRolledBackTx(pg().admin, async (c) => {
    let code: string | null = null;
    for (const s of statements) code = await errorCode(() => s(c));
    return code;
  });
}

const insertRecall = (row: RecallRow = {}) => (c: PoolClient) => c.query(RECALL_SQL, recallParams(row));
const insertHold = (row: HoldRow = {}) => (c: PoolClient) => c.query(HOLD_SQL, holdParams(row));
const insertChange = (row: ChangeRow = {}) => (c: PoolClient) => c.query(CHANGE_SQL, changeParams(row));

interface SchemaState {
  readonly tables: number;
  readonly ttlColumn: number;
  readonly identityPolicies: string[];
}

const NEW_TABLES = [
  "tenant_inventory_safety_revisions",
  "inventory_safety_changes",
  "inventory_recalls",
  "tracking_holds",
  "tracking_identity_expiry_corrections",
];

async function schemaState(): Promise<SchemaState> {
  const t = await pg().admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [NEW_TABLES],
  );
  const c = await pg().admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenant_inventory_settings'
        AND column_name = 'safety_ttl_seconds'`,
  );
  const p = await pg().admin.query<{ cmd: string }>(
    `SELECT cmd FROM pg_policies WHERE tablename = 'tracking_identities' ORDER BY cmd`,
  );
  return { tables: t.rows[0]!.n, ttlColumn: c.rows[0]!.n, identityPolicies: p.rows.map((r) => r.cmd) };
}

const UP_STATE: SchemaState = { tables: 5, ttlColumn: 1, identityPolicies: ["INSERT", "SELECT", "UPDATE"] };
const DOWN_STATE: SchemaState = { tables: 0, ttlColumn: 0, identityPolicies: ["INSERT", "SELECT"] };

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0072-inventory-safety.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'rt449-a', 'rt449-a'), ($2, 'rt449-b', 'rt449-b')`, [
    TENANT,
    TENANT_B,
  ]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode) VALUES
       ($1, $4, 'P', 'standard', $6, $6, 'batch'), ($2, $4, 'P2', 'standard', $6, $6, 'batch'),
       ($3, $5, 'PB', 'standard', $6, $6, 'batch')`,
    [PRODUCT, PRODUCT_2, PRODUCT_B, TENANT, TENANT_B, ACTOR],
  );
  await a.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date, manufactured_on) VALUES
       ($1, $5, $7, 'batch', 'LOT-1', '2027-01-31', '2026-01-01'),
       ($2, $5, $7, 'batch', 'LOT-2', NULL, NULL),
       ($3, $5, $8, 'batch', 'LOT-1', NULL, NULL),
       ($4, $6, $9, 'batch', 'LOT-1', NULL, NULL)`,
    [IDENTITY, IDENTITY_2, IDENTITY_OF_PRODUCT_2, IDENTITY_B, TENANT, TENANT_B, PRODUCT, PRODUCT_2, PRODUCT_B],
  );
  // A pre-0072 settings row: the upgrade path keeps it, TTL unset.
  await a.query(`INSERT INTO tenant_inventory_settings (tenant_id, updated_by) VALUES ($1, $2)`, [TENANT, ACTOR]);
  guardBody0045 = await guardBody();
  await a.query(readFileSync(UP_PATH, "utf8"));
  await ensureAppRole(env);
  // Shared fixtures for the hold constraints: one recall of PRODUCT, one of PRODUCT_2.
  await a.query(RECALL_SQL, recallParams({}));
  await a.query(RECALL_SQL, recallParams({ id: RECALL_OF_PRODUCT_2, productId: PRODUCT_2, fingerprint: FP(9) }));
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

describe("0072 up — the upgrade path", () => {
  it("adds the five tables, the TTL column and the identity UPDATE policy", async () => {
    if (skip()) return;
    expect(await schemaState()).toEqual(UP_STATE);
  });

  it("leaves a pre-0072 settings row on the default TTL (NULL)", async () => {
    if (skip()) return;
    const r = await pg().admin.query(
      `SELECT return_landing_status, safety_ttl_seconds FROM tenant_inventory_settings WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(r.rows).toEqual([{ return_landing_status: "sellable", safety_ttl_seconds: null }]);
  });
});

describe("0072 tenant_inventory_safety_revisions", () => {
  it("bumps by upsert and refuses a non-positive revision", async () => {
    if (skip()) return;
    const bumped = await inRolledBackTx(pg().admin, async (c) => {
      const bump = `INSERT INTO tenant_inventory_safety_revisions (tenant_id, revision) VALUES ($1, 1)
                    ON CONFLICT (tenant_id) DO UPDATE
                      SET revision = tenant_inventory_safety_revisions.revision + 1
                    RETURNING revision::int AS revision`;
      const first = (await c.query<{ revision: number }>(bump, [TENANT])).rows[0]!.revision;
      const second = (await c.query<{ revision: number }>(bump, [TENANT])).rows[0]!.revision;
      return [first, second];
    });
    expect(bumped).toEqual([1, 2]);
    expect(
      await tryAll((c) => c.query(`INSERT INTO tenant_inventory_safety_revisions (tenant_id, revision) VALUES ($1, 0)`, [TENANT])),
    ).toBe("23514");
  });
});

describe("0072 inventory_safety_changes", () => {
  it("accepts a change naming the reference its kind needs", async () => {
    if (skip()) return;
    expect(await tryAll(insertHold(), insertChange())).toBeNull();
    expect(
      await tryAll(insertChange({ kind: "recall_created", holdId: null, recallId: RECALL, identityId: null })),
    ).toBeNull();
    expect(await tryAll(insertChange({ kind: "expiry_corrected", holdId: null }))).toBeNull();
    expect(await tryAll(insertChange({ kind: "tracking_profile_changed", holdId: null, identityId: null }))).toBeNull();
  });

  it.each([
    ["an unknown kind", { kind: "hold_moved" }],
    ["a hold change without a hold", { holdId: null }],
    ["a recall change without a recall", { kind: "recall_created", holdId: null, recallId: null, identityId: null }],
    ["an expiry change without an identity", { kind: "expiry_corrected", holdId: null, identityId: null }],
    ["a non-positive revision", { revision: 0, holdId: null, kind: "tracking_profile_changed", identityId: null }],
  ])("refuses %s (23514)", async (_name, row) => {
    if (skip()) return;
    expect(await tryAll(insertHold(), insertChange(row as ChangeRow))).toBe("23514");
  });

  it("refuses a second change at the same (tenant, revision) (23505)", async () => {
    if (skip()) return;
    const profile = { kind: "tracking_profile_changed", holdId: null, identityId: null };
    expect(await tryAll(insertChange(profile), insertChange(profile))).toBe("23505");
  });

  it("refuses a change naming a recall of another tenant (23503)", async () => {
    if (skip()) return;
    expect(
      await tryAll(
        insertChange({ tenantId: TENANT_B, productId: PRODUCT_B, kind: "recall_created", holdId: null, recallId: RECALL, identityId: null }),
      ),
    ).toBe("23503");
  });
});

describe("0072 inventory_recalls", () => {
  it.each([
    ["an empty reference", { reference: "", fingerprint: FP(10) }, "23514"],
    ["a malformed reason code", { reasonCode: "Not A Code", fingerprint: FP(10) }, "23514"],
    ["a malformed fingerprint", { fingerprint: "nope" }, "23514"],
    ["a product of another tenant", { tenantId: TENANT_B, fingerprint: FP(10) }, "23503"],
    ["a reused fingerprint", { id: "0a000000-0000-7000-8000-0000000449ff" }, "23505"],
  ])("refuses %s", async (_name, row, code) => {
    if (skip()) return;
    expect(await tryAll(insertRecall({ id: "0a000000-0000-7000-8000-0000000449fe", ...(row as RecallRow) }))).toBe(code);
  });
});

describe("0072 tracking_holds", () => {
  it("accepts a quality hold and a recall hold of the recall's product", async () => {
    if (skip()) return;
    expect(await tryAll(insertHold())).toBeNull();
    expect(await tryAll(insertHold({ kind: "recall_hold", recallId: RECALL, fingerprint: null }))).toBeNull();
  });

  it.each([
    ["an unknown kind", { kind: "sell_hold" }, "23514"],
    ["a quality hold naming a recall", { recallId: RECALL }, "23514"],
    ["a recall hold without a recall", { kind: "recall_hold", fingerprint: null }, "23514"],
    ["an identity of another product", { identityId: IDENTITY_OF_PRODUCT_2 }, "23503"],
    ["an identity of another tenant", { identityId: IDENTITY_B }, "23503"],
    ["a recall of another product", { kind: "recall_hold", recallId: RECALL_OF_PRODUCT_2, fingerprint: null }, "23503"],
  ])("refuses %s", async (_name, row, code) => {
    if (skip()) return;
    expect(await tryAll(insertHold(row as HoldRow))).toBe(code);
  });

  it("allows one active hold per (identity, kind), and a new one after release (23505)", async () => {
    if (skip()) return;
    const second = insertHold({ id: "0a000000-0000-7000-8000-000000044941", fingerprint: FP(4) });
    expect(await tryAll(insertHold(), second)).toBe("23505");
    const release = (c: PoolClient) =>
      c.query(`UPDATE tracking_holds SET released_by = $2, released_at = now() WHERE id = $1`, [HOLD, ACTOR]);
    expect(await tryAll(insertHold(), release, second)).toBeNull();
    // A recall hold on the same identity is another kind.
    expect(await tryAll(insertHold(), insertHold({ id: "0a000000-0000-7000-8000-000000044942", kind: "recall_hold", recallId: RECALL, fingerprint: null }))).toBeNull();
  });

  it("refuses a reused command fingerprint (23505)", async () => {
    if (skip()) return;
    const sameFp = insertHold({ id: "0a000000-0000-7000-8000-000000044941", identityId: IDENTITY_2 });
    expect(await tryAll(insertHold(), sameFp)).toBe("23505");
  });

  it("sets the release once; a released hold is final and the rest is immutable (23514)", async () => {
    if (skip()) return;
    const release = (c: PoolClient) =>
      c.query(`UPDATE tracking_holds SET released_by = $2, released_at = now(), release_note = 'cleared' WHERE id = $1`, [
        HOLD,
        ACTOR,
      ]);
    expect(await tryAll(insertHold(), release)).toBeNull();
    expect(await tryAll(insertHold(), release, release)).toBe("23514");
    expect(
      await tryAll(insertHold(), (c) => c.query(`UPDATE tracking_holds SET reason_code = 'other' WHERE id = $1`, [HOLD])),
    ).toBe("23514");
    expect(
      await tryAll(insertHold(), (c) => c.query(`UPDATE tracking_holds SET released_at = now() WHERE id = $1`, [HOLD])),
    ).toBe("23514");
    // The allowlist: every non-release column is refused, placement time and tenant included.
    for (const set of [`placed_at = now() - interval '1 day'`, `placed_by = '${TENANT}'`, `note = 'edited'`]) {
      expect(await tryAll(insertHold(), (c) => c.query(`UPDATE tracking_holds SET ${set} WHERE id = $1`, [HOLD]))).toBe(
        "23514",
      );
    }
  });
});

describe("0072 tracking_identity_expiry_corrections and the identity guard", () => {
  const setExpiry = (date: string | null) => (c: PoolClient) =>
    c.query(`UPDATE tracking_identities SET expiry_date = $2::date WHERE id = $1`, [IDENTITY, date]);

  it("refuses a correction that changes nothing (23514)", async () => {
    if (skip()) return;
    expect(await tryAll((c) => c.query(CORRECTION_SQL, correctionParams("2027-01-31", "2027-01-31")))).toBe("23514");
  });

  it("refuses a silent expiry UPDATE, as the app role too (23514)", async () => {
    if (skip()) return;
    expect(await tryAll(setExpiry("2027-02-28"))).toBe("23514");
    const asTenant = await asApp(pg(), TENANT, (c) => errorCode(() => setExpiry("2027-02-28")(c)));
    expect(asTenant).toBe("23514");
  });

  it("accepts an expiry UPDATE with its correction row in the same transaction, as the app role", async () => {
    if (skip()) return;
    const result = await asApp(pg(), TENANT, async (c) => {
      await c.query(CORRECTION_SQL, correctionParams("2027-01-31", "2027-02-28"));
      await setExpiry("2027-02-28")(c);
      return (await c.query(`SELECT expiry_date::text AS d FROM tracking_identities WHERE id = $1`, [IDENTITY])).rows[0];
    });
    expect(result).toEqual({ d: "2027-02-28" });
  });

  it("refuses an expiry UPDATE whose correction names other dates (23514)", async () => {
    if (skip()) return;
    expect(
      await tryAll((c) => c.query(CORRECTION_SQL, correctionParams("2027-01-31", "2027-03-31")), setExpiry("2027-02-28")),
    ).toBe("23514");
  });

  it("lets only expiry_date change: tenant, product, manufactured_on, code, kind and origin are refused (23514)", async () => {
    if (skip()) return;
    for (const set of [
      `tenant_id = '${TENANT_B}'`,
      `tenant_product_ref = '${PRODUCT_2}'`,
      `manufactured_on = '2026-02-01'`,
      `code = 'LOT-9'`,
      `kind = 'serial'`,
      `created_at = now() - interval '1 day'`,
    ]) {
      expect(await tryAll((c) => c.query(`UPDATE tracking_identities SET ${set} WHERE id = $1`, [IDENTITY]))).toBe("23514");
    }
  });

  it("does not let the app role update another tenant's identity (zero rows)", async () => {
    if (skip()) return;
    const n = await asApp(pg(), TENANT_B, async (c) => {
      const r = await c.query(`UPDATE tracking_identities SET updated_at = now() WHERE id = $1`, [IDENTITY]);
      return r.rowCount;
    });
    expect(n).toBe(0);
  });
});

describe("0072 tenant_inventory_settings.safety_ttl_seconds", () => {
  it.each([
    [null, null],
    [60, null],
    [900, null],
    [59, "23514"],
    [901, "23514"],
  ])("TTL %s -> %s", async (ttl, code) => {
    if (skip()) return;
    expect(
      await tryAll((c) => c.query(`UPDATE tenant_inventory_settings SET safety_ttl_seconds = $2 WHERE tenant_id = $1`, [TENANT, ttl])),
    ).toBe(code);
  });
});

describe("0072 RLS", () => {
  it.each([
    ["tenant_inventory_safety_revisions", ["INSERT", "SELECT", "UPDATE"]],
    ["inventory_safety_changes", ["INSERT", "SELECT"]],
    ["inventory_recalls", ["INSERT", "SELECT"]],
    ["tracking_holds", ["INSERT", "SELECT", "UPDATE"]],
    ["tracking_identity_expiry_corrections", ["INSERT", "SELECT"]],
  ])("%s is ENABLE + FORCE row level security with policies %j", async (table, cmds) => {
    if (skip()) return;
    const t = await pg().admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [table]);
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const p = await pg().admin.query<{ cmd: string }>(`SELECT cmd FROM pg_policies WHERE tablename = $1 ORDER BY cmd`, [table]);
    expect(p.rows.map((r) => r.cmd)).toEqual(cmds);
  });

  it("fails closed on an unset or empty tenant GUC, and is tenant-scoped", async () => {
    if (skip()) return;
    const read = (c: PoolClient) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM inventory_recalls`);
    const counts = [];
    for (const guc of [null, "", TENANT_B, TENANT]) counts.push((await asApp(pg(), guc, read)).rows[0]?.n);
    expect(counts).toEqual([0, 0, 0, 2]);
  });

  it("refuses an app-role insert for another tenant (WITH CHECK, 42501)", async () => {
    if (skip()) return;
    const insertB = (c: PoolClient) => errorCode(() => insertHold()(c));
    expect(await asApp(pg(), TENANT_B, insertB)).toBe("42501");
  });
});

describe("0072 down", () => {
  const runDown = (role: string | null = null) => runSqlFile(pg(), DOWN_PATH, role);

  /** A NOSUPERUSER, NOBYPASSRLS owner of the tables 0072 touches, like the production owner. */
  const OWNER: MigrationOwner = {
    role: "rt449_migration_owner",
    tables: ["tenants", "tenant_products", "tracking_identities", "tenant_inventory_settings", ...NEW_TABLES],
    functions: [
      "tracking_identities_guard_identity()",
      "tracking_holds_guard_release()",
      "tenant_inventory_safety_revisions_guard()",
    ],
  };

  it("refuses loudly while recalls exist, and changes nothing", async () => {
    if (skip()) return;
    expect(await runDown()).toBe("P0001");
    expect(await schemaState()).toEqual(UP_STATE);
  });

  it("refuses as a NON-superuser owner under FORCE RLS, and drops nothing", async () => {
    if (skip()) return;
    await asMigrationOwner(pg(), OWNER, async () => {
      expect(await runDown(OWNER.role)).toBe("P0001");
      expect(await schemaState()).toEqual(UP_STATE);
    });
  });

  it("refuses while a tenant has a safety TTL set", async () => {
    if (skip()) return;
    await pg().admin.query(`DELETE FROM inventory_recalls`);
    await pg().admin.query(`UPDATE tenant_inventory_settings SET safety_ttl_seconds = 300 WHERE tenant_id = $1`, [TENANT]);
    try {
      expect(await runDown()).toBe("P0001");
    } finally {
      await pg().admin.query(`UPDATE tenant_inventory_settings SET safety_ttl_seconds = NULL WHERE tenant_id = $1`, [TENANT]);
    }
  });

  it("round-trips up / down / up as a NON-superuser owner, restoring the 0045 guard on down", async () => {
    if (skip()) return;
    await asMigrationOwner(pg(), OWNER, async () => {
      expect(await runDown(OWNER.role)).toBeNull();
      expect(await schemaState()).toEqual(DOWN_STATE);
      // The down restores 0045's guard body exactly.
      expect(await guardBody()).toBe(guardBody0045);
      // The 0045 guard is back: manufactured_on and expiry are mutable again.
      expect(
        await tryAll((c) =>
          c.query(`UPDATE tracking_identities SET manufactured_on = '2026-02-01', expiry_date = '2027-05-31' WHERE id = $1`, [
            IDENTITY,
          ]),
        ),
      ).toBeNull();
      expect(await runSqlFile(pg(), UP_PATH, OWNER.role)).toBeNull();
      expect(await schemaState()).toEqual(UP_STATE);
    });
    await ensureAppRole(pg());
  });
});
