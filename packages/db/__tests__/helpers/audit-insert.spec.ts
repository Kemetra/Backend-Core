/**
 * audit-insert.spec.ts
 *
 * Tier 1 — pure unit tests using `_makeInsertAuditEvent` seam.
 * No Docker, no real DB, no pool connections.
 *
 * Tier 2 — Testcontainers integration tests using the real `insertAuditEvent`
 * function with an `app_test` pool (non-superuser, subject to RLS).
 * Guarded by `MIGRATION_TEST_ALLOW_SKIP=1` for CI without Docker.
 *
 * Key invariants verified:
 *   - tenant path: runWithTenantContext called with the row's tenantId,
 *     isPlatformAdmin=false; withTenant insert path used
 *   - platform path requires explicit tenant_id: null; runWithTenantContext
 *     called with NIL_UUID, isPlatformAdmin=true; row stores DB NULL
 *   - undefined tenant_id throws — never silently becomes platform-scoped
 *   - null optional fields map to undefined in NewAuditEventRow
 *   - runWithTenantContext errors propagate to caller
 */
import {
  _makeInsertAuditEvent,
  insertAuditEvent,
  type AuditEventInsertRow,
} from "../../src/helpers/audit-insert";
import type { NewAuditEventRow } from "../../src/schema";
import type { RunCtxFn } from "../../src/helpers/audit-insert";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Tier 1 — unit tests (no real DB)
// ---------------------------------------------------------------------------

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const TENANT_ID = "aabbccdd-0000-7000-8000-000000000001";
const EVENT_ID = "11111111-1111-1111-1111-111111111111";

/** Fully-specified row fixture with a tenant UUID. */
const TENANT_ROW: AuditEventInsertRow = {
  id: EVENT_ID,
  tenant_id: TENANT_ID,
  action: "context.switch.tenant",
  actor_user_id: null,
  actor_label: null,
  store_id: null,
  target_type: null,
  target_id: null,
  request_id: null,
  metadata: {},
};

/** Fully-specified row fixture for a platform-scoped insert. */
const PLATFORM_ROW: AuditEventInsertRow = {
  id: EVENT_ID,
  tenant_id: null,
  action: "platform.system.bootstrap",
  actor_user_id: null,
  actor_label: null,
  store_id: null,
  target_type: null,
  target_id: null,
  request_id: null,
  metadata: {},
};

describe("_makeInsertAuditEvent — unit (fake seams)", () => {
  function makeFakeRunCtx(capturedCtx: {
    tenantId?: string | null;
    isPlatformAdmin?: boolean;
  }): RunCtxFn {
    // MUST invoke work() — rawInsertFn seam runs inside work(), not before it.
    return async <T>(_pool: unknown, ctx: { tenantId: string | null; isPlatformAdmin: boolean }, work: (client: never) => Promise<T>): Promise<T> => {
      capturedCtx.tenantId = ctx.tenantId;
      capturedCtx.isPlatformAdmin = ctx.isPlatformAdmin;
      return work(null as never);
    };
  }

  it("tenant path: calls runCtx with row.tenant_id and isPlatformAdmin=false", async () => {
    const capturedCtx: { tenantId?: string | null; isPlatformAdmin?: boolean } = {};
    const capturedRow: { row?: NewAuditEventRow; isPlatformAdmin?: boolean } = {};

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx(capturedCtx),
      async (_pool, row, isPlatformAdmin) => {
        capturedRow.row = row;
        capturedRow.isPlatformAdmin = isPlatformAdmin;
      },
    );

    await fn({} as never, TENANT_ROW);

    expect(capturedCtx.tenantId).toBe(TENANT_ID);
    expect(capturedCtx.isPlatformAdmin).toBe(false);
    expect(capturedRow.isPlatformAdmin).toBe(false);
    expect(capturedRow.row?.tenantId).toBe(TENANT_ID);
  });

  it("platform path: explicit tenant_id: null calls runCtx with NIL_UUID and isPlatformAdmin=true", async () => {
    const capturedCtx: { tenantId?: string | null; isPlatformAdmin?: boolean } = {};
    const capturedRow: { row?: NewAuditEventRow; isPlatformAdmin?: boolean } = {};

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx(capturedCtx),
      async (_pool, row, isPlatformAdmin) => {
        capturedRow.row = row;
        capturedRow.isPlatformAdmin = isPlatformAdmin;
      },
    );

    await fn({} as never, PLATFORM_ROW);

    expect(capturedCtx.tenantId).toBe(NIL_UUID);
    expect(capturedCtx.isPlatformAdmin).toBe(true);
    expect(capturedRow.isPlatformAdmin).toBe(true);
    // The row itself must store undefined (DB NULL), NOT NIL_UUID
    expect(capturedRow.row?.tenantId).toBeUndefined();
  });

  it("undefined tenant_id throws — must use explicit null for platform-scoped inserts", async () => {
    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx({}),
      async () => {},
    );

    // Cast through unknown to simulate an untyped JS caller omitting tenant_id
    const badRow = { ...TENANT_ROW, tenant_id: undefined } as unknown as AuditEventInsertRow;

    await expect(fn({} as never, badRow)).rejects.toThrow(
      "insertAuditEvent: tenant_id must be a UUID string or explicit null",
    );
  });

  it("null optional fields map to undefined in NewAuditEventRow", async () => {
    const capturedRow: { row?: NewAuditEventRow } = {};

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx({}),
      async (_pool, row) => {
        capturedRow.row = row;
      },
    );

    await fn({} as never, {
      id: EVENT_ID,
      tenant_id: TENANT_ID,
      action: "context.switch.tenant",
      actor_user_id: null,
      actor_label: null,
      store_id: null,
      target_type: null,
      target_id: null,
      request_id: null,
      metadata: {},
    });

    expect(capturedRow.row?.actorUserId).toBeUndefined();
    expect(capturedRow.row?.actorLabel).toBeUndefined();
    expect(capturedRow.row?.storeId).toBeUndefined();
    expect(capturedRow.row?.targetType).toBeUndefined();
    expect(capturedRow.row?.targetId).toBeUndefined();
    expect(capturedRow.row?.requestId).toBeUndefined();
  });

  it("metadata is forwarded as-is", async () => {
    const capturedRow: { row?: NewAuditEventRow } = {};

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx({}),
      async (_pool, row) => {
        capturedRow.row = row;
      },
    );

    await fn({} as never, {
      id: EVENT_ID,
      tenant_id: TENANT_ID,
      action: "context.switch.store",
      actor_user_id: null,
      actor_label: null,
      store_id: null,
      target_type: null,
      target_id: null,
      request_id: null,
      metadata: { from: "store-a", to: "store-b" },
    });

    expect(capturedRow.row?.metadata).toEqual({ from: "store-a", to: "store-b" });
  });

  it("optional fields are forwarded when non-null", async () => {
    const ACTOR_ID = "aaaaaaaa-0000-7000-8000-000000000001";
    const STORE_ID = "bbbbbbbb-0000-7000-8000-000000000001";
    const REQUEST_ID = "cccccccc-0000-7000-8000-000000000001";
    const TARGET_ID = "dddddddd-0000-7000-8000-000000000001";
    const capturedRow: { row?: NewAuditEventRow } = {};

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx({}),
      async (_pool, row) => {
        capturedRow.row = row;
      },
    );

    await fn({} as never, {
      id: EVENT_ID,
      tenant_id: TENANT_ID,
      action: "context.switch.tenant",
      actor_user_id: ACTOR_ID,
      actor_label: "alice@example.com",
      store_id: STORE_ID,
      target_type: "tenant",
      target_id: TARGET_ID,
      request_id: REQUEST_ID,
      metadata: {},
    });

    expect(capturedRow.row?.actorUserId).toBe(ACTOR_ID);
    expect(capturedRow.row?.actorLabel).toBe("alice@example.com");
    expect(capturedRow.row?.storeId).toBe(STORE_ID);
    expect(capturedRow.row?.targetType).toBe("tenant");
    expect(capturedRow.row?.targetId).toBe(TARGET_ID);
    expect(capturedRow.row?.requestId).toBe(REQUEST_ID);
  });

  it("propagates errors thrown by runCtx", async () => {
    const boom = new Error("runCtx exploded");

    const fn = _makeInsertAuditEvent(
      async () => {
        throw boom;
      },
      async () => {},
    );

    await expect(fn({} as never, TENANT_ROW)).rejects.toThrow("runCtx exploded");
  });

  it("propagates errors thrown by the insert function", async () => {
    const boom = new Error("insert exploded");

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx({}),
      async () => {
        throw boom;
      },
    );

    await expect(fn({} as never, TENANT_ROW)).rejects.toThrow("insert exploded");
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — Testcontainers integration (real DB + real RLS)
// ---------------------------------------------------------------------------

describe("insertAuditEvent — Testcontainers (real RLS)", () => {
  const TC_TENANT_ID = "a0000000-0000-7000-8000-000000000001";

  let env: PgTestEnv | null = null;

  beforeAll(async () => {
    try {
      env = await startPgEnv();
      await applyAllUpAndCreateAppRole(env);
      // Seed a tenant for the tenant-path test (admin pool bypasses RLS for setup)
      await env.admin.query(
        `INSERT INTO tenants (id, slug, name) VALUES ($1, 'audit-insert-tc', 'AI TC Tenant')
         ON CONFLICT DO NOTHING`,
        [TC_TENANT_ID],
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
        // eslint-disable-next-line no-console
        console.warn(`\n[audit-insert.spec] Docker NOT AVAILABLE: ${msg}\n`);
        return;
      }
      throw err;
    }
  });

  afterAll(async () => {
    if (env) await stopPgEnv(env);
  });

  function skip(): boolean {
    return env === null;
  }

  it("inserts a tenant-scoped event and it is persisted correctly", async () => {
    if (skip()) return;

    const row: AuditEventInsertRow = {
      id: "e1000000-0000-7000-8000-000000000001",
      tenant_id: TC_TENANT_ID,
      action: "context.switch.tenant",
      actor_user_id: null,
      actor_label: null,
      store_id: null,
      target_type: null,
      target_id: null,
      request_id: null,
      metadata: { test: "tier2-tenant" },
    };

    await insertAuditEvent(env!.app, row);

    // Admin verification query (superuser bypasses RLS — confirms the row was stored)
    const { rows } = await env!.admin.query(
      "SELECT id, tenant_id, action FROM audit_events WHERE id = $1",
      [row.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(TC_TENANT_ID);
    expect(rows[0].action).toBe("context.switch.tenant");
  });

  it("inserts a platform-scoped event (tenant_id: null) and stores DB NULL", async () => {
    if (skip()) return;

    const row: AuditEventInsertRow = {
      id: "e2000000-0000-7000-8000-000000000002",
      tenant_id: null,
      action: "platform.system.bootstrap",
      actor_user_id: null,
      actor_label: null,
      store_id: null,
      target_type: null,
      target_id: null,
      request_id: null,
      metadata: { test: "tier2-platform" },
    };

    await insertAuditEvent(env!.app, row);

    // Admin verification query — row has DB NULL tenant_id, NOT NIL_UUID
    const { rows } = await env!.admin.query(
      "SELECT id, tenant_id, action FROM audit_events WHERE id = $1",
      [row.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBeNull();
    expect(rows[0].action).toBe("platform.system.bootstrap");
  });

  it("ignores a duplicate id — a redelivered audit fact is a no-op (RT-124)", async () => {
    if (skip()) return;

    const row: AuditEventInsertRow = {
      id: "e1000000-0000-7000-8000-000000000001", // same id as first test — PK conflict
      tenant_id: TC_TENANT_ID,
      action: "context.switch.tenant.duplicate",
      actor_user_id: null,
      actor_label: null,
      store_id: null,
      target_type: null,
      target_id: null,
      request_id: null,
      metadata: {},
    };

    await expect(insertAuditEvent(env!.app, row)).resolves.toBeUndefined();

    // Admin verification query — exactly the original row, unchanged.
    const { rows } = await env!.admin.query(
      "SELECT count(*)::int AS cnt, min(action) AS action FROM audit_events WHERE id = $1",
      [row.id],
    );
    expect(rows[0].cnt).toBe(1);
    expect(rows[0].action).not.toBe("context.switch.tenant.duplicate");
  });

  it("rolls back on insert error — FK violation does not leave partial state", async () => {
    if (skip()) return;

    const row: AuditEventInsertRow = {
      id: "e1000000-0000-7000-8000-0000000000ff",
      tenant_id: TC_TENANT_ID,
      action: "context.switch.tenant.bad-actor",
      actor_user_id: "e1000000-0000-7000-8000-00000000dead", // no such user
      actor_label: null,
      store_id: null,
      target_type: null,
      target_id: null,
      request_id: null,
      metadata: {},
    };

    await expect(insertAuditEvent(env!.app, row)).rejects.toThrow();

    const { rows } = await env!.admin.query(
      "SELECT count(*)::int AS cnt FROM audit_events WHERE id = $1",
      [row.id],
    );
    expect(rows[0].cnt).toBe(0);
  });
});
