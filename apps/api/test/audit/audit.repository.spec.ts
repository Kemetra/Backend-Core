/**
 * audit.repository.spec.ts — T235 repository integration.
 *
 * Real Postgres via Testcontainers. Verifies the `DrizzleAuditRepository`
 * SELECT path against the actual `audit_events` schema + RLS policies.
 *
 * Coverage:
 *   1. RLS-respecting tenant scoping: tenant A caller cannot see tenant B
 *      rows even on the non-superuser `app_test` role.
 *   2. Defence-in-depth: a platform-admin caller scoped to tenant A also
 *      sees only tenant A rows (the explicit
 *      `WHERE tenant_id = ctx.tenantId` predicate closes the RLS OR-branch
 *      hole).
 *   3. Sort: results are DESC by `(occurred_at, id)`.
 *   4. Cursor pagination: page 1 + page 2 partition the result with no
 *      overlap and no gaps.
 *   5. action prefix filter.
 *   6. actor_user_id / store_id / from / to filters.
 *   7. RT-567 `kind` filter (tenant C): `change` / `read` / omitted,
 *      unregistered code counted as `change` (D-2), cursor walk under
 *      `kind=change`, tenant isolation with `kind` set.
 *   8. RT-567 F2b: the `action` prefix is literal (`%`, `_`, `\`).
 *   9. Canary: bypassing `runWithTenantContext` (running on the plain
 *      app_test pool with no GUCs set) blows up with the expected
 *      `invalid input syntax for type uuid: ""` error from the RLS cast,
 *      proving the repo's RLS posture is necessary.
 *
 * Skip-on-no-Docker
 * -----------------
 * Mirrors `auth-token.repository.spec.ts`: when Docker is unavailable AND
 * `MIGRATION_TEST_ALLOW_SKIP=1` is set, the spec logs a warning and
 * `maybeSkip()` short-circuits each test. Without that env, container
 * failure rethrows.
 */
import "reflect-metadata";

import { Pool } from "pg";

import { kindOf } from "../../src/audit/audit-action-kinds";
import { DrizzleAuditRepository } from "../../src/audit/audit.repository";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  APP_ROLE_NAME,
  APP_ROLE_PASSWORD,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const TENANT_A = "0a000000-0000-7000-8000-0000000000a1";
const TENANT_B = "0b000000-0000-7000-8000-0000000000b1";
const TENANT_C = "0c000000-0000-7000-8000-0000000000c1";
const ACTOR_1 = "0a000000-0000-7000-8000-00000000aa01";
const ACTOR_2 = "0a000000-0000-7000-8000-00000000aa02";
const STORE_1 = "0a000000-0000-7000-8000-0000000000c1";
const STORE_2 = "0a000000-0000-7000-8000-0000000000c2";

let env: PgTestEnv | null = null;
let appPool: Pool | null = null;
let repo: DrizzleAuditRepository;
let dockerSkipped = false;

// Stable, manually-pinned audit row timestamps. Spaced by 1 second so the
// (occurred_at, id) DESC ordering is unambiguous and µs precision is a
// non-factor for the cursor scheme.
const AT = (sec: number): string =>
  `2026-05-01T12:00:${sec.toString().padStart(2, "0")}.000Z`;
const AT_C = (sec: number): string =>
  `2026-05-01T13:00:${sec.toString().padStart(2, "0")}.000Z`;

// RT-567 — tenant C: reads interleaved between changes, an unregistered code
// (D-2), and codes that only match `auth_%` / `%` / `\` as LIKE patterns.
// Newest first.
const TENANT_C_ROWS: ReadonlyArray<{ id: string; action: string; occurredAt: string }> = [
  { id: "0c000000-0000-7000-8000-000000000401", action: "shift_closes.listed",           occurredAt: AT_C(59) },
  { id: "0c000000-0000-7000-8000-000000000402", action: "sale.voided",                   occurredAt: AT_C(55) },
  { id: "0c000000-0000-7000-8000-000000000403", action: "erpnext_sync_ops.summary.read", occurredAt: AT_C(50) },
  { id: "0c000000-0000-7000-8000-000000000404", action: "pos_sales.detail_read",         occurredAt: AT_C(45) },
  { id: "0c000000-0000-7000-8000-000000000405", action: "zz.unregistered.code",          occurredAt: AT_C(40) },
  { id: "0c000000-0000-7000-8000-000000000406", action: "devices.listed",                occurredAt: AT_C(35) },
  { id: "0c000000-0000-7000-8000-000000000407", action: "auth.signin.ok",                occurredAt: AT_C(30) },
  { id: "0c000000-0000-7000-8000-000000000408", action: "auth_%.literal",                occurredAt: AT_C(25) },
  { id: "0c000000-0000-7000-8000-000000000409", action: "authXsignin",                   occurredAt: AT_C(20) },
  { id: "0c000000-0000-7000-8000-000000000410", action: "%pct.literal",                  occurredAt: AT_C(15) },
  { id: "0c000000-0000-7000-8000-000000000411", action: "back\\slash.literal",           occurredAt: AT_C(10) },
  { id: "0c000000-0000-7000-8000-000000000412", action: "backXslash.other",              occurredAt: AT_C(5) },
];
const C_READS = TENANT_C_ROWS.filter((r) => kindOf(r.action) === "read").map((r) => r.id);
const C_CHANGES = TENANT_C_ROWS.filter((r) => kindOf(r.action) === "change").map((r) => r.id);

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);

    // Create a non-superuser pool — the repository uses this in
    // production (where `app_role` cannot bypass RLS). Tests must
    // verify the policy on the same role posture.
    const host = env.container.getHost();
    const port = env.container.getMappedPort(5432);
    appPool = new Pool({
      connectionString: `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${host}:${port}/test`,
    });

    // Seed users referenced by audit rows.
    await env.admin.query(
      `INSERT INTO users (id, email, password_hash) VALUES
         ($1, 'a1@example.com', NULL),
         ($2, 'a2@example.com', NULL)`,
      [ACTOR_1, ACTOR_2],
    );
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1, 'aud-a', 'Aud A'),
         ($2, 'aud-b', 'Aud B'),
         ($3, 'aud-c', 'Aud C')`,
      [TENANT_A, TENANT_B, TENANT_C],
    );
    await env.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $3, 's1', 'Store 1'),
         ($2, $3, 's2', 'Store 2')`,
      [STORE_1, STORE_2, TENANT_A],
    );

    // Seed audit rows. Admin pool bypasses RLS; rows carry varied
    // (action, actor, store, occurred_at) so each filter has signal.
    const rows: ReadonlyArray<{
      id: string;
      tenant: string;
      actor: string | null;
      store: string | null;
      action: string;
      occurredAt: string;
    }> = [
      // Tenant A — five rows in DESC order (newest first) by occurred_at.
      { id: "0a000000-0000-7000-8000-000000000201", tenant: TENANT_A, actor: ACTOR_1, store: null,    action: "auth.signin.ok",        occurredAt: AT(50) },
      { id: "0a000000-0000-7000-8000-000000000202", tenant: TENANT_A, actor: ACTOR_2, store: null,    action: "auth.signin.failed",    occurredAt: AT(40) },
      { id: "0a000000-0000-7000-8000-000000000203", tenant: TENANT_A, actor: ACTOR_1, store: STORE_1, action: "context.switch.tenant", occurredAt: AT(30) },
      { id: "0a000000-0000-7000-8000-000000000204", tenant: TENANT_A, actor: ACTOR_1, store: STORE_2, action: "context.switch.store",  occurredAt: AT(20) },
      { id: "0a000000-0000-7000-8000-000000000205", tenant: TENANT_A, actor: null,    store: null,    action: "stores.update",         occurredAt: AT(10) },
      // Tenant B — should never be visible to a tenant-A repo call.
      { id: "0b000000-0000-7000-8000-000000000301", tenant: TENANT_B, actor: ACTOR_1, store: null,    action: "auth.signin.ok",        occurredAt: AT(45) },
      { id: "0b000000-0000-7000-8000-000000000302", tenant: TENANT_B, actor: ACTOR_2, store: null,    action: "stores.delete",         occurredAt: AT(35) },
    ];

    for (const r of rows) {
      await env.admin.query(
        `INSERT INTO audit_events (id, occurred_at, actor_user_id, tenant_id, store_id, action, metadata)
         VALUES ($1, $2::timestamptz, $3, $4, $5, $6, '{}'::jsonb)`,
        [r.id, r.occurredAt, r.actor, r.tenant, r.store, r.action],
      );
    }

    for (const r of TENANT_C_ROWS) {
      await env.admin.query(
        `INSERT INTO audit_events (id, occurred_at, tenant_id, action, metadata)
         VALUES ($1, $2::timestamptz, $3, $4, '{}'::jsonb)`,
        [r.id, r.occurredAt, TENANT_C, r.action],
      );
    }

    repo = new DrizzleAuditRepository(appPool);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[audit.repository.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (appPool) await appPool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[audit.repository.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

describe("DrizzleAuditRepository", () => {
  it("returns rows for the active tenant only (RLS + explicit predicate)", async () => {
    if (maybeSkip()) return;
    const rows = await repo.listPage({
      tenantId: TENANT_A,
      isPlatformAdmin: false,
      cursor: null,
      limit: 100,
    });
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect(r.tenantId).toBe(TENANT_A);
    }
  });

  it("does NOT leak tenant B rows to a tenant A query", async () => {
    if (maybeSkip()) return;
    const rows = await repo.listPage({
      tenantId: TENANT_A,
      isPlatformAdmin: false,
      cursor: null,
      limit: 100,
    });
    const tenantBIds = rows.filter((r) => r.tenantId === TENANT_B).map((r) => r.id);
    expect(tenantBIds).toEqual([]);
  });

  it("scopes platform-admin reads to ctx.tenantId (defence-in-depth predicate)", async () => {
    if (maybeSkip()) return;
    // Platform-admin: RLS OR-branch would normally show ALL tenants. The
    // explicit `WHERE tenant_id = ctx.tenantId` predicate must filter to
    // tenant A only.
    const rows = await repo.listPage({
      tenantId: TENANT_A,
      isPlatformAdmin: true,
      cursor: null,
      limit: 100,
    });
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect(r.tenantId).toBe(TENANT_A);
    }
  });

  it("sorts by (occurred_at, id) DESC", async () => {
    if (maybeSkip()) return;
    const rows = await repo.listPage({
      tenantId: TENANT_A,
      isPlatformAdmin: false,
      cursor: null,
      limit: 100,
    });
    const occurredAts = rows.map((r) => r.occurredAt.getTime());
    const sortedDesc = [...occurredAts].sort((a, b) => b - a);
    expect(occurredAts).toEqual(sortedDesc);
  });

  it("paginates with stable cursor — no overlap, no gaps", async () => {
    if (maybeSkip()) return;
    const page1 = await repo.listPage({
      tenantId: TENANT_A,
      isPlatformAdmin: false,
      cursor: null,
      limit: 3,
    });
    expect(page1.length).toBe(3);

    const last = page1[page1.length - 1]!;
    const page2 = await repo.listPage({
      tenantId: TENANT_A,
      isPlatformAdmin: false,
      cursor: { occurredAt: last.occurredAt, id: last.id },
      limit: 3,
    });
    // 5 rows total, page1 took 3 → page2 should have 2.
    expect(page2.length).toBe(2);

    const ids1 = page1.map((r) => r.id);
    const ids2 = page2.map((r) => r.id);
    // No overlap.
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    // Together they cover all 5 tenant-A rows.
    expect(new Set([...ids1, ...ids2]).size).toBe(5);
  });

  it("filters by action prefix (auth. → both signin rows)", async () => {
    if (maybeSkip()) return;
    const rows = await repo.listPage({
      tenantId: TENANT_A,
      isPlatformAdmin: false,
      action: "auth.",
      cursor: null,
      limit: 100,
    });
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(["auth.signin.failed", "auth.signin.ok"]);
  });

  it("filters by actor_user_id", async () => {
    if (maybeSkip()) return;
    const rows = await repo.listPage({
      tenantId: TENANT_A,
      isPlatformAdmin: false,
      actorUserId: ACTOR_2,
      cursor: null,
      limit: 100,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.action).toBe("auth.signin.failed");
  });

  it("filters by store_id", async () => {
    if (maybeSkip()) return;
    const rows = await repo.listPage({
      tenantId: TENANT_A,
      isPlatformAdmin: false,
      storeId: STORE_1,
      cursor: null,
      limit: 100,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.action).toBe("context.switch.tenant");
  });

  it("filters by from/to time range (inclusive bounds)", async () => {
    if (maybeSkip()) return;
    const rows = await repo.listPage({
      tenantId: TENANT_A,
      isPlatformAdmin: false,
      from: new Date(AT(20)),
      to: new Date(AT(40)),
      cursor: null,
      limit: 100,
    });
    // AT(20), AT(30), AT(40) → 3 rows.
    expect(rows.length).toBe(3);
    for (const r of rows) {
      const t = r.occurredAt.getTime();
      expect(t).toBeGreaterThanOrEqual(new Date(AT(20)).getTime());
      expect(t).toBeLessThanOrEqual(new Date(AT(40)).getTime());
    }
  });

  it("returns the encodeCursor round-trip when a service-emitted cursor is fed back", async () => {
    if (maybeSkip()) return;
    // Smoke: cursor produced by encodeCursor is re-decodable and
    // produces a strictly-following page when used here. We pass the
    // decoded form (since the repo accepts AuditCursor, not string).
    const page1 = await repo.listPage({
      tenantId: TENANT_A,
      isPlatformAdmin: false,
      cursor: null,
      limit: 1,
    });
    const r1 = page1[0]!;
    const page2 = await repo.listPage({
      tenantId: TENANT_A,
      isPlatformAdmin: false,
      cursor: { occurredAt: r1.occurredAt, id: r1.id },
      limit: 1,
    });
    expect(page2.length).toBe(1);
    expect(page2[0]?.id).not.toBe(r1.id);
    expect(page2[0]!.occurredAt.getTime()).toBeLessThanOrEqual(r1.occurredAt.getTime());
  });

  describe("RT-567 kind filter", () => {
    const listC = (extra: { kind?: "read" | "change"; action?: string } = {}) =>
      repo.listPage({ tenantId: TENANT_C, isPlatformAdmin: false, cursor: null, limit: 100, ...extra });

    it("the tenant C seed has both kinds (the filter tests are not vacuous)", () => {
      expect(C_READS.length).toBe(4);
      expect(C_CHANGES.length).toBe(8);
    });

    it("kind=change returns every change row (incl. an unregistered code, D-2) and no read row, newest first", async () => {
      if (maybeSkip()) return;
      const rows = await listC({ kind: "change" });
      expect(rows.map((r) => r.id)).toEqual(C_CHANGES);
      expect(rows.map((r) => r.action)).toContain("zz.unregistered.code");
    });

    it("kind=read returns only read rows, newest first", async () => {
      if (maybeSkip()) return;
      const rows = await listC({ kind: "read" });
      expect(rows.map((r) => r.id)).toEqual(C_READS);
      expect(rows.map((r) => r.action)).toContain("pos_sales.detail_read");
    });

    it("omitted kind returns both kinds (no behaviour change)", async () => {
      if (maybeSkip()) return;
      const rows = await listC();
      expect(rows.map((r) => r.id)).toEqual(TENANT_C_ROWS.map((r) => r.id));
    });

    it("walking the cursor with kind=change and limit=1 yields every change row exactly once (RT-211 anchor)", async () => {
      if (maybeSkip()) return;
      const seen: string[] = [];
      let cursor: { occurredAt: Date; id: string } | null = null;
      for (let i = 0; i < TENANT_C_ROWS.length + 2; i++) {
        const page = await repo.listPage({
          tenantId: TENANT_C,
          isPlatformAdmin: false,
          kind: "change",
          cursor,
          limit: 1,
        });
        if (page.length === 0) break;
        const row = page[0]!;
        seen.push(row.id);
        cursor = { occurredAt: row.occurredAt, id: row.id };
      }
      expect(seen).toEqual(C_CHANGES);
    });

    it("kind combines with action (AND)", async () => {
      if (maybeSkip()) return;
      const rows = await listC({ kind: "read", action: "devices." });
      expect(rows.map((r) => r.action)).toEqual(["devices.listed"]);
    });

    it("kind never crosses tenants: tenant A sees none of tenant C's rows", async () => {
      if (maybeSkip()) return;
      for (const isPlatformAdmin of [false, true]) {
        const reads = await repo.listPage({ tenantId: TENANT_A, isPlatformAdmin, kind: "read", cursor: null, limit: 100 });
        expect(reads).toEqual([]);
        const changes = await repo.listPage({ tenantId: TENANT_A, isPlatformAdmin, kind: "change", cursor: null, limit: 100 });
        expect(changes.length).toBe(5);
        for (const r of changes) expect(r.tenantId).toBe(TENANT_A);
      }
    });
  });

  describe("RT-567 F2b literal action prefix", () => {
    const actionsFor = async (action: string) =>
      (await repo.listPage({ tenantId: TENANT_C, isPlatformAdmin: false, action, cursor: null, limit: 100 }))
        .map((r) => r.action);

    it("action=% matches only codes that literally start with %", async () => {
      if (maybeSkip()) return;
      expect(await actionsFor("%")).toEqual(["%pct.literal"]);
    });

    it("action=auth_% matches only codes that literally start with auth_%", async () => {
      if (maybeSkip()) return;
      expect(await actionsFor("auth_%")).toEqual(["auth_%.literal"]);
    });

    it("action=auth_ does not treat _ as a single-character wildcard", async () => {
      if (maybeSkip()) return;
      expect(await actionsFor("auth_")).toEqual(["auth_%.literal"]);
    });

    it("a backslash in the prefix is literal", async () => {
      if (maybeSkip()) return;
      expect(await actionsFor("back\\")).toEqual(["back\\slash.literal"]);
    });

    it("a plain prefix still matches as before", async () => {
      if (maybeSkip()) return;
      expect(await actionsFor("auth.")).toEqual(["auth.signin.ok"]);
    });
  });

  it("CANARY: a bare app-pool query without runWithTenantContext fails with the RLS uuid-cast error", async () => {
    if (maybeSkip()) return;
    // Prove that `runWithTenantContext` is NECESSARY for this repo's
    // SELECT to succeed. If this test ever passes without throwing,
    // the policy or the role posture has changed and the repository's
    // tenant-scoping assumption needs re-examination.
    if (!appPool) throw new Error("appPool not initialized");
    let threw = false;
    try {
      await appPool.query(`SELECT id FROM audit_events LIMIT 1`);
    } catch (err: unknown) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      // The cast on current_setting('app.current_tenant', true) — which
      // is '' when unset — fails with `invalid input syntax for type uuid`.
      expect(msg).toMatch(/invalid input syntax|uuid/i);
    }
    expect(threw).toBe(true);
  });
});
