/**
 * RT-664 — fixture for the AI entitlements db-integration specs.
 *
 *   - Every migration (incl. 0055) on Testcontainers Postgres, with the
 *     NOBYPASSRLS `app_test` pool.
 *   - The 0055 tables get EXACTLY the domain-role grants the runtime needs
 *     (`docs/operations/sql/ai-entitlements-domain-grants.sql`): the harness
 *     default grants SELECT/INSERT/UPDATE/DELETE on every table, which would
 *     hide a missing grant or a locking read that needs UPDATE.
 *   - A code-owned test catalogue (`ai_assist@1`, `ai_ops@1`), written by the
 *     superuser in one transaction (a catalog version is sealed at commit).
 *   - `newTenant()` mints an isolated tenant (two stores, an owner) per test,
 *     so counters never leak between cases.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { ResolvedContext, StoreAccess } from "../../../src/context/types";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";

export const AI_TABLE_GRANTS: ReadonlyArray<readonly [string, string]> = [
  ["ai_plan_catalog", "SELECT"],
  ["ai_plan_catalog_features", "SELECT"],
  ["ai_plan_catalog_meters", "SELECT"],
  ["tenant_ai_entitlements", "SELECT, INSERT"],
  ["tenant_ai_feature_opt_outs", "SELECT, INSERT"],
  ["ai_usage_ledger", "SELECT, INSERT"],
  ["ai_usage_counters", "SELECT, INSERT, UPDATE"],
];

/** Features of the test catalogue. */
export const F_BRIEFING = "ai.briefing.daily"; // store meter, day, limit 3
export const F_ASK = "ai.ask"; // tenant meter, month, limit 5
export const F_DOCTOR = "ai.catalog.doctor"; // ai_ops only
export const F_TWO_METERS = "ai.explain.ops"; // two meters → fails closed
export const F_NO_METER = "ai.lost_sales.insight"; // no meter → fails closed

export const ASK_LIMIT = 5;
export const BRIEFING_LIMIT = 3;

export const PLATFORM_ADMIN = "0a000000-0000-7000-8000-0000066400a1";

export async function restrictAiGrants(admin: Pool, role: string): Promise<void> {
  for (const [table, privileges] of AI_TABLE_GRANTS) {
    await admin.query(`REVOKE ALL ON ${table} FROM ${role}`);
    await admin.query(`GRANT ${privileges} ON ${table} TO ${role}`);
  }
}

type Meter = { meter: string; window: "day" | "month"; scope: "tenant" | "store"; limit: number };

async function seedPlan(admin: Pool, planCode: string, features: Record<string, readonly Meter[]>): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO ai_plan_catalog (plan_code, catalog_version) VALUES ($1, 1)`, [planCode]);
    for (const [featureId, meters] of Object.entries(features)) {
      await client.query(`INSERT INTO ai_plan_catalog_features (plan_code, catalog_version, feature_id) VALUES ($1, 1, $2)`, [
        planCode,
        featureId,
      ]);
      for (const m of meters) {
        await client.query(
          `INSERT INTO ai_plan_catalog_meters
             (plan_code, catalog_version, feature_id, meter, unit, window_kind, meter_scope, limit_value)
           VALUES ($1, 1, $2, $3, 'request', $4, $5, $6)`,
          [planCode, featureId, m.meter, m.window, m.scope, m.limit],
        );
      }
    }
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

export async function seedCatalog(admin: Pool): Promise<void> {
  const briefing: Meter = { meter: "briefings", window: "day", scope: "store", limit: BRIEFING_LIMIT };
  const ask: Meter = { meter: "ask_requests", window: "month", scope: "tenant", limit: ASK_LIMIT };
  await seedPlan(admin, "ai_assist", {
    [F_BRIEFING]: [briefing],
    [F_ASK]: [ask],
    [F_TWO_METERS]: [
      { meter: "explain_a", window: "month", scope: "tenant", limit: 5 },
      { meter: "explain_b", window: "day", scope: "tenant", limit: 5 },
    ],
    [F_NO_METER]: [],
  });
  await seedPlan(admin, "ai_ops", {
    [F_ASK]: [ask],
    [F_DOCTOR]: [{ meter: "doctor_runs", window: "month", scope: "tenant", limit: 2 }],
  });
}

export async function seedPlatformAdmin(admin: Pool): Promise<void> {
  await admin.query(`INSERT INTO users (id, email, is_platform_admin) VALUES ($1, 'rt664-platform@example.test', true)`, [
    PLATFORM_ADMIN,
  ]);
}

export interface AiTenant {
  readonly tenantId: string;
  readonly storeA: string;
  readonly storeB: string;
  readonly ownerId: string;
}

/** A fresh active tenant with two stores and an owner user (no membership needed by the services). */
export async function newTenant(admin: Pool, status: "active" | "suspended" = "active"): Promise<AiTenant> {
  const tenantId = randomUUID();
  const storeA = randomUUID();
  const storeB = randomUUID();
  const ownerId = randomUUID();
  const tag = tenantId.slice(0, 8);
  await admin.query(`INSERT INTO tenants (id, slug, name, default_currency_code, status) VALUES ($1, $2, $2, 'USD', $3)`, [
    tenantId,
    `rt664-${tag}`,
    status,
  ]);
  await admin.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'A', 'A'), ($2, $3, 'B', 'B')`, [
    storeA,
    storeB,
    tenantId,
  ]);
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [ownerId, `rt664-${tag}@example.test`]);
  return { tenantId, storeA, storeB, ownerId };
}

export function ctxFor(
  tenant: AiTenant,
  overrides: Partial<ResolvedContext> & { storeAccess?: StoreAccess } = {},
): ResolvedContext {
  return {
    userId: tenant.ownerId,
    tenantId: tenant.tenantId,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    storeAccess: { kind: "all" },
    ...overrides,
  };
}

/** Start the database for a spec; null (with a warning) when Docker is unavailable and skipping is allowed. */
export async function startAiDb(label: string): Promise<PgTestEnv | null> {
  try {
    const env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await restrictAiGrants(env.admin, "app_test");
    await seedCatalog(env.admin);
    await seedPlatformAdmin(env.admin);
    return env;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw new Error(`Container start failed: ${reason}`);
    // eslint-disable-next-line no-console
    console.warn(`\n[${label}] Docker NOT AVAILABLE: ${reason}\n`);
    return null;
  }
}

export async function stopAiDb(env: PgTestEnv | null): Promise<void> {
  if (env !== null) await stopPgEnv(env);
}

/** Admin read of one counter of a tenant (null when it does not exist). */
export async function counter(
  admin: Pool,
  tenantId: string,
  meter: string,
  storeId: string | null = null,
): Promise<{ used: number; reserved: number } | null> {
  const r = await admin.query<{ used: string; reserved: string }>(
    `SELECT used::text, reserved::text FROM ai_usage_counters
      WHERE tenant_id = $1 AND meter = $2 AND store_id IS NOT DISTINCT FROM $3::uuid`,
    [tenantId, meter, storeId],
  );
  const row = r.rows[0];
  return row === undefined ? null : { used: Number(row.used), reserved: Number(row.reserved) };
}

export async function ledgerKinds(admin: Pool, tenantId: string): Promise<string[]> {
  const r = await admin.query<{ entry_kind: string }>(
    `SELECT entry_kind FROM ai_usage_ledger WHERE tenant_id = $1 ORDER BY created_at, entry_kind`,
    [tenantId],
  );
  return r.rows.map((row) => row.entry_kind);
}

let keySeq = 0;
/** A fresh 16+ char Idempotency-Key. */
export function key(): string {
  keySeq += 1;
  return `rt664-key-${String(keySeq).padStart(8, "0")}-${randomUUID().slice(0, 8)}`;
}
