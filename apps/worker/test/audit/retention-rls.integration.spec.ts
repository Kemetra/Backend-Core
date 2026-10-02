/**
 * RT-123 (RT-120 C-7) — the retention sweeps work under FORCE ROW LEVEL
 * SECURITY, on real PostgreSQL with every migration applied.
 *
 * Both tables are FORCE RLS. A sweep that runs without a tenant/platform
 * GUC sees zero rows and silently does nothing — which is what the audit
 * retention sweep did. Each repository is run here as a NOBYPASSRLS role:
 *
 *   - audit retention as `audit_retention_worker` (the 0005 least-privilege
 *     role: SELECT + UPDATE(retention_marked_at) only);
 *   - outbox retention as `app_test` (the domain role shape).
 *
 * Both must sweep rows of every tenant, and only eligible rows.
 */
import type { Pool } from "pg";

import {
  applyAllUpAndCreateAppRole,
  createRetentionWorkerPool,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { DrizzleAuditRetentionRepository } from "../../src/audit/drizzle-audit-retention.repository";
import { DrizzleOutboxRetentionRepository } from "../../src/outbox/drizzle-outbox-retention.repository";
import { computeRetentionCutoffs } from "../../src/outbox/retention.policy";

const TENANT_A = "0a000000-0000-7000-8000-000000123a01";
const TENANT_B = "0b000000-0000-7000-8000-000000123b01";

const AUDIT_OLD_A = "0a000000-0000-7000-8000-000000123a10";
const AUDIT_OLD_B = "0b000000-0000-7000-8000-000000123b10";
const AUDIT_NEW_A = "0a000000-0000-7000-8000-000000123a11";

const OUTBOX_OLD_A = "0a000000-0000-7000-8000-000000123a20";
const OUTBOX_OLD_B = "0b000000-0000-7000-8000-000000123b20";
const OUTBOX_NEW_A = "0a000000-0000-7000-8000-000000123a21";
const OUTBOX_PENDING_B = "0b000000-0000-7000-8000-000000123b21";

let env: PgTestEnv | null = null;
let retentionPool: Pool | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[retention-rls.integration] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  retentionPool = await createRetentionWorkerPool(env);

  await env.admin.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt123-a', 'A'), ($2, 'rt123-b', 'B')`,
    [TENANT_A, TENANT_B],
  );
  await env.admin.query(
    `INSERT INTO audit_events (id, tenant_id, action, occurred_at) VALUES
       ($1, $4, 'rt123.old', now() - interval '400 days'),
       ($2, $5, 'rt123.old', now() - interval '400 days'),
       ($3, $4, 'rt123.new', now() - interval '1 day')`,
    [AUDIT_OLD_A, AUDIT_OLD_B, AUDIT_NEW_A, TENANT_A, TENANT_B],
  );
  await env.admin.query(
    `INSERT INTO outbox_events
       (event_id, tenant_id, event_type, payload, delivery_state, processed_at) VALUES
       ($1, $5, 'sale.captured', '{}', 'delivered', now() - interval '100 days'),
       ($2, $6, 'sale.captured', '{}', 'delivered', now() - interval '100 days'),
       ($3, $5, 'sale.captured', '{}', 'delivered', now() - interval '1 day'),
       ($4, $6, 'sale.captured', '{}', 'pending', NULL)`,
    [OUTBOX_OLD_A, OUTBOX_OLD_B, OUTBOX_NEW_A, OUTBOX_PENDING_B, TENANT_A, TENANT_B],
  );
}, 240_000);

afterAll(async () => {
  if (retentionPool) await retentionPool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

/** Both handles once setup ran; null on a Docker-less run (tests then skip). */
function handles(): { env: PgTestEnv; retentionPool: Pool } | null {
  if (env === null) return null;
  if (retentionPool === null) return null;
  return { env, retentionPool };
}

describe("RT-123 — audit retention marks across tenants under FORCE RLS", () => {
  it("the least-privilege retention role is NOBYPASSRLS (the sweep cannot rely on bypass)", async () => {
    const h = handles();
    if (!h) return;
    const r = await h.retentionPool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it("marks every tenant's expired rows, and only those", async () => {
    const h = handles();
    if (!h) return;
    const repo = new DrizzleAuditRetentionRepository(h.retentionPool);
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    expect(await repo.markBatch(cutoff, new Date(), 1000)).toBe(2);

    const r = await h.env.admin.query<{ id: string; marked: boolean }>(
      `SELECT id, retention_marked_at IS NOT NULL AS marked
         FROM audit_events WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[AUDIT_OLD_A, AUDIT_OLD_B, AUDIT_NEW_A]],
    );
    expect(Object.fromEntries(r.rows.map((row) => [row.id, row.marked]))).toEqual({
      [AUDIT_OLD_A]: true,
      [AUDIT_OLD_B]: true,
      [AUDIT_NEW_A]: false,
    });
  });

  it("is idempotent: a second sweep marks nothing", async () => {
    const h = handles();
    if (!h) return;
    const repo = new DrizzleAuditRetentionRepository(h.retentionPool);
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    expect(await repo.markBatch(cutoff, new Date(), 1000)).toBe(0);
  });
});

describe("RT-123 — outbox retention purges across tenants under FORCE RLS", () => {
  it("purges every tenant's expired delivered rows and keeps the rest", async () => {
    const h = handles();
    if (!h) return;
    const repo = new DrizzleOutboxRetentionRepository(h.env.app);

    expect(await repo.purgeBatch(computeRetentionCutoffs(new Date()), 1000)).toBe(2);

    const r = await h.env.admin.query<{ event_id: string }>(
      `SELECT event_id FROM outbox_events WHERE event_id = ANY($1::uuid[]) ORDER BY event_id`,
      [[OUTBOX_OLD_A, OUTBOX_OLD_B, OUTBOX_NEW_A, OUTBOX_PENDING_B]],
    );
    expect(r.rows.map((row) => row.event_id).sort()).toEqual(
      [OUTBOX_NEW_A, OUTBOX_PENDING_B].sort(),
    );
  });
});
