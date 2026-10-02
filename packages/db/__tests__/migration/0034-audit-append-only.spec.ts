/**
 * 0034_audit_events_append_only — RT-133 (RT-120 C-1).
 *
 * Proves, on real PostgreSQL with every migration applied, that audit_events
 * is append-only at the database boundary for every role:
 *
 *   - a NOBYPASSRLS domain role holding full table grants (the RT-120 repro
 *     shape) can INSERT, but cannot UPDATE or DELETE — neither in its own
 *     tenant context nor under the platform-admin GUC;
 *   - the table owner cannot UPDATE, DELETE or TRUNCATE either;
 *   - the retention design still works: the audit_retention_worker role marks
 *     retention_marked_at once, and cannot re-mark or touch other columns;
 *   - the schema's ON DELETE SET NULL still works when a referenced store or
 *     user is hard-deleted, and the audit row survives;
 *   - down removes the guard, and up restores it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

import {
  applyAllUpAndCreateAppRole,
  createRetentionWorkerPool,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_SQL = readFileSync(resolve(DRIZZLE_DIR, "0034_audit_events_append_only.sql"), "utf8");
const DOWN_SQL = readFileSync(
  resolve(DRIZZLE_DIR, "0034_audit_events_append_only.down.sql"),
  "utf8",
);

const DOMAIN_ROLE = "rt133_domain";
const DOMAIN_PASSWORD = "rt133_domain";

const TENANT_A = "0a000000-0000-7000-8000-000000134a01";
const TENANT_B = "0b000000-0000-7000-8000-000000134b01";
const STORE_A = "0a000000-0000-7000-8000-000000134a02";
const USER_A = "0a000000-0000-7000-8000-000000134a03";
const ROW_A = "0a000000-0000-7000-8000-000000134a10";
const ROW_B = "0b000000-0000-7000-8000-000000134b10";
const ROW_OLD = "0a000000-0000-7000-8000-000000134a11";
const ROW_FK = "0a000000-0000-7000-8000-000000134a12";

let env: PgTestEnv | null = null;
let domain: Pool | null = null;
let retention: Pool | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0034-audit-append-only.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);

  // A domain role shaped like RT-120's repro: NOBYPASSRLS, non-superuser,
  // with full DML grants on audit_events (no REVOKE to lean on).
  await env.admin.query(
    `CREATE ROLE ${DOMAIN_ROLE} LOGIN PASSWORD '${DOMAIN_PASSWORD}' NOSUPERUSER NOBYPASSRLS`,
  );
  await env.admin.query(`GRANT USAGE ON SCHEMA public TO ${DOMAIN_ROLE}`);
  await env.admin.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON audit_events TO ${DOMAIN_ROLE}`,
  );
  domain = new Pool({
    connectionString: `postgres://${DOMAIN_ROLE}:${DOMAIN_PASSWORD}@${env.host}:${env.port}/test`,
  });
  retention = await createRetentionWorkerPool(env);

  await env.admin.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt133-a', 'A'), ($2, 'rt133-b', 'B')`,
    [TENANT_A, TENANT_B],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'rt133', 'RT-133 store')`,
    [STORE_A, TENANT_A],
  );
  await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt133@example.test')`, [
    USER_A,
  ]);
  await env.admin.query(
    `INSERT INTO audit_events (id, tenant_id, action, occurred_at) VALUES
       ($1, $3, 'rt133.seed', now()),
       ($2, $4, 'rt133.seed', now()),
       ($5, $3, 'rt133.old', now() - interval '400 days')`,
    [ROW_A, ROW_B, TENANT_A, TENANT_B, ROW_OLD],
  );
  await env.admin.query(
    `INSERT INTO audit_events (id, tenant_id, store_id, actor_user_id, action)
     VALUES ($1, $2, $3, $4, 'rt133.fk')`,
    [ROW_FK, TENANT_A, STORE_A, USER_A],
  );
}, 240_000);

afterAll(async () => {
  if (domain) await domain.end().catch(() => undefined);
  if (retention) await retention.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

/** Run `sql` on `pool` inside a transaction with the given GUCs. */
async function withGucs(
  pool: Pool | null,
  gucs: { tenant?: string; platformAdmin?: boolean },
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  if (!pool) throw new Error("pool not initialized");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [gucs.tenant ?? ""]);
    await client.query("SELECT set_config('app.is_platform_admin', $1, true)", [
      gucs.platformAdmin ? "true" : "false",
    ]);
    const res = await client.query(sql, params);
    await client.query("COMMIT");
    return res.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function asDomain(
  gucs: { tenant?: string; platformAdmin?: boolean },
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  return withGucs(domain, gucs, sql, params);
}

/**
 * The retention role runs under forced RLS, so it needs a GUC context to see
 * rows at all. Making the sweep do that is RT-123; here it only proves the
 * trigger admits the marking itself.
 */
function asRetention(sql: string, params: unknown[] = []): Promise<number> {
  return withGucs(retention, { tenant: TENANT_A }, sql, params);
}

const APPEND_ONLY = { code: "42501", message: expect.stringMatching(/append-only/) };

async function actionOf(id: string): Promise<string | undefined> {
  const r = await pg().admin.query<{ action: string }>(
    "SELECT action FROM audit_events WHERE id = $1",
    [id],
  );
  return r.rows[0]?.action;
}

describe("0034 — domain role (NOBYPASSRLS, full grants)", () => {
  it("can still INSERT an audit fact in its tenant", async () => {
    if (skip()) return;
    const n = await asDomain(
      { tenant: TENANT_A },
      `INSERT INTO audit_events (id, tenant_id, action) VALUES (gen_random_uuid(), $1, 'rt133.insert')`,
      [TENANT_A],
    );
    expect(n).toBe(1);
  });

  it("cannot UPDATE a same-tenant row (RT-120 C-1 repro)", async () => {
    if (skip()) return;
    await expect(
      asDomain({ tenant: TENANT_A }, `UPDATE audit_events SET action = 'tampered' WHERE id = $1`, [
        ROW_A,
      ]),
    ).rejects.toMatchObject(APPEND_ONLY);
    expect(await actionOf(ROW_A)).toBe("rt133.seed");
  });

  it("cannot DELETE a same-tenant row", async () => {
    if (skip()) return;
    await expect(
      asDomain({ tenant: TENANT_A }, `DELETE FROM audit_events WHERE id = $1`, [ROW_A]),
    ).rejects.toMatchObject(APPEND_ONLY);
    expect(await actionOf(ROW_A)).toBe("rt133.seed");
  });

  it("cannot DELETE every tenant's rows under the platform-admin GUC (RT-120 C-1 repro)", async () => {
    if (skip()) return;
    await expect(
      asDomain({ tenant: TENANT_A, platformAdmin: true }, `DELETE FROM audit_events`),
    ).rejects.toMatchObject(APPEND_ONLY);
    expect(await actionOf(ROW_A)).toBe("rt133.seed");
    expect(await actionOf(ROW_B)).toBe("rt133.seed");
  });
});

describe("0034 — table owner", () => {
  it("cannot UPDATE, DELETE or TRUNCATE audit_events", async () => {
    if (skip()) return;
    await expect(
      pg().admin.query(`UPDATE audit_events SET metadata = '{"x":1}' WHERE id = $1`, [ROW_B]),
    ).rejects.toMatchObject(APPEND_ONLY);
    await expect(
      pg().admin.query(`DELETE FROM audit_events WHERE id = $1`, [ROW_B]),
    ).rejects.toMatchObject(APPEND_ONLY);
    await expect(pg().admin.query(`TRUNCATE audit_events`)).rejects.toMatchObject(APPEND_ONLY);
    expect(await actionOf(ROW_B)).toBe("rt133.seed");
  });
});

describe("0034 — retention marking (0004/0005 design) still works", () => {
  it("the retention role marks an old row once", async () => {
    if (skip()) return;
    const n = await asRetention(
      `UPDATE audit_events SET retention_marked_at = now() WHERE id = $1 AND retention_marked_at IS NULL`,
      [ROW_OLD],
    );
    expect(n).toBe(1);
  });

  it("a marked row cannot be re-marked or un-marked", async () => {
    if (skip()) return;
    await expect(
      asRetention(`UPDATE audit_events SET retention_marked_at = now() + interval '1 day' WHERE id = $1`, [
        ROW_OLD,
      ]),
    ).rejects.toMatchObject(APPEND_ONLY);
    await expect(
      pg().admin.query(`UPDATE audit_events SET retention_marked_at = NULL WHERE id = $1`, [ROW_OLD]),
    ).rejects.toMatchObject(APPEND_ONLY);
  });

  it("marking cannot be used to smuggle in another column change", async () => {
    if (skip()) return;
    await expect(
      pg().admin.query(
        `UPDATE audit_events SET retention_marked_at = now(), action = 'tampered' WHERE id = $1`,
        [ROW_A],
      ),
    ).rejects.toMatchObject(APPEND_ONLY);
    expect(await actionOf(ROW_A)).toBe("rt133.seed");
  });
});

describe("0034 — the schema's ON DELETE SET NULL still works", () => {
  it("hard-deleting a referenced store and user nulls the references and keeps the row", async () => {
    if (skip()) return;
    await pg().admin.query(`DELETE FROM stores WHERE id = $1`, [STORE_A]);
    await pg().admin.query(`DELETE FROM users WHERE id = $1`, [USER_A]);
    const r = await pg().admin.query<{
      action: string;
      store_id: string | null;
      actor_user_id: string | null;
    }>(`SELECT action, store_id, actor_user_id FROM audit_events WHERE id = $1`, [ROW_FK]);
    expect(r.rows[0]).toEqual({ action: "rt133.fk", store_id: null, actor_user_id: null });
  });

  it("a direct UPDATE that only nulls those columns is still refused", async () => {
    if (skip()) return;
    await expect(
      pg().admin.query(`UPDATE audit_events SET store_id = NULL WHERE id = $1`, [ROW_A]),
    ).rejects.toMatchObject(APPEND_ONLY);
  });
});

describe("0034 — reversible", () => {
  it("down removes the guard; up restores it", async () => {
    if (skip()) return;
    await pg().admin.query(DOWN_SQL);
    const tampered = await pg().admin.query(
      `UPDATE audit_events SET metadata = '{"down":true}' WHERE id = $1`,
      [ROW_B],
    );
    expect(tampered.rowCount).toBe(1);

    await pg().admin.query(UP_SQL);
    await expect(
      pg().admin.query(`DELETE FROM audit_events WHERE id = $1`, [ROW_B]),
    ).rejects.toMatchObject(APPEND_ONLY);
  });
});
