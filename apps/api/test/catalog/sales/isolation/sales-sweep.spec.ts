/**
 * sales-sweep.spec.ts — 008 sale-fact cross-tenant/cross-store + RLS-bypass
 * isolation sweep (T015).
 *
 * Two kinds of assertion live here, by design (see the 008-ISOLATION-HARNESS
 * slice contract: "RED on missing capture/void/refund/read operations, NOT on
 * RLS"):
 *
 *   GROUP A — RLS / isolation (RUN + PASS NOW). With the seed-sales fixture
 *     populated across tenants A/B and stores X/Y, these prove the data-layer
 *     guarantee the slice exists to deliver: a wrong / unset `app.current_tenant`
 *     GUC returns ZERO rows from every sale-fact table, and a wrong-tenant GUC
 *     exposes only that tenant's rows. Run against `env.app` (the RLS-enforced
 *     non-superuser pool — NOT `env.admin`, which bypasses RLS). This is the
 *     first place 008 isolation is proven with rows ACTUALLY PRESENT in tenant A
 *     and invisible to tenant B (the migration round-trip proved fail-closed on
 *     EMPTY tables only).
 *
 *   GROUP B — operation object-safety (HTTP). The capture/read operations now
 *     exist (008-US1-CAPTURE authored SalesController/Service), so the
 *     capture-owned cases (§B.1, T036) are REAL HTTP assertions driven through
 *     the shared `__capture-harness` (real controller + service + RLS-active
 *     PG_POOL): cross-tenant read → non-disclosing 404 (FR-102/SC-004),
 *     out-of-scope store read → 404 (FR-063/SI-004), body-supplied
 *     tenant_id/store_id/created_by ignored (FR-061), unauthenticated → 401.
 *     The void/refund cases (§B.2, T074) are now REAL HTTP assertions too
 *     (008-US3/US4 landed): cross-tenant void/refund → non-disclosing 404 with
 *     no record. The capture harness is imported lazily inside §B's own
 *     `beforeAll`, so a Docker-less skip in Group A still short-circuits cleanly.
 *
 * MUST NOT modify `isolation-harness.ts` (003-owned) — extend via seed-sales.ts.
 *
 * Transport: DB/RLS layer for Group A (no HTTP), mirroring the 003
 * `rls-bypass-probe.spec.ts` idiom (withRawClient + set_config LOCAL + ROLLBACK).
 */
import { type PoolClient } from "pg";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  TENANT_A,
  TENANT_B,
} from "../../__support__/isolation-harness";
import { seedSalesFixture, SALES_FIXTURE_IDS } from "../__support__/seed-sales";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

// A UUID never inserted into any fixture.
const NON_EXISTENT_TENANT = "0f000000-0000-7000-8000-00000000dead";

// The four 008 sale-fact tables.
const SALE_TABLES = [
  "sales",
  "sale_lines",
  "sale_voids",
  "sale_refunds",
  // RT-73 (0032)
  "sale_returns",
  "sale_return_lines",
  "sale_return_tenders",
  // RT-77 (0033)
  "sale_tenders",
] as const;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env); // parent tenants/stores/actors
    await seedSalesFixture(env); // 008 sale-fact rows across A/B × X/Y
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[sales-sweep] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[sales-sweep] skipping — Docker unavailable");
    return true;
  }
  return false;
}

/**
 * Acquire an `env.app` (RLS-enforced) client, wrap in BEGIN/ROLLBACK so the
 * LOCAL `set_config` GUC is discarded — no GUC bleed across tests.
 */
async function withRawClient<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await env!.app.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("ROLLBACK");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const F = SALES_FIXTURE_IDS;

// ===========================================================================
// GROUP A — RLS / isolation (RUN + PASS NOW)
// ===========================================================================

describe("sales-sweep §A.1 — wrong-tenant GUC exposes only that tenant's rows", () => {
  // Tenant B's GUC must NEVER surface tenant A's seeded rows, on any table.
  it.each(SALE_TABLES)(
    "%s: app.current_tenant = TENANT_B → zero TENANT_A rows visible",
    async (table) => {
      if (maybeSkip()) return;
      const rows = await withRawClient(async (client) => {
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
          TENANT_B,
        ]);
        const r = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM ${table}`,
        );
        return r.rows;
      });
      // Every visible row belongs to B; none leak from A.
      for (const row of rows) {
        expect(row.tenant_id).toBe(TENANT_B);
      }
      expect(rows.filter((r) => r.tenant_id === TENANT_A)).toEqual([]);
    },
  );
});

describe("sales-sweep §A.2 — RLS-bypass probe: wrong tenant ⇒ zero rows on every table", () => {
  it.each(SALE_TABLES)(
    "%s: a non-existent app.current_tenant returns zero rows",
    async (table) => {
      if (maybeSkip()) return;
      const count = await withRawClient(async (client) => {
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
          NON_EXISTENT_TENANT,
        ]);
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}`,
        );
        return r.rows[0]?.count;
      });
      expect(count).toBe("0");
    },
  );
});

describe("sales-sweep §A.3 — fail-closed: unset tenant GUC ⇒ zero rows on every table", () => {
  it.each(SALE_TABLES)(
    "%s: no app.current_tenant set returns zero rows (empty-GUC CASE guard)",
    async (table) => {
      if (maybeSkip()) return;
      const count = await withRawClient(async (client) => {
        // No set_config at all — current_setting('app.current_tenant', true)
        // returns '' → CASE guard yields NULL → NULL = tenant_id → row filtered.
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}`,
        );
        return r.rows[0]?.count;
      });
      expect(count).toBe("0");
    },
  );
});

describe("sales-sweep §A.4b — RT-73 return tables are not vacuously isolated", () => {
  it.each(["sale_returns", "sale_return_lines", "sale_return_tenders", "sale_tenders"])(
    "%s: TENANT_A GUC sees its own seeded return / tender rows",
    async (table) => {
      if (maybeSkip()) return;
      const count = await withRawClient(async (client) => {
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table} WHERE tenant_id = $1`,
          [TENANT_A],
        );
        return r.rows[0]?.count;
      });
      expect(Number(count)).toBeGreaterThan(0);
    },
  );
});

describe("sales-sweep §A.4 — in-scope baseline (anchors the sweep, prevents vacuous passes)", () => {
  // If these did NOT return rows, the §A.1-A.3 zero-row assertions could pass
  // vacuously (nothing seeded). This proves the fixture IS populated for A.
  it("TENANT_A GUC sees its own captured sale", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM sales WHERE id = $1`,
        [F.saleAX],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(TENANT_A);
  });

  it("TENANT_A GUC sees its own void + refund terminal rows", async () => {
    if (maybeSkip()) return;
    const { voids, refunds } = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const v = await client.query<{ id: string }>(
        `SELECT id FROM sale_voids WHERE id = $1`,
        [F.voidAX],
      );
      const rf = await client.query<{ id: string }>(
        `SELECT id FROM sale_refunds WHERE id = $1`,
        [F.refundAX],
      );
      return { voids: v.rows, refunds: rf.rows };
    });
    expect(voids).toHaveLength(1);
    expect(refunds).toHaveLength(1);
  });
});

// ===========================================================================
// GROUP B — operation object-safety (HTTP)
// ===========================================================================
//
// These prove the API-level object-safety contract (SI-001..005): unauthenticated
// → 401; cross-tenant id → non-disclosing 404; out-of-scope store → 404; body
// tenant_id/store_id/created_by ignored.
//
// §B.1 (capture/read) are REAL HTTP assertions (T036) — the operations now
// exist. They run through the shared `__capture-harness` (real controller +
// service + RLS-active PG_POOL + IdempotencyInterceptor), brought up in §B.1's
// own `beforeAll` so a Docker-less Group-A skip short-circuits cleanly.
//
// §B.2 (void/refund) are now REAL HTTP assertions too (US3/US4 landed); they are
// folded into the §B describe below alongside capture/read (T074).

// §B — capture/read/void/refund object-safety, HTTP-driven. Imported lazily so the
// SalesController/Service references do not affect the Group-A DB-only probes.
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  STORE_A_X,
  STORE_B_X,
  type HarnessHandle,
} from "../capture/__capture-harness";

describe("sales-sweep §B.1 — capture/read object-safety (HTTP) [T036]", () => {
  const hb: HarnessHandle = { harness: null, dockerSkipped: false };

  beforeAll(async () => {
    Object.assign(hb, await startCaptureHarness());
  }, 180_000);
  afterAll(async () => {
    await stopCaptureHarness(hb);
  }, 60_000);
  beforeEach(() => resetHarness(hb));
  afterEach(async () => {
    if (hb.harness) {
      await hb.harness.env.admin.query(
        "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
      );
      await hb.harness.env.admin.query(
        "DELETE FROM sales WHERE source_system = 'pos-1'",
      );
    }
  });

  it("captureSale → cross-tenant read of the new sale is a non-disclosing 404 (FR-102, SC-004)", async () => {
    if (!hb.harness) return;
    // Tenant A captures a sale and learns its ref.
    const captured = await hb.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("swb1a"))
      .send(captureBody({ externalId: "ext-sweep-xtenant" }));
    expect(captured.status).toBe(201);
    const saleRef: string = captured.body.saleRef;
    expect(saleRef).toEqual(expect.any(String));

    // Tenant B (different principal) reads A's ref → RLS filters it → 404 with
    // NO existence leak (the body never distinguishes "not yours" from "absent").
    hb.harness.contextGuard.tenantId = TENANT_B;
    hb.harness.contextGuard.storeId = STORE_B_X;
    const crossed = await hb.harness
      .http()
      .get(`/api/pos/v1/sales/${saleRef}`);
    expect(crossed.status).toBe(404);
    // Non-disclosing: the response carries no sale field / no id echo.
    expect(JSON.stringify(crossed.body)).not.toContain(saleRef);
  });

  it("readSale → an unknown / out-of-scope sale ref is a non-disclosing 404 (FR-063, SI-004)", async () => {
    if (!hb.harness) return;
    // A well-formed UUID that was never captured in this tenant's scope.
    const phantomRef = "0a000000-0000-7000-8000-00000000face";
    const res = await hb.harness
      .http()
      .get(`/api/pos/v1/sales/${phantomRef}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(phantomRef);
  });

  it("captureSale → body-supplied tenant_id/store_id/created_by are ignored, never honored (FR-061)", async () => {
    if (!hb.harness) return;
    // Inject forbidden authority fields in the body. The strict DTO rejects
    // unknown keys (400) OR the service ignores them — either way the persisted
    // row resolves tenant/store from the principal (A.X), NEVER from the body.
    const res = await hb.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("swb1c"))
      .send(
        captureBody({
          externalId: "ext-sweep-massassign",
          tenant_id: TENANT_B,
          store_id: STORE_B_X,
          created_by: "0b000000-0000-7000-8000-0000000000ff",
        }),
      );

    if (res.status === 400) {
      // Strict DTO refused the unknown keys — no row written.
      const none = await hb.harness.env.admin.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM sales WHERE external_id = 'ext-sweep-massassign'`,
      );
      expect(none.rows[0]?.n).toBe("0");
      return;
    }

    // Otherwise the row exists but bound to the PRINCIPAL's tenant/store (A.X),
    // proving the body authority fields were ignored, not honored.
    expect(res.status).toBe(201);
    const row = await hb.harness.env.admin.query<{
      tenant_id: string;
      store_id: string;
      created_by: string;
    }>(
      `SELECT tenant_id, store_id, created_by FROM sales
       WHERE external_id = 'ext-sweep-massassign'`,
    );
    expect(row.rows[0]?.tenant_id).toBe(TENANT_A);
    expect(row.rows[0]?.store_id).toBe(STORE_A_X);
    expect(row.rows[0]?.tenant_id).not.toBe(TENANT_B);
  });

  it("unauthenticated capture → 401 (no POS principal on the request)", async () => {
    if (!hb.harness) return;
    // The configurable context guard publishes NO context this request.
    hb.harness.contextGuard.anonymous = true;
    const res = await hb.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("swb1d"))
      .send(captureBody({ externalId: "ext-sweep-anon" }));
    expect(res.status).toBe(401);
  });

  // §B.2 (T074) — void/refund object-safety, now real HTTP assertions.
  it("recordVoid → cross-tenant void of A's sale is a non-disclosing 404 (FR-014, SI-004)", async () => {
    if (!hb.harness) return;
    const cap = await hb.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("swb2v"))
      .send(captureBody({ externalId: "ext-sweep-void" }));
    expect(cap.status).toBe(201);
    const saleRef: string = cap.body.saleRef;

    hb.harness.contextGuard.tenantId = TENANT_B;
    hb.harness.contextGuard.storeId = STORE_B_X;
    const res = await hb.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/void`)
      .set("Idempotency-Key", idempKey("swb2v1"))
      .send({
        sourceSystem: "pos-1",
        externalId: "sweep-void-evt",
      });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(saleRef);
    const n = await hb.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_voids WHERE external_id = 'sweep-void-evt'`,
    );
    expect(n.rows[0]?.n).toBe("0");
  });

  it("recordRefund → cross-tenant refund of A's sale is a non-disclosing 404 (FR-014, SI-004)", async () => {
    if (!hb.harness) return;
    const cap = await hb.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("swb2r"))
      .send(captureBody({ externalId: "ext-sweep-refund" }));
    expect(cap.status).toBe(201);
    const saleRef: string = cap.body.saleRef;

    hb.harness.contextGuard.tenantId = TENANT_B;
    hb.harness.contextGuard.storeId = STORE_B_X;
    const res = await hb.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/refund`)
      .set("Idempotency-Key", idempKey("swb2r1"))
      .send({
        sourceSystem: "pos-1",
        externalId: "sweep-refund-evt",
        posRefundAmount: "1.0000",
        currencyCode: "USD",
      });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(saleRef);
    const n = await hb.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_refunds WHERE external_id = 'sweep-refund-evt'`,
    );
    expect(n.rows[0]?.n).toBe("0");
  });
});
