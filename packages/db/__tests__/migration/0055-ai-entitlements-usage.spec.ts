/**
 * 0055 — AI plan catalog, tenant entitlements, opt-outs, usage counters and
 * the single ai_usage_ledger (RT-663 = RT-644 ENT-BC2 + RT-643 F-3; [GATED]
 * migration). Decisions: AD-AI-ENT-001 D-2, D-3, D-5, D-8, D-9 and its
 * usage-store ownership section; AD-AI-PROV-001 D-6 / E-8.
 *
 * Applies every migration before 0055 against a real Postgres, seeds two
 * tenants, applies 0055, then proves:
 *   - the code-owned plan catalog: one default-deny version (no feature, no
 *     meter, no limit), readable by every tenant, written only under the
 *     platform-admin GUC, immutable;
 *   - tenant_ai_entitlements: immutable revisions on one tenant-wide linear
 *     version chain (a stale `expected_version` write is 23505), the
 *     state / plan / source shape, content_hash, and NO tenant self-grant
 *     (an INSERT in the tenant's own RLS context without the platform-admin
 *     GUC is refused, test T18's backstop);
 *   - tenant_ai_feature_opt_outs (D-5): a separate, tenant-authored chain;
 *   - ai_usage_counters: one row per (tenant, store?, meter, UTC window),
 *     non-negative used / reserved, identity frozen, never deleted;
 *   - ai_usage_ledger: append-only reserved → committed | released, at most
 *     one terminal per reservation, the terminal pinned to its reservation's
 *     dimensions, unique (tenant, feature, idempotency_key), committed only
 *     for outcome `ok` (D-8), the AI-09 run metadata shapes;
 *   - one usage store and no price column (RT-663 AC-3);
 *   - FORCED RLS on every new table, with cross-tenant reads returning no
 *     rows and cross-tenant writes refused;
 *   - down drops every 0055 object and keeps every older row; up re-applies.
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
const UP_NAME = "0055_ai_entitlements_usage.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0055_ai_entitlements_usage.down.sql");

const TENANT_A = "0a000000-0000-7000-8000-000000055a01";
const TENANT_B = "0b000000-0000-7000-8000-000000055b01";
const STORE_A1 = "0a000000-0000-7000-8000-000000055a02";
const STORE_B1 = "0b000000-0000-7000-8000-000000055b02";
const PLATFORM_ADMIN = "0c000000-0000-7000-8000-000000055c01";
const OWNER_A = "0a000000-0000-7000-8000-000000055a04";
const OWNER_B = "0b000000-0000-7000-8000-000000055b04";

const CATALOG = "ai_plan_catalog";
const CATALOG_FEATURES = "ai_plan_catalog_features";
const CATALOG_METERS = "ai_plan_catalog_meters";
const ENTITLEMENTS = "tenant_ai_entitlements";
const OPT_OUTS = "tenant_ai_feature_opt_outs";
const COUNTERS = "ai_usage_counters";
const LEDGER = "ai_usage_ledger";
const GLOBAL_TABLES = [CATALOG, CATALOG_FEATURES, CATALOG_METERS] as const;
const TENANT_TABLES = [ENTITLEMENTS, OPT_OUTS, COUNTERS, LEDGER] as const;
const NEW_TABLES = [...GLOBAL_TABLES, ...TENANT_TABLES] as const;

const FEATURE = "ai.explain.ops";
const METER = "ai.explain.ops.requests";
const DAY = "2026-10-19T00:00:00Z";

/** The admin pool or one client of either pool. */
type Queryable = { query: PoolClient["query"] };

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const skip = (): boolean => env === null;
const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

async function applyBefore0055(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
}

async function seedTenants(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-663 A', 'rt663-a'), ($2, 'RT-663 B', 'rt663-b')`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'a1', 'A1'), ($2, $4, 'b1', 'B1')`,
    [STORE_A1, STORE_B1, TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, is_platform_admin) VALUES
       ($1, 'platform@rt663.example', true), ($2, 'owner-a@rt663.example', false),
       ($3, 'owner-b@rt663.example', false)`,
    [PLATFORM_ADMIN, OWNER_A, OWNER_B],
  );
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

/**
 * Runs `fn` on an app-role client inside a tenant's RLS context, then rolls
 * back. `platformAdmin` sets `app.is_platform_admin`, as runWithTenantContext does.
 */
async function asTenant<T>(
  tenant: string,
  fn: (client: PoolClient) => Promise<T>,
  platformAdmin = false,
): Promise<T> {
  const client = await pg().app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
    await client.query("SELECT set_config('app.is_platform_admin', $1, true)", [String(platformAdmin)]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Runs `fn` on one superuser client inside a single transaction, then COMMITs. */
async function inOneTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pg().admin.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Expects `sql` to fail with `code` inside a savepoint, so the transaction goes on. */
async function attempt(client: PoolClient, sql: string, params: unknown[], code: string): Promise<void> {
  await client.query("SAVEPOINT attempt");
  await expectCode(client.query(sql, params), code);
  await client.query("ROLLBACK TO SAVEPOINT attempt");
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = await pg().admin.query<{ n: string }>(sql, params);
  return Number(r.rows[0]?.n ?? "0");
}

// --- writers ---------------------------------------------------------------

interface EntitlementInput {
  tenant?: string;
  version?: number;
  base?: number | null;
  plan?: string | null;
  catalogVersion?: number | null;
  state?: string;
  from?: string;
  until?: string | null;
  overrides?: unknown;
  source?: string;
  sourceRef?: string | null;
  reason?: string | null;
  createdBy?: string | null;
  hash?: Buffer;
}

/** A revision; defaults are a valid first `active` core@1 manual grant of tenant A. */
async function insertEntitlement(input: EntitlementInput = {}, client: Queryable = pg().admin): Promise<string> {
  const id = randomUUID();
  const has = (k: keyof EntitlementInput): boolean => Object.prototype.hasOwnProperty.call(input, k);
  const version = input.version ?? 1;
  await client.query(
    `INSERT INTO ${ENTITLEMENTS}
       (id, tenant_id, entitlement_version, base_version, plan_code, catalog_version, state,
        effective_from, effective_until, overrides, source, source_ref, reason,
        created_by_user_id, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)`,
    [
      id,
      input.tenant ?? TENANT_A,
      version,
      has("base") ? input.base : version === 1 ? null : version - 1,
      has("plan") ? input.plan : "core",
      has("catalogVersion") ? input.catalogVersion : 1,
      input.state ?? "active",
      input.from ?? "2026-10-19T09:00:00Z",
      has("until") ? input.until : null,
      JSON.stringify(has("overrides") ? input.overrides : []),
      input.source ?? "manual_platform",
      has("sourceRef") ? input.sourceRef : null,
      has("reason") ? input.reason : "Pilot grant",
      has("createdBy") ? input.createdBy : PLATFORM_ADMIN,
      input.hash ?? sha256(id),
    ],
  );
  return id;
}

interface OptOutInput {
  tenant?: string;
  version?: number;
  base?: number | null;
  feature?: string;
  action?: string;
  reason?: string;
  createdBy?: string;
}

async function insertOptOut(input: OptOutInput = {}, client: Queryable = pg().admin): Promise<string> {
  const id = randomUUID();
  const version = input.version ?? 1;
  const has = (k: keyof OptOutInput): boolean => Object.prototype.hasOwnProperty.call(input, k);
  await client.query(
    `INSERT INTO ${OPT_OUTS}
       (id, tenant_id, opt_out_version, base_version, feature_id, action, reason, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.tenant ?? TENANT_A,
      version,
      has("base") ? input.base : version === 1 ? null : version - 1,
      input.feature ?? FEATURE,
      input.action ?? "opt_out",
      input.reason ?? "Data governance review",
      input.createdBy ?? OWNER_A,
    ],
  );
  return id;
}

interface CounterInput {
  tenant?: string;
  store?: string | null;
  meter?: string;
  windowKind?: string;
  windowStart?: string;
  used?: number;
  reserved?: number;
}

async function insertCounter(input: CounterInput = {}, client: Queryable = pg().admin): Promise<string> {
  const id = randomUUID();
  const has = (k: keyof CounterInput): boolean => Object.prototype.hasOwnProperty.call(input, k);
  await client.query(
    `INSERT INTO ${COUNTERS} (id, tenant_id, store_id, meter, window_kind, window_start, used, reserved)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.tenant ?? TENANT_A,
      has("store") ? input.store : null,
      input.meter ?? `${METER}.m${id.slice(0, 8)}`,
      input.windowKind ?? "day",
      input.windowStart ?? DAY,
      input.used ?? 0,
      input.reserved ?? 0,
    ],
  );
  return id;
}

/** A ledger row; every column not named takes NULL or the reserved-row default. */
type LedgerInput = Record<string, unknown> & {
  tenant?: string;
  kind?: string;
  reservationId?: string;
  feature?: string;
  counterId?: string;
  units?: number;
  entitlementVersion?: number;
};

const LEDGER_COLUMNS = [
  "idempotency_key", "request_id", "actor_user_id", "expires_at", "opt_out_version",
  "route_key", "prompt_template_id", "prompt_template_version", "output_schema_id",
  "output_schema_version", "provider_key", "model_id", "evidence_ref_ids", "input_tokens",
  "output_tokens", "cached_input_tokens", "token_count_source", "list_equivalent_cost_micros",
  "cost_currency", "cost_rate_card_version", "outcome", "provider_request_id",
  "adjusts_entry_id", "adjustment_reason",
] as const;

/** An `adjusted` row's defaults: a platform admin's reasoned credit, no telemetry. */
const ADJUSTED_DEFAULTS: Record<string, unknown> = {
  actor_user_id: PLATFORM_ADMIN,
  adjustment_reason: "Dispute 42: duplicate briefing credited back",
};

async function insertLedger(input: LedgerInput, client: Queryable = pg().admin): Promise<string> {
  const id = randomUUID();
  const kind = input.kind ?? "reserved";
  const reserved = kind === "reserved";
  const defaults: Record<string, unknown> = kind === "adjusted"
    ? { ...ADJUSTED_DEFAULTS, idempotency_key: `adj-${id}` }
    : reserved
    ? {
        idempotency_key: `idem-${id}`,
        expires_at: "2026-10-19T10:05:00Z",
        route_key: "sync_doctor.explain_sale@v1",
        prompt_template_id: "sync_doctor.explain",
        prompt_template_version: "1",
        output_schema_id: "sync_doctor.explain.output",
        output_schema_version: "1",
        provider_key: "fake",
        model_id: "fake-model-1",
        evidence_ref_ids: ["sale:1", "posting:2"],
      }
    : {
        outcome: kind === "committed" ? "ok" : "provider_unavailable",
        input_tokens: 1200,
        output_tokens: 300,
        cached_input_tokens: 0,
        token_count_source: "reported",
        list_equivalent_cost_micros: 4500,
        cost_currency: "USD",
        cost_rate_card_version: "2026-10-rc1",
        provider_request_id: "req_fake_1",
      };
  const values = LEDGER_COLUMNS.map((c) =>
    Object.prototype.hasOwnProperty.call(input, c) ? input[c] : (defaults[c] ?? null),
  );
  const cols = ["id", "tenant_id", "reservation_id", "entry_kind", "feature_id", "counter_id",
    "units", "entitlement_version", "created_at", ...LEDGER_COLUMNS];
  const params = [
    id,
    input.tenant ?? TENANT_A,
    input.reservationId ?? id,
    kind,
    input.feature ?? FEATURE,
    input.counterId,
    input.units ?? 1,
    input.entitlementVersion ?? 1,
    input["created_at"] ?? "2026-10-19T10:00:00Z",
    ...values,
  ];
  await client.query(
    `INSERT INTO ${LEDGER} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    params,
  );
  return id;
}

/** Tenant A's tenant-wide daily counter, shared by the ledger tests. */
let counterA = "";

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0055-ai-entitlements-usage.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0055(env);
  await seedTenants(env);
  await env.admin.query(readFileSync(UP_PATH, "utf8"));
  await ensureAppRole(env);
  await insertEntitlement();
  await insertEntitlement({ tenant: TENANT_B });
  await insertOptOut();
  await insertOptOut({ tenant: TENANT_B, createdBy: OWNER_B });
  counterA = await insertCounter({ meter: METER });
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// ---------------------------------------------------------------------------

describe("0055 — the code-owned plan catalog (default-deny seed)", () => {
  it("seeds one plan version that grants no feature and no meter", async () => {
    if (skip()) return;
    const plans = await pg().admin.query(`SELECT plan_code, catalog_version FROM ${CATALOG}`);
    expect(plans.rows).toEqual([{ plan_code: "core", catalog_version: 1 }]);
    expect(await count(`SELECT COUNT(*) AS n FROM ${CATALOG_FEATURES}`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM ${CATALOG_METERS}`)).toBe(0);
  });

  it("is readable from any tenant context", async () => {
    if (skip()) return;
    const n = await asTenant(TENANT_B, async (c) => (await c.query(`SELECT 1 FROM ${CATALOG}`)).rowCount);
    expect(n).toBe(1);
  });

  it("refuses a catalog write outside the platform-admin GUC (42501)", async () => {
    if (skip()) return;
    await asTenant(TENANT_A, async (c) => {
      await expectCode(
        c.query(`INSERT INTO ${CATALOG} (plan_code, catalog_version) VALUES ('ai_assist', 1)`),
        "42501",
      );
    });
  });

  it("accepts a new version, feature and meter under the platform-admin GUC", async () => {
    if (skip()) return;
    await asTenant(
      TENANT_A,
      async (c) => {
        await c.query(`INSERT INTO ${CATALOG} (plan_code, catalog_version) VALUES ('core', 2)`);
        await c.query(`INSERT INTO ${CATALOG_FEATURES} (plan_code, catalog_version, feature_id)
          VALUES ('core', 2, $1)`, [FEATURE]);
        await c.query(`INSERT INTO ${CATALOG_METERS}
            (plan_code, catalog_version, feature_id, meter, unit, window_kind, meter_scope, limit_value)
          VALUES ('core', 2, $1, $2, 'request', 'month', 'tenant', 100)`, [FEATURE, METER]);
        const r = await c.query(`SELECT limit_value::int FROM ${CATALOG_METERS}
          WHERE plan_code = 'core' AND catalog_version = 2`);
        expect(r.rows).toEqual([{ limit_value: 100 }]);
      },
      true,
    );
  });

  it("checks the catalog shapes (23514 / 23503)", async () => {
    if (skip()) return;
    const a = pg().admin;
    await expectCode(a.query(`INSERT INTO ${CATALOG} (plan_code, catalog_version) VALUES ('Core', 3)`), "23514");
    await expectCode(a.query(`INSERT INTO ${CATALOG} (plan_code, catalog_version) VALUES ('x', 0)`), "23514");
    await expectCode(
      a.query(`INSERT INTO ${CATALOG_FEATURES} (plan_code, catalog_version, feature_id) VALUES ('core', 9, $1)`, [FEATURE]),
      "23503",
    );
    // A version and its children are written in one transaction (sealed at commit).
    await inOneTransaction(async (c) => {
      await c.query(`INSERT INTO ${CATALOG} (plan_code, catalog_version) VALUES ('shape_probe', 1)`);
      await attempt(c, `INSERT INTO ${CATALOG_FEATURES} (plan_code, catalog_version, feature_id)
        VALUES ('shape_probe', 1, 'explain')`, [], "23514");
      await c.query(`INSERT INTO ${CATALOG_FEATURES} (plan_code, catalog_version, feature_id)
        VALUES ('shape_probe', 1, $1)`, [FEATURE]);
      const meterSql = `INSERT INTO ${CATALOG_METERS}
          (plan_code, catalog_version, feature_id, meter, unit, window_kind, meter_scope, limit_value)
        VALUES ('shape_probe', 1, $1, $2, $3, $4, $5, $6)`;
      // v1 customer meters count requests only (D-3).
      await attempt(c, meterSql, [FEATURE, METER, "token", "month", "tenant", 1], "23514");
      await attempt(c, meterSql, [FEATURE, METER, "request", "week", "tenant", 1], "23514");
      await attempt(c, meterSql, [FEATURE, METER, "request", "month", "global", 1], "23514");
      await attempt(c, meterSql, [FEATURE, METER, "request", "month", "tenant", -1], "23514");
      await attempt(c, meterSql, ["ai.other", METER, "request", "month", "tenant", 1], "23503");
      await c.query(meterSql, [FEATURE, METER, "request", "month", "tenant", 0]);
    });
    expect(await count(`SELECT COUNT(*) AS n FROM ${CATALOG_METERS} WHERE plan_code = 'shape_probe'`)).toBe(1);
  });

  it("seals a committed version: no later feature or meter, even for a platform admin (42501)", async () => {
    if (skip()) return;
    const a = pg().admin;
    await expectCode(
      a.query(`INSERT INTO ${CATALOG_FEATURES} (plan_code, catalog_version, feature_id) VALUES ('core', 1, $1)`, [FEATURE]),
      "42501",
    );
    await expectCode(
      a.query(`INSERT INTO ${CATALOG_FEATURES} (plan_code, catalog_version, feature_id)
        VALUES ('shape_probe', 1, 'ai.briefing.daily')`),
      "42501",
    );
    await expectCode(
      a.query(`INSERT INTO ${CATALOG_METERS}
          (plan_code, catalog_version, feature_id, meter, unit, window_kind, meter_scope, limit_value)
        VALUES ('shape_probe', 1, $1, 'ai.explain.ops.late', 'request', 'day', 'store', 5)`, [FEATURE]),
      "42501",
    );
    await asTenant(TENANT_A, async (c) => {
      await expectCode(
        c.query(`INSERT INTO ${CATALOG_FEATURES} (plan_code, catalog_version, feature_id) VALUES ('core', 1, $1)`, [FEATURE]),
        "42501",
      );
    }, true);
  });

  it.each(GLOBAL_TABLES)("%s is immutable for every role (42501)", async (table) => {
    if (skip()) return;
    await expectCode(pg().admin.query(`UPDATE ${table} SET plan_code = plan_code`), "42501");
    await expectCode(pg().admin.query(`DELETE FROM ${table}`), "42501");
    await expectCode(pg().admin.query(`TRUNCATE ${table} CASCADE`), "42501");
  });
});

describe("0055 — tenant_ai_entitlements (immutable revisions, D-2)", () => {
  it("never lets a tenant grant itself: INSERT without the platform-admin GUC is refused (T18)", async () => {
    if (skip()) return;
    await asTenant(TENANT_A, async (c) => {
      await expectCode(insertEntitlement({ version: 2, createdBy: OWNER_A }, c), "42501");
    });
  });

  it("accepts a platform-admin revision in the tenant's context", async () => {
    if (skip()) return;
    await asTenant(TENANT_A, async (c) => {
      await insertEntitlement({ version: 2, state: "grace" }, c);
      const r = await c.query(`SELECT entitlement_version, state FROM ${ENTITLEMENTS} ORDER BY entitlement_version`);
      expect(r.rows).toEqual([{ entitlement_version: 1, state: "active" }, { entitlement_version: 2, state: "grace" }]);
    }, true);
  });

  it("refuses a cross-tenant revision even under the platform-admin GUC (42501)", async () => {
    if (skip()) return;
    await asTenant(TENANT_A, async (c) => {
      await expectCode(insertEntitlement({ tenant: TENANT_B, version: 2 }, c), "42501");
    }, true);
  });

  it("keeps one linear chain: a stale expected_version write is 23505", async () => {
    if (skip()) return;
    const tenant = await newTenant();
    await insertEntitlement({ tenant });
    await insertEntitlement({ tenant, version: 2 });
    // A second writer that also expected version 1.
    await expectCode(insertEntitlement({ tenant, version: 2, state: "expired" }), "23505");
    // A gap or a mismatched base is refused.
    await expectCode(insertEntitlement({ tenant, version: 4 }), "23503");
    await expectCode(insertEntitlement({ tenant, version: 3, base: 1 }), "23514");
    await expectCode(insertEntitlement({ tenant, version: 1, base: 0 }), "23514");
    await expectCode(insertEntitlement({ tenant: await newTenant(), version: 0, base: null }), "23514");
  });

  it("checks the state, plan, window and source shapes (23514 / 23503)", async () => {
    if (skip()) return;
    const v1 = async (input: EntitlementInput): Promise<unknown> =>
      insertEntitlement({ tenant: await newTenant(), ...input });
    await expectCode(v1({ state: "paused" }), "23514");
    // `none` has no plan; every other state names one.
    await expectCode(v1({ state: "none" }), "23514");
    await v1({ state: "none", plan: null, catalogVersion: null });
    await expectCode(v1({ plan: null, catalogVersion: null }), "23514");
    await expectCode(v1({ catalogVersion: null }), "23514");
    await expectCode(v1({ catalogVersion: 99 }), "23503");
    // A trial always ends; an end is after its start.
    await expectCode(v1({ state: "trial" }), "23514");
    await v1({ state: "trial", until: "2026-11-19T09:00:00Z" });
    await expectCode(v1({ until: "2026-10-19T09:00:00Z" }), "23514");
    // Manual grants carry a reason and a granting user; billing events a ref.
    await expectCode(v1({ reason: null }), "23514");
    await expectCode(v1({ reason: "" }), "23514");
    await expectCode(v1({ createdBy: null }), "23514");
    await expectCode(v1({ sourceRef: "evt_1" }), "23514");
    await expectCode(v1({ source: "billing_event" }), "23514");
    await v1({ source: "billing_event", sourceRef: "evt_1", reason: null, createdBy: null });
    await expectCode(v1({ source: "self_service" }), "23514");
    // Overrides are a bounded JSON array; the hash is a SHA-256.
    await expectCode(v1({ overrides: { feature: FEATURE } }), "23514");
    await expectCode(v1({ hash: Buffer.alloc(16) }), "23514");
  });

  it("consumes each billing event at most once per tenant (23505)", async () => {
    if (skip()) return;
    const tenant = await newTenant();
    const billing = { source: "billing_event", sourceRef: "evt_dup", reason: null, createdBy: null };
    await insertEntitlement({ tenant, ...billing });
    await expectCode(insertEntitlement({ tenant, version: 2, ...billing }), "23505");
  });

  it("is append-only for every role (42501)", async () => {
    if (skip()) return;
    await expectCode(pg().admin.query(`UPDATE ${ENTITLEMENTS} SET reason = 'x'`), "42501");
    await expectCode(pg().admin.query(`DELETE FROM ${ENTITLEMENTS}`), "42501");
    await expectCode(pg().admin.query(`TRUNCATE ${ENTITLEMENTS} CASCADE`), "42501");
  });
});

describe("0055 — tenant_ai_feature_opt_outs (tenant owner opt-out, D-5)", () => {
  it("accepts a tenant-authored chain in the tenant's own context", async () => {
    if (skip()) return;
    await asTenant(TENANT_A, async (c) => {
      await insertOptOut({ version: 2, action: "opt_in" }, c);
      await insertOptOut({ version: 3 }, c);
      const r = await c.query(`SELECT opt_out_version, action FROM ${OPT_OUTS} ORDER BY opt_out_version`);
      expect(r.rows).toEqual([
        { opt_out_version: 1, action: "opt_out" },
        { opt_out_version: 2, action: "opt_in" },
        { opt_out_version: 3, action: "opt_out" },
      ]);
    });
  });

  it("checks the chain and shapes (23505 / 23503 / 23514)", async () => {
    if (skip()) return;
    const tenant = await newTenant();
    const owner = await newUser();
    await insertOptOut({ tenant, createdBy: owner });
    await expectCode(insertOptOut({ tenant, createdBy: owner }), "23505");
    await expectCode(insertOptOut({ tenant, createdBy: owner, version: 3 }), "23503");
    await expectCode(insertOptOut({ tenant, createdBy: owner, version: 2, action: "grant" }), "23514");
    await expectCode(insertOptOut({ tenant, createdBy: owner, version: 2, reason: "" }), "23514");
    await expectCode(insertOptOut({ tenant, createdBy: owner, version: 2, feature: "catalog" }), "23514");
  });

  it("refuses an opt-out for another tenant (42501)", async () => {
    if (skip()) return;
    await asTenant(TENANT_A, async (c) => {
      await expectCode(insertOptOut({ tenant: TENANT_B, createdBy: OWNER_B }, c), "42501");
    });
  });

  it("is append-only for every role (42501)", async () => {
    if (skip()) return;
    await expectCode(pg().admin.query(`UPDATE ${OPT_OUTS} SET reason = 'x'`), "42501");
    await expectCode(pg().admin.query(`DELETE FROM ${OPT_OUTS}`), "42501");
    await expectCode(pg().admin.query(`TRUNCATE ${OPT_OUTS} CASCADE`), "42501");
  });
});

describe("0055 — ai_usage_counters (D-3 Option A, D-9 UTC windows)", () => {
  it("keeps one row per (tenant, store, meter, window), a NULL store included (23505)", async () => {
    if (skip()) return;
    await expectCode(insertCounter({ meter: METER }), "23505");
    await insertCounter({ meter: METER, store: STORE_A1 });
    await expectCode(insertCounter({ meter: METER, store: STORE_A1 }), "23505");
    await insertCounter({ meter: METER, windowStart: "2026-10-20T00:00:00Z" });
    await insertCounter({ meter: METER, tenant: TENANT_B });
  });

  it("aligns each window to its UTC boundary (23514)", async () => {
    if (skip()) return;
    await insertCounter({ windowKind: "month", windowStart: "2026-10-01T00:00:00Z" });
    await expectCode(insertCounter({ windowKind: "month", windowStart: "2026-10-19T00:00:00Z" }), "23514");
    // Midnight in Cairo is not a UTC day boundary.
    await expectCode(insertCounter({ windowStart: "2026-10-19T00:00:00+03:00" }), "23514");
    await expectCode(insertCounter({ windowKind: "week" }), "23514");
    // A unit date_trunc itself would reject (22023) is still a CHECK violation.
    await expectCode(insertCounter({ windowKind: "bogus" }), "23514");
  });

  it("checks the counts and the store's tenant (23514 / 23503)", async () => {
    if (skip()) return;
    await expectCode(insertCounter({ used: -1 }), "23514");
    await expectCode(insertCounter({ reserved: -1 }), "23514");
    await expectCode(insertCounter({ meter: "Requests" }), "23514");
    await expectCode(insertCounter({ store: STORE_B1 }), "23503");
  });

  it("lets used / reserved move, and freezes the row's identity (42501)", async () => {
    if (skip()) return;
    const id = await insertCounter();
    await pg().admin.query(`UPDATE ${COUNTERS} SET reserved = reserved + 1 WHERE id = $1`, [id]);
    await pg().admin.query(`UPDATE ${COUNTERS} SET used = used + 1, reserved = reserved - 1 WHERE id = $1`, [id]);
    const r = await pg().admin.query(`SELECT used::int, reserved::int FROM ${COUNTERS} WHERE id = $1`, [id]);
    expect(r.rows[0]).toEqual({ used: 1, reserved: 0 });
    await expectCode(pg().admin.query(`UPDATE ${COUNTERS} SET reserved = -1 WHERE id = $1`, [id]), "23514");
    for (const assignment of ["meter = 'ai.other'", `tenant_id = '${TENANT_B}'`,
      "window_start = window_start + interval '1 day'", "window_kind = 'month'", `store_id = '${STORE_A1}'`]) {
      await expectCode(pg().admin.query(`UPDATE ${COUNTERS} SET ${assignment} WHERE id = $1`, [id]), "42501");
    }
  });

  it("is never deleted (42501)", async () => {
    if (skip()) return;
    await expectCode(pg().admin.query(`DELETE FROM ${COUNTERS}`), "42501");
    await expectCode(pg().admin.query(`TRUNCATE ${COUNTERS} CASCADE`), "42501");
  });

  it("isolates counters under the app role: no cross-tenant read, update or insert", async () => {
    if (skip()) return;
    await asTenant(TENANT_A, async (c) => {
      const seen = await c.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM ${COUNTERS}`);
      expect(seen.rows.map((x) => x.tenant_id)).toEqual([TENANT_A]);
      const r = await c.query(`UPDATE ${COUNTERS} SET used = used + 1 WHERE tenant_id = $1`, [TENANT_B]);
      expect(r.rowCount).toBe(0);
      expect((await c.query(`UPDATE ${COUNTERS} SET used = used WHERE id = $1`, [counterA])).rowCount).toBe(1);
      await expectCode(insertCounter({ tenant: TENANT_B, meter: "ai.cross" }, c), "42501");
    });
  });
});

describe("0055 — ai_usage_ledger (one append-only usage store, AI-09 run metadata)", () => {
  it("records a reservation, then exactly one commit or release", async () => {
    if (skip()) return;
    const reservation = await insertLedger({ counterId: counterA });
    await insertLedger({ kind: "committed", reservationId: reservation, counterId: counterA });
    await expectCode(
      insertLedger({ kind: "released", reservationId: reservation, counterId: counterA }),
      "23505",
    );
    const released = await insertLedger({ counterId: counterA });
    await insertLedger({ kind: "released", reservationId: released, counterId: counterA, outcome: "output_invalid" });
  });

  it("is unique per (tenant, feature, idempotency_key) (23505)", async () => {
    if (skip()) return;
    await insertLedger({ counterId: counterA, idempotency_key: "idem-key-0000000001" });
    await expectCode(insertLedger({ counterId: counterA, idempotency_key: "idem-key-0000000001" }), "23505");
    await insertLedger({ counterId: counterA, idempotency_key: "idem-key-0000000001", feature: "ai.briefing.daily" });
  });

  it("pins a terminal row to its reservation's dimensions (23503)", async () => {
    if (skip()) return;
    const reservation = await insertLedger({ counterId: counterA, units: 2 });
    const terminal = { kind: "committed", reservationId: reservation, counterId: counterA };
    await expectCode(insertLedger({ ...terminal, units: 1 }), "23503");
    await expectCode(insertLedger({ ...terminal, units: 2, feature: "ai.briefing.daily" }), "23503");
    await expectCode(insertLedger({ ...terminal, units: 2, counterId: await insertCounter() }), "23503");
    await expectCode(insertLedger({ ...terminal, units: 2, reservationId: randomUUID() }), "23503");
    await insertLedger({ ...terminal, units: 2 });
  });

  it("refuses a terminal row that points at another terminal row (23514)", async () => {
    if (skip()) return;
    const reservation = await insertLedger({ counterId: counterA });
    const commit = await insertLedger({ kind: "committed", reservationId: reservation, counterId: counterA });
    await expectCode(insertLedger({ kind: "released", reservationId: commit, counterId: counterA }), "23514");
  });

  it("commits only an `ok` outcome and releases every other (D-8, 23514)", async () => {
    if (skip()) return;
    const r1 = await insertLedger({ counterId: counterA });
    await expectCode(
      insertLedger({ kind: "committed", reservationId: r1, counterId: counterA, outcome: "output_invalid" }),
      "23514",
    );
    await expectCode(insertLedger({ kind: "released", reservationId: r1, counterId: counterA, outcome: "ok" }), "23514");
    await expectCode(insertLedger({ kind: "released", reservationId: r1, counterId: counterA, outcome: "maybe" }), "23514");
    await expectCode(insertLedger({ kind: "released", reservationId: r1, counterId: counterA, outcome: null }), "23514");
    // A sweeper release carries no provider evidence.
    await insertLedger({
      kind: "released", reservationId: r1, counterId: counterA, outcome: "reservation_expired",
      input_tokens: null, output_tokens: null, cached_input_tokens: null, token_count_source: null,
      list_equivalent_cost_micros: null, cost_currency: null, cost_rate_card_version: null,
      provider_request_id: null,
    });
  });

  it("checks the reserved-row shape (23514)", async () => {
    if (skip()) return;
    const base = { counterId: counterA };
    await expectCode(insertLedger({ ...base, idempotency_key: null }), "23514");
    await expectCode(insertLedger({ ...base, idempotency_key: "short" }), "23514");
    await expectCode(insertLedger({ ...base, expires_at: null }), "23514");
    await expectCode(insertLedger({ ...base, expires_at: "2026-10-19T09:59:00Z" }), "23514");
    await expectCode(insertLedger({ ...base, units: 0 }), "23514");
    await expectCode(insertLedger({ ...base, outcome: "ok" }), "23514");
    await expectCode(insertLedger({ ...base, input_tokens: 10, token_count_source: "estimated" }), "23514");
    await expectCode(insertLedger({ ...base, reservationId: randomUUID() }), "23514");
    await expectCode(insertLedger({ ...base, kind: "pending" }), "23514");
    await expectCode(insertLedger({ ...base, evidence_ref_ids: ["sale:1", null] }), "23514");
  });

  it("checks the terminal telemetry shape (23514)", async () => {
    if (skip()) return;
    const r = await insertLedger({ counterId: counterA });
    const t = { kind: "committed", reservationId: r, counterId: counterA };
    await expectCode(insertLedger({ ...t, idempotency_key: "idem-key-terminal-01" }), "23514");
    await expectCode(insertLedger({ ...t, expires_at: "2026-10-19T10:05:00Z" }), "23514");
    await expectCode(insertLedger({ ...t, input_tokens: -1 }), "23514");
    await expectCode(insertLedger({ ...t, token_count_source: null }), "23514");
    await expectCode(insertLedger({ ...t, token_count_source: "guessed" }), "23514");
    await expectCode(insertLedger({ ...t, cost_currency: null }), "23514");
    await expectCode(insertLedger({ ...t, list_equivalent_cost_micros: -5 }), "23514");
    await expectCode(insertLedger({ ...t, cost_currency: "usd" }), "23514");
    // Estimated tokens are allowed (AI-09: reported or estimated).
    await insertLedger({ ...t, token_count_source: "estimated" });
  });

  it("references the tenant's own entitlement revision and counter (23503)", async () => {
    if (skip()) return;
    await expectCode(insertLedger({ counterId: counterA, entitlementVersion: 42 }), "23503");
    await expectCode(insertLedger({ counterId: counterA, opt_out_version: 99 }), "23503");
    const counterB = await insertCounter({ tenant: TENANT_B, meter: "ai.b.requests" });
    await expectCode(insertLedger({ counterId: counterB }), "23503");
  });

  it("records a platform admin's compensating `adjusted` row against a committed row (T20)", async () => {
    if (skip()) return;
    const reservation = await insertLedger({ counterId: counterA, units: 3 });
    const commit = await insertLedger({ kind: "committed", reservationId: reservation, counterId: counterA, units: 3 });
    await asTenant(TENANT_A, async (c) => {
      // A partial credit: its own units, the original's feature, counter and version.
      await insertLedger({ kind: "adjusted", counterId: counterA, units: 1, adjusts_entry_id: commit }, c);
      await insertLedger({ kind: "adjusted", counterId: counterA, units: 2, adjusts_entry_id: commit }, c);
      const r = await c.query(
        `SELECT units, actor_user_id FROM ${LEDGER} WHERE adjusts_entry_id = $1 ORDER BY units`, [commit],
      );
      expect(r.rows).toEqual([
        { units: 1, actor_user_id: PLATFORM_ADMIN },
        { units: 2, actor_user_id: PLATFORM_ADMIN },
      ]);
    }, true);
  });

  it("never lets a tenant session write an `adjusted` row (42501)", async () => {
    if (skip()) return;
    const reservation = await insertLedger({ counterId: counterA });
    const commit = await insertLedger({ kind: "committed", reservationId: reservation, counterId: counterA });
    await asTenant(TENANT_A, async (c) => {
      await expectCode(
        insertLedger({ kind: "adjusted", counterId: counterA, adjusts_entry_id: commit, actor_user_id: OWNER_A }, c),
        "42501",
      );
    });
  });

  it("isolates `adjusted` rows by tenant, the platform-admin GUC included", async () => {
    if (skip()) return;
    const counterB = await insertCounter({ tenant: TENANT_B, meter: "ai.b.adjusted" });
    const reservationB = await insertLedger({ tenant: TENANT_B, counterId: counterB });
    const commitB = await insertLedger({
      tenant: TENANT_B, kind: "committed", reservationId: reservationB, counterId: counterB,
    });
    const adjustedB = await insertLedger({ tenant: TENANT_B, kind: "adjusted", counterId: counterB, adjusts_entry_id: commitB });
    await asTenant(TENANT_A, async (c) => {
      expect((await c.query(`SELECT 1 FROM ${LEDGER} WHERE id = $1`, [adjustedB])).rowCount).toBe(0);
      // Refused before WITH CHECK: under tenant A's RLS the guard cannot see
      // tenant B's committed row, so it reads as unknown (non-disclosing 23503).
      await expectCode(
        insertLedger({ tenant: TENANT_B, kind: "adjusted", counterId: counterB, adjusts_entry_id: commitB }, c),
        "23503",
      );
    }, true);
  });

  it("checks the `adjusted` shape and its reference (23514 / 23503)", async () => {
    if (skip()) return;
    const reservation = await insertLedger({ counterId: counterA });
    const commit = await insertLedger({ kind: "committed", reservationId: reservation, counterId: counterA });
    const adj = { kind: "adjusted", counterId: counterA, adjusts_entry_id: commit };
    // Only a committed row (a charge) is compensated.
    await expectCode(insertLedger({ ...adj, adjusts_entry_id: reservation }), "23514");
    const released = await insertLedger({ counterId: counterA });
    const release = await insertLedger({ kind: "released", reservationId: released, counterId: counterA });
    await expectCode(insertLedger({ ...adj, adjusts_entry_id: release }), "23514");
    await expectCode(insertLedger({ ...adj, adjusts_entry_id: randomUUID() }), "23503");
    // Pinned to the original's feature, counter and entitlement version.
    await expectCode(insertLedger({ ...adj, feature: "ai.briefing.daily" }), "23503");
    await expectCode(insertLedger({ ...adj, counterId: await insertCounter() }), "23503");
    // A reason and an actor; no outcome, provider usage or cost.
    await expectCode(insertLedger({ ...adj, adjustment_reason: null }), "23514");
    await expectCode(insertLedger({ ...adj, adjustment_reason: "" }), "23514");
    await expectCode(insertLedger({ ...adj, actor_user_id: null }), "23514");
    await expectCode(insertLedger({ ...adj, outcome: "ok" }), "23514");
    await expectCode(insertLedger({ ...adj, input_tokens: 1, token_count_source: "reported" }), "23514");
    await expectCode(
      insertLedger({ ...adj, list_equivalent_cost_micros: 1, cost_currency: "USD", cost_rate_card_version: "rc" }),
      "23514",
    );
    // A retried dispute credit is the same row: the key is required and unique.
    await expectCode(insertLedger({ ...adj, idempotency_key: null }), "23514");
    await expectCode(insertLedger({ ...adj, expires_at: "2026-10-19T10:05:00Z" }), "23514");
    await insertLedger({ ...adj, idempotency_key: "adj-key-dispute-0001" });
    await expectCode(insertLedger({ ...adj, idempotency_key: "adj-key-dispute-0001" }), "23505");
    // Separate namespaces: a tenant reservation with the same key never
    // collides with an admin credit (or reads as its replay).
    await insertLedger({ counterId: counterA, idempotency_key: "adj-key-dispute-0001" });
    await expectCode(insertLedger({ ...adj, reservationId: reservation }), "23514");
    // Adjustment fields belong to `adjusted` rows only.
    await expectCode(insertLedger({ counterId: counterA, adjustment_reason: "x" }), "23514");
    await expectCode(insertLedger({ counterId: counterA, adjusts_entry_id: commit }), "23514");
    await insertLedger(adj);
  });

  it("is append-only for every role (42501)", async () => {
    if (skip()) return;
    await expectCode(pg().admin.query(`UPDATE ${LEDGER} SET units = units`), "42501");
    await expectCode(pg().admin.query(`DELETE FROM ${LEDGER}`), "42501");
    await expectCode(pg().admin.query(`TRUNCATE ${LEDGER} CASCADE`), "42501");
  });

  it("isolates the ledger under the app role: no cross-tenant read or write", async () => {
    if (skip()) return;
    const counterB = await insertCounter({ tenant: TENANT_B, meter: "ai.b.iso" });
    await insertLedger({ tenant: TENANT_B, counterId: counterB });
    await asTenant(TENANT_A, async (c) => {
      const seen = await c.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM ${LEDGER}`);
      expect(seen.rows.map((x) => x.tenant_id)).toEqual([TENANT_A]);
      // Tenant A's own reservation, written as the app role.
      await insertLedger({ counterId: counterA }, c);
      await expectCode(insertLedger({ tenant: TENANT_B, counterId: counterB }, c), "42501");
    });
  });
});

describe("0055 — one usage store, no price column (RT-663 AC-3)", () => {
  it("adds exactly the seven tables and no price column", async () => {
    if (skip()) return;
    const tables = await pg().admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND (table_name LIKE 'ai\\_%' OR table_name LIKE 'tenant\\_ai\\_%')
        ORDER BY table_name`,
    );
    expect(tables.rows.map((t) => t.table_name)).toEqual([...NEW_TABLES].sort());
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ANY($1) AND column_name LIKE '%price%'`,
        [[...NEW_TABLES]],
      ),
    ).toBe(0);
  });
});

describe("0055 — RLS on every new table", () => {
  const expectedCmds: Record<string, string[]> = {
    [CATALOG]: ["INSERT", "SELECT"],
    [CATALOG_FEATURES]: ["INSERT", "SELECT"],
    [CATALOG_METERS]: ["INSERT", "SELECT"],
    [ENTITLEMENTS]: ["INSERT", "SELECT"],
    [OPT_OUTS]: ["INSERT", "SELECT"],
    [COUNTERS]: ["INSERT", "SELECT", "UPDATE"],
    [LEDGER]: ["INSERT", "SELECT"],
  };

  it.each(NEW_TABLES)("%s is RLS enabled and forced with its policies", async (table) => {
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
    expect(pol.rows.map((p) => p.cmd)).toEqual(expectedCmds[table]);
  });

  it.each([ENTITLEMENTS, OPT_OUTS])("%s returns no other tenant's rows under the app role", async (table) => {
    if (skip()) return;
    const seen = await asTenant(TENANT_A, async (c) => {
      const r = await c.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM ${table}`);
      return r.rows.map((x) => x.tenant_id);
    });
    expect(seen).toEqual([TENANT_A]);
    const none = await asTenant("", async (c) => (await c.query(`SELECT 1 FROM ${table}`)).rowCount);
    expect(none).toBe(0);
  });
});

describe("0055 — down → up round-trip", () => {
  it("down drops every 0055 object and keeps older rows; up re-applies", async () => {
    if (skip()) return;
    const tenants = await count(`SELECT COUNT(*) AS n FROM tenants`);
    const stores = await count(`SELECT COUNT(*) AS n FROM stores`);
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    expect(await count(`SELECT COUNT(*) AS n FROM pg_class WHERE relname = ANY($1)`, [[...NEW_TABLES]])).toBe(0);
    expect(
      await count(`SELECT COUNT(*) AS n FROM pg_proc WHERE proname LIKE 'ai\\_%' OR proname LIKE 'tenant\\_ai\\_%'`),
    ).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM tenants`)).toBe(tenants);
    expect(await count(`SELECT COUNT(*) AS n FROM stores`)).toBe(stores);

    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    await ensureAppRole(pg());
    expect(await count(`SELECT COUNT(*) AS n FROM pg_class WHERE relname = ANY($1)`, [[...NEW_TABLES]])).toBe(7);
    expect(await count(`SELECT COUNT(*) AS n FROM ${CATALOG}`)).toBe(1);
  });
});

// --- fixtures ----------------------------------------------------------------

async function newTenant(): Promise<string> {
  const id = randomUUID();
  await pg().admin.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'T', $2)`, [id, `t-${id.slice(0, 8)}`]);
  return id;
}

async function newUser(): Promise<string> {
  const id = randomUUID();
  await pg().admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `u-${id.slice(0, 8)}@rt663.example`]);
  return id;
}
