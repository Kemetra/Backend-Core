/**
 * RT-370 — `docs/operations/sql/device-expiry-rebaseline.sql`, the owner-run
 * re-baseline of the 0040 fleet expiry cluster, run for real with psql
 * inside the test container, as the NOBYPASSRLS `app_test` role (devices is
 * FORCE RLS; the script acts across tenants through the platform-admin GUC).
 *
 *   - the dry run (the default) prints the plan and changes nothing;
 *   - apply spreads the cluster over [today + min_days, today + min_days +
 *     spread_days), only extends, never touches a revoked device, never goes
 *     beyond 90 days, and covers every tenant;
 *   - a same-day re-run changes nothing;
 *   - invalid parameters fail non-zero before anything changes.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hashToken } from "@data-pulse-2/auth";

import {
  APP_ROLE_NAME,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const SCRIPT = readFileSync(
  resolve(__dirname, "..", "..", "..", "..", "docs", "operations", "sql", "device-expiry-rebaseline.sql"),
  "utf8",
);
const SCRIPT_IN_CONTAINER = "/tmp/device-expiry-rebaseline.sql";

const id = (n: string): string => `0a000000-0000-7000-8000-00000370${n}`;
const TENANT_A = id("a001");
const TENANT_B = id("a002");
const STORE_A = id("b001");
const STORE_B = id("b002");
/** The 0040 cluster: one shared expiry, in two tenants. */
const CLUSTER = ["0001", "0002", "0003", "0004", "0005", "0006"].map(id);
const CLUSTER_B = id("0007");
/** Rotated: its expiry is later than any planned one. */
const ROTATED = id("0008");
/** Revoked inside the cluster: never touched. */
const REVOKED = id("0009");
/** Expired, inside its 7-day grace: extended like the rest. */
const IN_GRACE = id("000a");

const DAY = 86_400_000;

let env: PgTestEnv | null = null;
let dockerSkipped = false;
const E = (): PgTestEnv => {
  if (!env) throw new Error("env not initialized");
  return env;
};

interface PsqlRun {
  readonly exitCode: number;
  readonly output: string;
}

async function psql(vars: Record<string, string> = {}): Promise<PsqlRun> {
  const args = Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]);
  const res = await E().container.exec(["psql", "-X", "-U", APP_ROLE_NAME, "-d", "test", ...args, "-f", SCRIPT_IN_CONTAINER]);
  return { exitCode: res.exitCode, output: res.output };
}

async function expiries(): Promise<Map<string, number>> {
  const r = await E().admin.query<{ id: string; expires_at: Date }>("SELECT id, expires_at FROM devices");
  return new Map(r.rows.map((row) => [row.id, row.expires_at.getTime()]));
}

async function dbNow(): Promise<{ now: number; today: number }> {
  const r = await E().admin.query<{ now: Date; today: Date }>(
    "SELECT now() AS now, date_trunc('day', now()) AS today",
  );
  return { now: r.rows[0]!.now.getTime(), today: r.rows[0]!.today.getTime() };
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[device-expiry-rebaseline] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt370-a', 'RT-370 A'), ($2, 'rt370-b', 'RT-370 B')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'A1', 'A'), ($3, $4, 'B1', 'B')`,
    [STORE_A, TENANT_A, STORE_B, TENANT_B],
  );
  const cluster = "now() + interval '10 days'";
  const rows: Array<[string, string, string, string]> = [
    ...CLUSTER.map((d): [string, string, string, string] => [d, TENANT_A, STORE_A, cluster]),
    [CLUSTER_B, TENANT_B, STORE_B, cluster],
    [ROTATED, TENANT_A, STORE_A, "now() + interval '90 days'"],
    [REVOKED, TENANT_A, STORE_A, cluster],
    [IN_GRACE, TENANT_B, STORE_B, "now() - interval '3 days'"],
  ];
  for (const [deviceId, tenantId, storeId, expiresSql] of rows) {
    await a.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, expires_at)
       VALUES ($1, $2, $3, 'RT-370 till', $4, ${expiresSql})`,
      [deviceId, tenantId, storeId, hashToken(`rt370-rebaseline-${deviceId}`)],
    );
  }
  await a.query(`UPDATE devices SET revoked_at = now(), revoke_reason = 'lost' WHERE id = $1`, [REVOKED]);
  await env.container.copyContentToContainer([{ content: SCRIPT, target: SCRIPT_IN_CONTAINER }]);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => dockerSkipped;

describe("device-expiry-rebaseline.sql (RT-370)", () => {
  it("invalid parameters exit non-zero and change nothing", async () => {
    if (skip()) return;
    const before = await expiries();
    for (const vars of [
      { apply: "1", min_days: "80", spread_days: "20" },
      { apply: "1", min_days: "0" },
      { apply: "1", spread_days: "0" },
    ]) {
      const run = await psql(vars);
      expect(run.exitCode).not.toBe(0);
      expect(run.output).toMatch(/invalid parameters/);
    }
    expect(await expiries()).toEqual(before);
  });

  it("the dry run (default) prints the plan and changes nothing", async () => {
    if (skip()) return;
    const before = await expiries();
    const run = await psql();
    expect(run.exitCode).toBe(0);
    expect(run.output).toMatch(/DRY RUN: nothing changed/);
    expect(run.output).toMatch(/would_extend/);
    expect(await expiries()).toEqual(before);
  });

  it("apply spreads the cluster, only extends, skips revoked devices, stays within 90 days, across tenants", async () => {
    if (skip()) return;
    const before = await expiries();
    const run = await psql({ apply: "1" });
    expect(run.exitCode).toBe(0);
    expect(run.output).toMatch(/UPDATE 8/);
    expect(run.output).toMatch(/APPLIED/);

    const after = await expiries();
    const { now, today } = await dbNow();
    const extended = [...CLUSTER, CLUSTER_B, IN_GRACE];
    for (const d of extended) {
      expect(after.get(d)!).toBeGreaterThanOrEqual(today + 30 * DAY);
      expect(after.get(d)!).toBeLessThan(today + 90 * DAY);
      expect(after.get(d)!).toBeLessThanOrEqual(now + 90 * DAY);
      expect(after.get(d)!).toBeGreaterThan(before.get(d)!);
    }
    // The cluster is spread: no two devices share an expiry any more.
    expect(new Set(extended.map((d) => after.get(d))).size).toBe(extended.length);
    // A later expiry (a rotated device) and a revoked device are untouched.
    expect(after.get(ROTATED)).toBe(before.get(ROTATED));
    expect(after.get(REVOKED)).toBe(before.get(REVOKED));
  });

  it("a same-day re-run with the same parameters changes nothing", async () => {
    if (skip()) return;
    const before = await expiries();
    const run = await psql({ apply: "1" });
    expect(run.exitCode).toBe(0);
    expect(run.output).toMatch(/UPDATE 0/);
    expect(await expiries()).toEqual(before);
  });
});
