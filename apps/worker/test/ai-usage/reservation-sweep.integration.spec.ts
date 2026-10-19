/**
 * RT-664 — the AI usage reservation sweep (T17) on real PostgreSQL (every
 * migration applied, incl. 0055).
 *
 * The sweep runs as a NOSUPERUSER / NOBYPASSRLS probe role holding ONLY the
 * RT-664 domain grants on the 0055 tables (SELECT, INSERT on the ledger;
 * SELECT, INSERT, UPDATE on the counters; SELECT on the rest) plus SELECT on
 * `tenants`. It proves:
 *   - a reservation whose TTL passed and that no commit or release closed is
 *     released as `reservation_expired`: the counter's `reserved` drops and
 *     `used` is unchanged (never charged, D-8);
 *   - a live reservation, a closed one and one older than the lookback are
 *     left alone; tenants are swept under their own GUC (RLS);
 *   - a second sweep is a no-op (idempotent).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import { Pool } from "pg";

import {
  applyAllUpAndCreateAppRole,
  endPoolQuietly,
  guardPool,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { RESERVATION_SWEEP_JOB_NAME, ReservationSweepProcessor } from "../../src/ai-usage/reservation-sweep.processor";
import { PgReservationSweepRepository } from "../../src/ai-usage/reservation-sweep.repository";

const id = (t: string, n: string): string => `0${t}000000-0000-7000-8000-000000664${n}`;
const TENANT_A = id("a", "a01");
const TENANT_B = id("b", "b01");
const USER = id("a", "a05");
const COUNTER_A = id("a", "a10");
const COUNTER_B = id("b", "b10");
const STUCK_A = id("a", "a21");
const LIVE_A = id("a", "a22");
const CLOSED_A = id("a", "a23");
const CLOSED_A_TERMINAL = id("a", "a24");
const ANCIENT_A = id("a", "a25");
const STUCK_B = id("b", "b21");

const PROBE_ROLE = "rt664_domain_probe";
const PROBE_PASSWORD = "rt664_probe";

let env: PgTestEnv | null = null;
let probe: Pool | null = null;

async function seed(a: Pool): Promise<void> {
  await a.query(`INSERT INTO tenants (id, slug, name, status) VALUES ($1, 'rt664-a', 'A', 'active'), ($2, 'rt664-b', 'B', 'suspended')`, [TENANT_A, TENANT_B]);
  await a.query(`INSERT INTO users (id, email) VALUES ($1, 'rt664@fixture.invalid')`, [USER]);
  const client = await a.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO ai_plan_catalog (plan_code, catalog_version) VALUES ('ai_assist', 1)`);
    await client.query(`INSERT INTO ai_plan_catalog_features VALUES ('ai_assist', 1, 'ai.ask')`);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  for (const [tenant, counter, reserved] of [[TENANT_A, COUNTER_A, 3], [TENANT_B, COUNTER_B, 1]] as const) {
    await a.query(
      `INSERT INTO tenant_ai_entitlements (id, tenant_id, entitlement_version, state, plan_code, catalog_version, effective_from,
         source, reason, created_by_user_id, content_hash)
       VALUES (gen_random_uuid(), $1, 1, 'active', 'ai_assist', 1, now() - interval '30 days', 'manual_platform', 'seed', $2,
               decode(repeat('ab', 32), 'hex'))`,
      [tenant, USER],
    );
    await a.query(
      `INSERT INTO ai_usage_counters (id, tenant_id, meter, window_kind, window_start, used, reserved)
       VALUES ($1, $2, 'ask_requests', 'month', date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', 4, $3)`,
      [counter, tenant, reserved],
    );
  }
  const reserve = (rid: string, tenant: string, counter: string, createdAgo: string, expiresAgo: string) =>
    a.query(
      `INSERT INTO ai_usage_ledger (id, tenant_id, reservation_id, entry_kind, feature_id, counter_id, units, entitlement_version,
         idempotency_key, created_at, expires_at)
       VALUES ($1::uuid, $2, $1::uuid, 'reserved', 'ai.ask', $3, 1, 1, $6, now() - $4::interval, now() - $5::interval)`,
      [rid, tenant, counter, createdAgo, expiresAgo, `${rid}-key`],
    );
  await reserve(STUCK_A, TENANT_A, COUNTER_A, "1 hour", "30 minutes");
  await reserve(LIVE_A, TENANT_A, COUNTER_A, "1 minute", "-14 minutes");
  await reserve(CLOSED_A, TENANT_A, COUNTER_A, "1 hour", "30 minutes");
  await a.query(
    `INSERT INTO ai_usage_ledger (id, tenant_id, reservation_id, entry_kind, feature_id, counter_id, units, entitlement_version, outcome)
     VALUES ($1, $2, $3, 'committed', 'ai.ask', $4, 1, 1, 'ok')`,
    [CLOSED_A_TERMINAL, TENANT_A, CLOSED_A, COUNTER_A],
  );
  await reserve(ANCIENT_A, TENANT_A, COUNTER_A, "40 days", "39 days");
  await reserve(STUCK_B, TENANT_B, COUNTER_B, "2 hours", "1 hour");
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[reservation-sweep.integration] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;
  await a.query(`CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
  await a.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
  await a.query(`GRANT SELECT ON tenants TO ${PROBE_ROLE}`);
  await a.query(`GRANT SELECT, INSERT ON ai_usage_ledger TO ${PROBE_ROLE}`);
  await a.query(`GRANT SELECT, INSERT, UPDATE ON ai_usage_counters TO ${PROBE_ROLE}`);
  await a.query(`GRANT SELECT ON tenant_ai_entitlements, tenant_ai_feature_opt_outs TO ${PROBE_ROLE}`);
  probe = guardPool(new Pool({ connectionString: `postgres://${PROBE_ROLE}:${PROBE_PASSWORD}@${env.host}:${env.port}/test` }));
  await seed(a);
}, 240_000);

afterAll(async () => {
  if (probe) await endPoolQuietly(probe);
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

async function terminal(reservationId: string): Promise<{ entry_kind: string; outcome: string } | undefined> {
  const r = await env!.admin.query(
    `SELECT entry_kind, outcome FROM ai_usage_ledger WHERE reservation_id = $1 AND entry_kind IN ('committed', 'released')`,
    [reservationId],
  );
  return r.rows[0];
}

async function counterOf(counterId: string): Promise<{ used: number; reserved: number }> {
  const r = await env!.admin.query(`SELECT used::int, reserved::int FROM ai_usage_counters WHERE id = $1`, [counterId]);
  return r.rows[0];
}

describe("RT-664 reservation sweep on real Postgres", () => {
  it("releases only the stuck reservations within the lookback, per tenant, never charging them", async () => {
    if (skip()) return;
    const processor = new ReservationSweepProcessor(new PgReservationSweepRepository(probe!), { lookbackSeconds: 7 * 24 * 3600, log: () => undefined });
    const result = await processor.process(RESERVATION_SWEEP_JOB_NAME, {});
    expect(result).toMatchObject({ tenants: 2, released: 2, failedTenants: 0 });

    expect(await terminal(STUCK_A)).toEqual({ entry_kind: "released", outcome: "reservation_expired" });
    expect(await terminal(STUCK_B)).toEqual({ entry_kind: "released", outcome: "reservation_expired" });
    expect(await terminal(LIVE_A)).toBeUndefined();
    expect(await terminal(ANCIENT_A)).toBeUndefined();
    expect(await terminal(CLOSED_A)).toEqual({ entry_kind: "committed", outcome: "ok" });
    expect(await counterOf(COUNTER_A)).toEqual({ used: 4, reserved: 2 });
    expect(await counterOf(COUNTER_B)).toEqual({ used: 4, reserved: 0 });
  });

  it("a role without the owner-gated grants is not provisioned: the sweep skips and touches nothing", async () => {
    if (skip()) return;
    const a = env!.admin;
    await a.query(`CREATE ROLE rt664_ungranted LOGIN PASSWORD 'rt664_ungranted' NOSUPERUSER NOBYPASSRLS`);
    await a.query(`GRANT USAGE ON SCHEMA public TO rt664_ungranted`);
    await a.query(`GRANT SELECT ON tenants TO rt664_ungranted`);
    const ungranted = guardPool(new Pool({ connectionString: `postgres://rt664_ungranted:rt664_ungranted@${env!.host}:${env!.port}/test` }));
    try {
      const repo = new PgReservationSweepRepository(ungranted);
      expect(await repo.isProvisioned()).toBe(false);
      expect(await new PgReservationSweepRepository(probe!).isProvisioned()).toBe(true);
      const result = await new ReservationSweepProcessor(repo, { log: () => undefined }).process(RESERVATION_SWEEP_JOB_NAME, {});
      expect(result).toMatchObject({ tenants: 0, released: 0, failedTenants: 0 });
    } finally {
      await endPoolQuietly(ungranted);
    }
  });

  it("a second sweep releases nothing (idempotent)", async () => {
    if (skip()) return;
    const processor = new ReservationSweepProcessor(new PgReservationSweepRepository(probe!), { log: () => undefined });
    expect(await processor.process(RESERVATION_SWEEP_JOB_NAME, {})).toMatchObject({ released: 0, failedTenants: 0 });
    expect(await counterOf(COUNTER_A)).toEqual({ used: 4, reserved: 2 });
  });
});
