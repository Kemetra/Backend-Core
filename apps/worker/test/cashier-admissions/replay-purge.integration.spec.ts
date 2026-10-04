/**
 * RT-209 — purge of expired cashier-admission replay rows on real PostgreSQL
 * (every migration applied).
 *
 * `cashier_admission_requests` (0035) is FORCE RLS with tenant-only policies:
 * unlike `outbox_events` / `audit_events` it has NO platform-admin branch, so
 * a single platform-admin DELETE sees nothing. The sweep therefore lists
 * tenant ids as platform admin (the `tenants` policy has that branch) and
 * purges each tenant under that tenant's own GUC.
 *
 * The sweep runs here as a NOSUPERUSER / NOBYPASSRLS probe role holding ONLY
 * the grants the domain role (DATABASE_URL, shared by api and worker) already
 * needs: SELECT on `tenants` (the RT-179 stock sweep's tenant listing) and the
 * 0035 production grants on `cashier_admission_requests` (SELECT, INSERT,
 * UPDATE, DELETE — the api's per-device purge already deletes). So the purge
 * needs no new grant, role or migration.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (RT-123
 * retention-rls precedent).
 */
import { createHash } from "node:crypto";

import { runWithTenantContext } from "@data-pulse-2/db";
import { Pool } from "pg";

import {
  applyAllUpAndCreateAppRole,
  endPoolQuietly,
  guardPool,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import {
  REPLAY_PURGE_JOB_NAME,
  ReplayPurgeProcessor,
} from "../../src/cashier-admissions/replay-purge.processor";
import { PgReplayPurgeRepository } from "../../src/cashier-admissions/replay-purge.repository";

const TENANT_A = "0a000000-0000-7000-8000-000000209a01";
const TENANT_B = "0b000000-0000-7000-8000-000000209b01";
// Suspended: its stored display names are still PII and still expire.
const TENANT_C = "0c000000-0000-7000-8000-000000209c01";

const STORE_A = "0a000000-0000-7000-8000-000000209a02";
const STORE_B = "0b000000-0000-7000-8000-000000209b02";
const STORE_C = "0c000000-0000-7000-8000-000000209c02";
const DEVICE_A = "0a000000-0000-7000-8000-000000209a03";
const DEVICE_B = "0b000000-0000-7000-8000-000000209b03";
const DEVICE_C = "0c000000-0000-7000-8000-000000209c03";
const ADMISSION_A = "0a000000-0000-7000-8000-000000209a04";
const ADMISSION_B = "0b000000-0000-7000-8000-000000209b04";
const ADMISSION_C = "0c000000-0000-7000-8000-000000209c04";
const USER = "0a000000-0000-7000-8000-000000209a05";

const A_EXPIRED_1 = "0a000000-0000-7000-8000-000000209a11";
const A_EXPIRED_2 = "0a000000-0000-7000-8000-000000209a12";
const A_EXPIRED_3 = "0a000000-0000-7000-8000-000000209a13";
const A_LIVE = "0a000000-0000-7000-8000-000000209a19";
const B_EXPIRED = "0b000000-0000-7000-8000-000000209b11";
const B_LIVE = "0b000000-0000-7000-8000-000000209b19";
const C_EXPIRED = "0c000000-0000-7000-8000-000000209c11";

const ALL_REQUESTS = [A_EXPIRED_1, A_EXPIRED_2, A_EXPIRED_3, A_LIVE, B_EXPIRED, B_LIVE, C_EXPIRED];

const PROBE_ROLE = "rt209_domain_probe";
const PROBE_PASSWORD = "rt209_probe";

let env: PgTestEnv | null = null;
let probe: Pool | null = null;

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[replay-purge.integration] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;

  await a.query(`CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
  await a.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
  await a.query(`GRANT SELECT ON tenants TO ${PROBE_ROLE}`);
  await a.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON cashier_admission_requests TO ${PROBE_ROLE}`,
  );
  probe = guardPool(
    new Pool({
      connectionString: `postgres://${PROBE_ROLE}:${PROBE_PASSWORD}@${env.host}:${env.port}/test`,
    }),
  );

  await a.query(
    `INSERT INTO tenants (id, slug, name, status) VALUES
       ($1, 'rt209-a', 'A', 'active'), ($2, 'rt209-b', 'B', 'active'),
       ($3, 'rt209-c', 'C', 'suspended')`,
    [TENANT_A, TENANT_B, TENANT_C],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $4, 'a', 'A'), ($2, $5, 'b', 'B'), ($3, $6, 'c', 'C')`,
    [STORE_A, STORE_B, STORE_C, TENANT_A, TENANT_B, TENANT_C],
  );
  await a.query(`INSERT INTO users (id, email) VALUES ($1, 'rt209@fixture.invalid')`, [USER]);
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES
       ($1, $4, $7, decode(repeat('a2', 32), 'hex')),
       ($2, $5, $8, decode(repeat('b2', 32), 'hex')),
       ($3, $6, $9, decode(repeat('c2', 32), 'hex'))`,
    [DEVICE_A, DEVICE_B, DEVICE_C, TENANT_A, TENANT_B, TENANT_C, STORE_A, STORE_B, STORE_C],
  );
  await a.query(
    `INSERT INTO cashier_admissions
       (id, tenant_id, store_id, user_id, device_id, mode, created_at, renewed_at, expires_at)
     VALUES
       ($1, $4, $7, $10, $11, 'online', now() - interval '3 hours', now() - interval '3 hours', now() - interval '2 hours'),
       ($2, $5, $8, $10, $12, 'online', now() - interval '3 hours', now() - interval '3 hours', now() - interval '2 hours'),
       ($3, $6, $9, $10, $13, 'online', now() - interval '3 hours', now() - interval '3 hours', now() - interval '2 hours')`,
    [
      ADMISSION_A, ADMISSION_B, ADMISSION_C, TENANT_A, TENANT_B, TENANT_C,
      STORE_A, STORE_B, STORE_C, USER, DEVICE_A, DEVICE_B, DEVICE_C,
    ],
  );

  const rows: Array<[string, string, string, string, "expired" | "live"]> = [
    [A_EXPIRED_1, TENANT_A, DEVICE_A, ADMISSION_A, "expired"],
    [A_EXPIRED_2, TENANT_A, DEVICE_A, ADMISSION_A, "expired"],
    [A_EXPIRED_3, TENANT_A, DEVICE_A, ADMISSION_A, "expired"],
    [A_LIVE, TENANT_A, DEVICE_A, ADMISSION_A, "live"],
    [B_EXPIRED, TENANT_B, DEVICE_B, ADMISSION_B, "expired"],
    [B_LIVE, TENANT_B, DEVICE_B, ADMISSION_B, "live"],
    [C_EXPIRED, TENANT_C, DEVICE_C, ADMISSION_C, "expired"],
  ];
  for (const [id, tenant, device, admission, state] of rows) {
    await a.query(
      `INSERT INTO cashier_admission_requests
         (id, tenant_id, device_id, key_hash, request_hash, admission_id, response_body,
          created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               '{"outcome":"admitted","cashier":{"display_name":"Fixture Cashier"}}'::jsonb,
               now() - interval '2 hours',
               CASE WHEN $7 = 'expired' THEN now() - interval '1 minute'
                    ELSE now() + interval '1 hour' END)`,
      [id, tenant, device, digest(`key:${id}`), digest(`body:${id}`), admission, state],
    );
  }
}, 240_000);

afterAll(async () => {
  if (probe) await endPoolQuietly(probe);
  if (env) await stopPgEnv(env);
}, 60_000);

function pg(): { env: PgTestEnv; probe: Pool } {
  if (!env || !probe) throw new Error("Docker unavailable");
  return { env, probe };
}

const skipped = (): boolean => env === null;

async function remaining(): Promise<string[]> {
  const r = await pg().env.admin.query<{ id: string }>(
    `SELECT id FROM cashier_admission_requests WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [ALL_REQUESTS],
  );
  return r.rows.map((row) => row.id);
}

describe("RT-209 — role and RLS posture", () => {
  it("the sweep's role is NOSUPERUSER and NOBYPASSRLS (it cannot rely on bypass)", async () => {
    if (skipped()) return;
    const r = await pg().probe.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("a platform-admin DELETE sees no replay row: the table has no platform branch", async () => {
    if (skipped()) return;
    const deleted = await runWithTenantContext(
      pg().probe,
      { tenantId: null, isPlatformAdmin: true },
      async (client) =>
        (await client.query(`DELETE FROM cashier_admission_requests WHERE expires_at <= clock_timestamp()`))
          .rowCount,
    );
    expect(deleted).toBe(0);
    expect(await remaining()).toHaveLength(ALL_REQUESTS.length);
  });

  it("the tenant listing (platform admin) returns every tenant, suspended included", async () => {
    if (skipped()) return;
    const ids = await new PgReplayPurgeRepository(pg().probe).listTenantIds();
    expect(ids).toEqual(expect.arrayContaining([TENANT_A, TENANT_B, TENANT_C]));
  });
});

describe("RT-209 — one tenant-scoped batch", () => {
  it("deletes at most batchSize expired rows, only of that tenant, and no live row", async () => {
    if (skipped()) return;
    const repo = new PgReplayPurgeRepository(pg().probe);

    expect(await repo.purgeExpiredBatch(TENANT_A, 2)).toBe(2);

    const left = await remaining();
    // Exactly one of A's three expired rows is left; A's live row and every
    // row of B and C are untouched.
    expect(left.filter((id) => [A_EXPIRED_1, A_EXPIRED_2, A_EXPIRED_3].includes(id))).toHaveLength(1);
    expect(left).toEqual(expect.arrayContaining([A_LIVE, B_EXPIRED, B_LIVE, C_EXPIRED]));
  });
});

describe("RT-209 — the scheduled sweep", () => {
  function sweeper(batchSize: number): ReplayPurgeProcessor {
    return new ReplayPurgeProcessor(new PgReplayPurgeRepository(pg().probe), batchSize, () => undefined);
  }

  it("purges every tenant's expired rows (A, B and suspended C) and keeps the live ones", async () => {
    if (skipped()) return;
    const result = await sweeper(2).process(REPLAY_PURGE_JOB_NAME, {});

    expect(result).toMatchObject({ purged: 3, failedTenants: 0 });
    expect(result.tenants).toBeGreaterThanOrEqual(3);
    expect((await remaining()).sort()).toEqual([A_LIVE, B_LIVE].sort());
  });

  it("is idempotent: a second sweep purges nothing", async () => {
    if (skipped()) return;
    const result = await sweeper(2).process(REPLAY_PURGE_JOB_NAME, {});
    expect(result).toMatchObject({ purged: 0, failedTenants: 0 });
    expect((await remaining()).sort()).toEqual([A_LIVE, B_LIVE].sort());
  });

  it("also runs as the domain role shape (app_test)", async () => {
    if (skipped()) return;
    const processor = new ReplayPurgeProcessor(
      new PgReplayPurgeRepository(pg().env.app),
      500,
      () => undefined,
    );
    await expect(processor.process(REPLAY_PURGE_JOB_NAME, {})).resolves.toMatchObject({
      purged: 0,
      failedTenants: 0,
    });
  });
});
