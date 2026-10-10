/**
 * RT-353 — the audit retention sweep runs on its own credential, on real
 * PostgreSQL with every migration applied.
 *
 * RT-351 proved that the sweep ran on the shared DATABASE_URL role, which the
 * retention decision record (§8) keeps INSERT-only on audit_events: every
 * sweep failed with 42501. Here:
 *
 *   - `app_test` plays the domain role (SELECT + INSERT on audit_events, as
 *     the packages/db helper leaves it);
 *   - `audit_retention_worker` (migration 0005) is the retention role, reached
 *     through AUDIT_RETENTION_DATABASE_URL as in production.
 *
 * The boot checks are run against real grants, so their privilege SQL is
 * proven, not just their branching.
 */
import type { Pool } from "pg";

import {
  applyAllUpAndCreateAppRole,
  createRetentionWorkerPool,
  RETENTION_WORKER_PASSWORD,
  RETENTION_WORKER_ROLE,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { auditRetentionPoolProviderFactory } from "../../src/audit/audit-retention-db-pool";
import {
  AUDIT_RETENTION_JOB_NAME,
  AuditRetentionProcessor,
} from "../../src/audit/audit-retention.processor";
import {
  verifyAuditRetentionRole,
  verifyWorkerDatabaseRole,
} from "../../src/database-role-verifier";
import { auditRetentionRepoProviderFactory } from "../../src/worker.module";

const TENANT = "0a000000-0000-7000-8000-000000353a01";

let env: PgTestEnv | null = null;
let retentionPool: Pool | null = null;

const ORIGINAL_ENV = { ...process.env };

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[retention-role.integration] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  retentionPool = await createRetentionWorkerPool(env);
  await env.admin.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt353-a', 'A')`, [TENANT]);
}, 240_000);

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterAll(async () => {
  if (retentionPool) await retentionPool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

function handles(): { env: PgTestEnv; retentionPool: Pool } | null {
  if (env === null || retentionPool === null) return null;
  return { env, retentionPool };
}

/** Grant something for one test, and always take it back. */
async function withGrant(admin: Pool, grant: string, revoke: string, body: () => Promise<void>): Promise<void> {
  await admin.query(grant);
  try {
    await body();
  } finally {
    await admin.query(revoke);
  }
}

async function seedExpired(admin: Pool, action: string): Promise<void> {
  await admin.query(
    `INSERT INTO audit_events (id, tenant_id, action, occurred_at) VALUES
       (gen_random_uuid(), $1, $2, now() - interval '400 days'),
       (gen_random_uuid(), $1, $2, now() - interval '1 day')`,
    [TENANT, action],
  );
}

describe("RT-353 — boot checks against real grants", () => {
  it("accept the migrated retention role and the INSERT-only domain role", async () => {
    const h = handles();
    if (!h) return;
    await expect(verifyAuditRetentionRole(h.retentionPool, h.env.app)).resolves.toBeUndefined();
    await expect(verifyWorkerDatabaseRole(h.env.app)).resolves.toBeUndefined();
  });

  it("refuse a domain role that can mark retention", async () => {
    const h = handles();
    if (!h) return;
    await withGrant(
      h.env.admin,
      "GRANT UPDATE (retention_marked_at) ON audit_events TO app_test",
      "REVOKE UPDATE (retention_marked_at) ON audit_events FROM app_test",
      async () => {
        await expect(verifyWorkerDatabaseRole(h.env.app)).rejects.toThrow(
          /must not hold UPDATE on audit_events\.retention_marked_at/,
        );
      },
    );
  });

  it("refuse a domain role that can SET ROLE to a marker-capable role (NOINHERIT)", async () => {
    const h = handles();
    if (!h) return;
    // has_column_privilege ignores NOINHERIT memberships, yet SET ROLE reaches them.
    await h.env.admin.query("CREATE ROLE rt353_marker NOLOGIN");
    await h.env.admin.query("GRANT UPDATE (retention_marked_at) ON audit_events TO rt353_marker");
    try {
      await withGrant(
        h.env.admin,
        "GRANT rt353_marker TO app_test WITH INHERIT FALSE",
        "REVOKE rt353_marker FROM app_test",
        async () => {
          await expect(verifyWorkerDatabaseRole(h.env.app)).rejects.toThrow(
            /must not hold UPDATE on audit_events\.retention_marked_at/,
          );
        },
      );
    } finally {
      await h.env.admin.query(
        "REVOKE UPDATE (retention_marked_at) ON audit_events FROM rt353_marker; DROP ROLE rt353_marker",
      );
    }
  });

  it("refuse the domain role as the retention role", async () => {
    const h = handles();
    if (!h) return;
    await expect(verifyAuditRetentionRole(h.env.app, h.env.app)).rejects.toThrow(
      /must be a different role from DATABASE_URL/,
    );
  });

  it("refuse a retention role without its column grant", async () => {
    const h = handles();
    if (!h) return;
    await withGrant(
      h.env.admin,
      `REVOKE UPDATE (retention_marked_at) ON audit_events FROM ${RETENTION_WORKER_ROLE}`,
      `GRANT UPDATE (retention_marked_at) ON audit_events TO ${RETENTION_WORKER_ROLE}`,
      async () => {
        await expect(verifyAuditRetentionRole(h.retentionPool, h.env.app)).rejects.toThrow(
          /is missing required grants: UPDATE \(retention_marked_at\) ON audit_events$/,
        );
      },
    );
  });

  // Revoking a table-level privilege also revokes it on every column, so the
  // table-level UPDATE case restores the 0005 column grant afterwards.
  const RESTORE_MARK = `; GRANT UPDATE (retention_marked_at) ON audit_events TO ${RETENTION_WORKER_ROLE}`;

  it.each([
    ["table-level UPDATE", "UPDATE ON audit_events", RESTORE_MARK],
    ["UPDATE on a fact column", "UPDATE (action) ON audit_events", ""],
    ["INSERT", "INSERT ON audit_events", ""],
    ["DELETE", "DELETE ON audit_events", ""],
    ["TRUNCATE", "TRUNCATE ON audit_events", ""],
  ])("refuse a retention role that also holds %s", async (_name, privilege, restore) => {
    const h = handles();
    if (!h) return;
    await withGrant(
      h.env.admin,
      `GRANT ${privilege} TO ${RETENTION_WORKER_ROLE}`,
      `REVOKE ${privilege} FROM ${RETENTION_WORKER_ROLE}${restore}`,
      async () => {
        await expect(verifyAuditRetentionRole(h.retentionPool, h.env.app)).rejects.toThrow(
          /may hold only SELECT and UPDATE \(retention_marked_at\) on audit_events/,
        );
      },
    );
  });
});

describe("RT-353 — privileges reachable other than by a direct grant", () => {
  it("refuse a retention role that is a NOINHERIT member of a broader role", async () => {
    const h = handles();
    if (!h) return;
    // has_*_privilege ignores NOINHERIT memberships, yet SET ROLE would reach them.
    await h.env.admin.query("CREATE ROLE rt353_broad NOLOGIN");
    await h.env.admin.query("GRANT UPDATE ON audit_events TO rt353_broad");
    try {
      await withGrant(
        h.env.admin,
        `GRANT rt353_broad TO ${RETENTION_WORKER_ROLE} WITH INHERIT FALSE`,
        `REVOKE rt353_broad FROM ${RETENTION_WORKER_ROLE}`,
        async () => {
          await expect(verifyAuditRetentionRole(h.retentionPool, h.env.app)).rejects.toThrow(
            /and no role membership/,
          );
        },
      );
    } finally {
      await h.env.admin.query("REVOKE UPDATE ON audit_events FROM rt353_broad; DROP ROLE rt353_broad");
    }
  });

  it("refuse MAINTAIN on audit_events (PostgreSQL 17+ only)", async () => {
    const h = handles();
    if (!h) return;
    const v = await h.env.admin.query<{ n: number }>(
      "SELECT current_setting('server_version_num')::int AS n",
    );
    if (v.rows[0]!.n < 170000) return; // no MAINTAIN privilege before PG17
    await withGrant(
      h.env.admin,
      `GRANT MAINTAIN ON audit_events TO ${RETENTION_WORKER_ROLE}`,
      `REVOKE MAINTAIN ON audit_events FROM ${RETENTION_WORKER_ROLE}`,
      async () => {
        await expect(verifyAuditRetentionRole(h.retentionPool, h.env.app)).rejects.toThrow(
          /may hold only SELECT/,
        );
      },
    );
  });
});

describe("RT-353 — the sweep runs on AUDIT_RETENTION_DATABASE_URL", () => {
  it("marks expired rows through the production wiring", async () => {
    const h = handles();
    if (!h) return;
    await seedExpired(h.env.admin, "rt353.wired");
    process.env["NODE_ENV"] = "production";
    process.env["AUDIT_RETENTION_DATABASE_URL"] =
      `postgres://${RETENTION_WORKER_ROLE}:${RETENTION_WORKER_PASSWORD}@${h.env.host}:${h.env.port}/test`;

    const wrapper = auditRetentionPoolProviderFactory(h.env.app);
    try {
      const processor = new AuditRetentionProcessor(auditRetentionRepoProviderFactory(wrapper));
      const result = await processor.process(AUDIT_RETENTION_JOB_NAME, {});
      expect(result.markedCount).toBeGreaterThanOrEqual(1);
    } finally {
      await wrapper.onModuleDestroy();
    }

    const r = await h.env.admin.query<{ old_unmarked: string; new_marked: string }>(
      `SELECT count(*) FILTER (WHERE occurred_at < now() - interval '365 days'
                                 AND retention_marked_at IS NULL) AS old_unmarked,
              count(*) FILTER (WHERE occurred_at > now() - interval '2 days'
                                 AND retention_marked_at IS NOT NULL) AS new_marked
         FROM audit_events WHERE action = 'rt353.wired'`,
    );
    expect(r.rows[0]).toEqual({ old_unmarked: "0", new_marked: "0" });
  });

  it("the same sweep on the domain role is refused (the RT-351 failure)", async () => {
    const h = handles();
    if (!h) return;
    await seedExpired(h.env.admin, "rt353.domain");
    const processor = new AuditRetentionProcessor(
      auditRetentionRepoProviderFactory({ pool: h.env.app }),
    );
    await expect(processor.process(AUDIT_RETENTION_JOB_NAME, {})).rejects.toMatchObject({
      code: "42501",
    });
  });
});
