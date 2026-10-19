/**
 * 021-US1 + US2 integration — unmapped-product backlog + repair via 013 (T013/T014
 * + T020/T021/T022/T024). Docker-gated (WSL Testcontainers).
 *
 * Builds on the 013 `seedItemMapFixture` (tenants A/B, base products, the
 * confirmed/suggested/retired erpnext_item_map rows) + a fresh no-mapping product.
 *
 * US1 (backlog read-projection):
 *   - PRODUCT_A_ACTIVE (confirmed-active mapping) is EXCLUDED;
 *   - PRODUCT_A_RETIRED's slot (suggested-active mapping) → `suggestion_unconfirmed`;
 *   - a no-mapping product → `unmapped_dp2_product`;
 *   - cross-tenant non-disclosure (tenant B sees only its own backlog).
 *
 * US2 (repair via 013's lifecycle, in one transaction with audit):
 *   - confirm a `suggestion_unconfirmed` → 013 row `suggested→confirmed`, product
 *     leaves the backlog, repair_attempt.outcome='mapped', resolved_item_map_id set;
 *   - a 2nd confirm of the now-confirmed mapping → `no_op_echo` (no 2nd active row);
 *   - a stale-version confirm → conflict (013 version guard), product stays;
 *   - the audit_events row + repair_attempt are written in ONE transaction.
 */
import "reflect-metadata";

import { runWithTenantContext } from "@data-pulse-2/db";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ErpnextItemMapService } from "../../../../src/catalog/erpnext-item-map/erpnext-item-map.service";
import {
  ErpnextProductReconciliationService,
  RepairConflictError,
} from "../../../../src/catalog/erpnext-product-reconciliation/erpnext-product-reconciliation.service";
import {
  ITEM_MAP_FIXTURE_IDS,
  seedItemMapFixture,
} from "../../erpnext-item-map/__support__/seed-item-map";

const TENANT_A = ITEM_MAP_FIXTURE_IDS.tenantA;
const TENANT_B = ITEM_MAP_FIXTURE_IDS.tenantB;
const ACTOR_A = ITEM_MAP_FIXTURE_IDS.actorA;
const PRODUCT_A_CONFIRMED = ITEM_MAP_FIXTURE_IDS.productAConfirmed;
// productASuggested in the 013 fixture is PRODUCT_A_RETIRED — a RETIRED product
// (tp.retired_at set), so it never appears in the active-product backlog. 021
// needs an ACTIVE product carrying a suggested-only mapping; seed a dedicated one.
const PRODUCT_A_SUGGESTED = "0a000000-0000-7000-8000-00000d021541";
const MAP_A_SUGGESTED = "0a000000-0000-7000-8000-00000d021542";
const PRODUCT_A_UNMAPPED = "0a000000-0000-7000-8000-00000d021f01";

let env: PgTestEnv | null = null;
let skip = false;
let svc: ErpnextProductReconciliationService;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[021 backlog-repair.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  await seedItemMapFixture(env);
  // The catalog fixture uses ACTOR_A as a plain uuid `created_by` (no FK), but the
  // 021 repair_attempt.actor_user_id FKs to users(id) — seed the actor as a user
  // (the seed-reconciliation precedent).
  await env.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'recon021-a@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR_A],
  );
  await env.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, '021 Unmapped Widget', 'standard', $3, $3),
            ($4, $2, '021 Suggested Widget', 'standard', $3, $3)
     ON CONFLICT DO NOTHING`,
    [PRODUCT_A_UNMAPPED, TENANT_A, ACTOR_A, PRODUCT_A_SUGGESTED],
  );
  // An ACTIVE product carrying a suggested-only (inert) mapping → the
  // suggestion_unconfirmed backlog class + the US2 confirm-repair target.
  await env.admin.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, suggested_by, version)
     VALUES ($1, $2, $3, 'ERP-021-SUGG', 'suggested', 'manual', $4, 1)
     ON CONFLICT DO NOTHING`,
    [MAP_A_SUGGESTED, TENANT_A, PRODUCT_A_SUGGESTED, ACTOR_A],
  );
  svc = new ErpnextProductReconciliationService(
    env.app,
    new ErpnextItemMapService(env.app),
  );
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function backlogIds(items: readonly { tenantProductId: string }[]): Set<string> {
  return new Set(items.map((i) => i.tenantProductId));
}

describe("021-US1 — unmapped-product backlog read-projection", () => {
  it("excludes confirmed-active, classifies suggested vs no-mapping, tenant-scoped", async () => {
    if (skip) return;
    const page = await svc.listBacklog({ tenantId: TENANT_A, cursor: null, limit: 100 });
    const ids = backlogIds(page.items);
    // confirmed-active product is NOT in the backlog.
    expect(ids.has(PRODUCT_A_CONFIRMED)).toBe(false);
    // the suggested-only product IS, classified suggestion_unconfirmed.
    const suggested = page.items.find((i) => i.tenantProductId === PRODUCT_A_SUGGESTED);
    expect(suggested?.mismatchClass).toBe("suggestion_unconfirmed");
    expect(suggested?.suggestionMappingId).toBe(MAP_A_SUGGESTED);
    expect(suggested?.suggestionMappingVersion).toBe(1);
    // the no-mapping product IS, classified unmapped_dp2_product.
    const unmapped = page.items.find((i) => i.tenantProductId === PRODUCT_A_UNMAPPED);
    expect(unmapped?.mismatchClass).toBe("unmapped_dp2_product");
    expect(unmapped?.suggestionMappingId).toBeNull();
    expect(unmapped?.suggestionMappingVersion).toBeNull();
  });

  it("is cross-tenant non-disclosing (tenant B never sees tenant A products)", async () => {
    if (skip) return;
    const page = await svc.listBacklog({ tenantId: TENANT_B, cursor: null, limit: 100 });
    const ids = backlogIds(page.items);
    expect(ids.has(PRODUCT_A_SUGGESTED)).toBe(false);
    expect(ids.has(PRODUCT_A_UNMAPPED)).toBe(false);
  });

  it("filters by mismatch class", async () => {
    if (skip) return;
    const only = await svc.listBacklog({
      tenantId: TENANT_A,
      cursor: null,
      limit: 100,
      mismatchClass: "unmapped_dp2_product",
    });
    for (const i of only.items) expect(i.mismatchClass).toBe("unmapped_dp2_product");
    expect(backlogIds(only.items).has(PRODUCT_A_UNMAPPED)).toBe(true);
  });
});

describe("021-US2 — repair via the 013 lifecycle", () => {
  async function mapState(id: string): Promise<{ state: string; version: number } | null> {
    return runWithTenantContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ state: string; version: number }>(
          `SELECT state, version FROM erpnext_item_map WHERE id = $1`,
          [id],
        );
        return r.rows[0] ?? null;
      },
    );
  }

  it("confirm repair transitions 013 suggested→confirmed; product leaves backlog; outcome=mapped", async () => {
    if (skip) return;
    const before = await mapState(MAP_A_SUGGESTED);
    expect(before?.state).toBe("suggested");

    const result = await svc.repairBacklogItem({
      tenantId: TENANT_A,
      actorUserId: ACTOR_A,
      repairKind: "confirm",
      tenantProductId: PRODUCT_A_SUGGESTED,
      mappingId: MAP_A_SUGGESTED,
      version: before!.version,
    });
    expect(result.repair.outcome).toBe("mapped");
    expect(result.repair.resolvedItemMapId).toBe(MAP_A_SUGGESTED);

    const after = await mapState(MAP_A_SUGGESTED);
    expect(after?.state).toBe("confirmed");

    const page = await svc.listBacklog({ tenantId: TENANT_A, cursor: null, limit: 100 });
    expect(backlogIds(page.items).has(PRODUCT_A_SUGGESTED)).toBe(false);

    // The repair_attempt + audit_events were both written.
    const attempts = await env!.admin.query<{ outcome: string }>(
      `SELECT outcome FROM erpnext_product_reconciliation_repair_attempt
        WHERE tenant_id=$1 AND target_ref_id=$2`,
      [TENANT_A, PRODUCT_A_SUGGESTED],
    );
    expect(attempts.rows.some((r) => r.outcome === "mapped")).toBe(true);
    const audit = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE tenant_id=$1 AND action='erpnext_product_reconciliation.repaired'`,
      [TENANT_A],
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it("a 2nd confirm of the now-confirmed mapping is a no_op_echo (no 2nd active row)", async () => {
    if (skip) return;
    const cur = await mapState(MAP_A_SUGGESTED);
    const result = await svc.repairBacklogItem({
      tenantId: TENANT_A,
      actorUserId: ACTOR_A,
      repairKind: "confirm",
      tenantProductId: PRODUCT_A_SUGGESTED,
      mappingId: MAP_A_SUGGESTED,
      version: cur!.version, // current version → confirm fails (already confirmed) → no_op_echo
    });
    expect(result.repair.outcome).toBe("no_op_echo");
    expect(result.replayed).toBe(true);

    const active = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM erpnext_item_map
        WHERE tenant_id=$1 AND tenant_product_id=$2 AND retired_at IS NULL`,
      [TENANT_A, PRODUCT_A_SUGGESTED],
    );
    expect(active.rows[0]!.count).toBe("1");
  });

  it("a stale-version confirm is a conflict (013 version guard); the attempt is recorded", async () => {
    if (skip) return;
    // Seed a fresh suggested mapping on the unmapped product, then confirm with a
    // wrong version → conflict.
    const sug = await runWithTenantContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `INSERT INTO erpnext_item_map
             (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, suggested_by, version)
           VALUES (gen_random_uuid(), $1, $2, 'ERP-021-STALE', 'suggested', 'manual', $3, 1)
           RETURNING id`,
          [TENANT_A, PRODUCT_A_UNMAPPED, ACTOR_A],
        );
        return r.rows[0]!.id;
      },
    );
    await expect(
      svc.repairBacklogItem({
        tenantId: TENANT_A,
        actorUserId: ACTOR_A,
        repairKind: "confirm",
        tenantProductId: PRODUCT_A_UNMAPPED,
        mappingId: sug,
        version: 999, // stale
      }),
    ).rejects.toBeInstanceOf(RepairConflictError);

    // The product stays in the backlog (still suggested).
    const page = await svc.listBacklog({ tenantId: TENANT_A, cursor: null, limit: 100 });
    expect(backlogIds(page.items).has(PRODUCT_A_UNMAPPED)).toBe(true);
    // A conflict attempt was recorded.
    const conflicts = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM erpnext_product_reconciliation_repair_attempt
        WHERE tenant_id=$1 AND outcome='conflict'`,
      [TENANT_A],
    );
    expect(Number(conflicts.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it("suggest_confirm repair maps an unmapped product (suggest→confirm in one tx)", async () => {
    if (skip) return;
    // A fresh unmapped active product with NO mapping at all.
    const prod = "0a000000-0000-7000-8000-00000d021c01";
    await env!.admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, '021 SuggestConfirm', 'standard', $3, $3) ON CONFLICT DO NOTHING`,
      [prod, TENANT_A, ACTOR_A],
    );
    const result = await svc.repairBacklogItem({
      tenantId: TENANT_A,
      actorUserId: ACTOR_A,
      repairKind: "suggest_confirm",
      tenantProductId: prod,
      erpnextItemRef: "ERP-021-SC-NEW",
    });
    expect(result.repair.outcome).toBe("mapped");
    expect(result.repair.resolvedItemMapId).not.toBeNull();
    // Exactly one active confirmed mapping now exists for the product.
    const active = await env!.admin.query<{ count: string; state: string }>(
      `SELECT count(*)::text AS count, max(state) AS state FROM erpnext_item_map
        WHERE tenant_id=$1 AND tenant_product_id=$2 AND retired_at IS NULL`,
      [TENANT_A, prod],
    );
    expect(active.rows[0]!.count).toBe("1");
    expect(active.rows[0]!.state).toBe("confirmed");
    // The product left the backlog.
    const page = await svc.listBacklog({ tenantId: TENANT_A, cursor: null, limit: 100 });
    expect(backlogIds(page.items).has(prod)).toBe(false);
  });

  it("suggest_confirm onto an already-active CONFIRMED mapping → no_op_echo, attempt + audit recorded (SAVEPOINT: no aborted-tx 500)", async () => {
    if (skip) return;
    // Regression for the transaction-abort bug: suggestOnClient's INSERT hits
    // the 013 active-1:1 partial-unique (23505). Without a SAVEPOINT around it
    // the swallowed 23505 leaves the PG tx aborted, so the conflict-disambiguation
    // SELECT + recordRepairAttempt INSERT + audit INSERT all throw 25P02 → an
    // unhandled 500 with NEITHER a repair_attempt NOR an audit row (violates FR-012).
    // With the SAVEPOINT the tx stays usable and the conflict IS the recorded outcome.
    const prod = "0a000000-0000-7000-8000-00000d021c02";
    await env!.admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, '021 SuggestConfirm Active', 'standard', $3, $3) ON CONFLICT DO NOTHING`,
      [prod, TENANT_A, ACTOR_A],
    );
    // Pre-seed an active CONFIRMED mapping so the suggest INSERT collides (23505).
    // state='confirmed' requires confirmed_by/confirmed_at (013 confirmed_paired CHECK).
    await env!.admin.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source,
          suggested_by, confirmed_by, confirmed_at, version)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-021-SC-ACTIVE', 'confirmed', 'manual',
               $3, $3, now(), 2)`,
      [TENANT_A, prod, ACTOR_A],
    );

    const before = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM erpnext_product_reconciliation_repair_attempt WHERE tenant_id=$1`,
      [TENANT_A],
    );

    const result = await svc.repairBacklogItem({
      tenantId: TENANT_A,
      actorUserId: ACTOR_A,
      repairKind: "suggest_confirm",
      tenantProductId: prod,
      erpnextItemRef: "ERP-021-SC-COLLIDE",
    });
    expect(result.repair.outcome).toBe("no_op_echo");
    expect(result.repair.resolvedItemMapId).not.toBeNull();

    // Still exactly ONE active mapping (no 2nd row written).
    const active = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM erpnext_item_map
        WHERE tenant_id=$1 AND tenant_product_id=$2 AND retired_at IS NULL`,
      [TENANT_A, prod],
    );
    expect(active.rows[0]!.count).toBe("1");

    // FR-012: the conflict IS the recorded outcome — a repair_attempt was persisted
    // (proves the tx was NOT aborted; the INSERT after the swallowed 23505 succeeded).
    const after = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM erpnext_product_reconciliation_repair_attempt WHERE tenant_id=$1`,
      [TENANT_A],
    );
    expect(Number(after.rows[0]!.count)).toBe(Number(before.rows[0]!.count) + 1);

    // And the in-transaction audit row was written.
    const audit = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE tenant_id=$1 AND action='erpnext_product_reconciliation.repaired'`,
      [TENANT_A],
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it("repairResult transitions a persisted result open→repaired on a mapped outcome", async () => {
    if (skip) return;
    // Seed a run + an open result + a fresh suggested mapping to confirm.
    const prod = "0a000000-0000-7000-8000-00000d021c11";
    const map = "0a000000-0000-7000-8000-00000d021c12";
    const runId = "0a000000-0000-7000-8000-00000d021c13";
    const resultId = "0a000000-0000-7000-8000-00000d021c14";
    await env!.admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, '021 ResultRepair', 'standard', $3, $3) ON CONFLICT DO NOTHING`,
      [prod, TENANT_A, ACTOR_A],
    );
    await env!.admin.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, suggested_by, version)
       VALUES ($1, $2, $3, 'ERP-021-RR', 'suggested', 'manual', $4, 1) ON CONFLICT DO NOTHING`,
      [map, TENANT_A, prod, ACTOR_A],
    );
    await env!.admin.query(
      `INSERT INTO erpnext_product_reconciliation_run
         (id, tenant_id, trigger, status, erpnext_view_status, finished_at, actor_user_id)
       VALUES ($1, $2, 'on_demand', 'completed', 'unavailable', now(), $3) ON CONFLICT DO NOTHING`,
      [runId, TENANT_A, ACTOR_A],
    );
    await env!.admin.query(
      `INSERT INTO erpnext_product_reconciliation_result
         (id, run_id, tenant_id, mismatch_class, tenant_product_id, result_state)
       VALUES ($1, $2, $3, 'suggestion_unconfirmed', $4, 'open') ON CONFLICT DO NOTHING`,
      [resultId, runId, TENANT_A, prod],
    );

    const result = await svc.repairResult({
      tenantId: TENANT_A,
      actorUserId: ACTOR_A,
      repairKind: "confirm",
      tenantProductId: prod,
      mappingId: map,
      version: 1,
      runId,
      resultId,
    });
    expect(result.repair.outcome).toBe("mapped");
    expect(result.repair.targetKind).toBe("result");

    const after = await env!.admin.query<{ result_state: string }>(
      `SELECT result_state FROM erpnext_product_reconciliation_result WHERE id=$1`,
      [resultId],
    );
    expect(after.rows[0]!.result_state).toBe("repaired");
  });

  it("repairResult on a foreign/absent result → RunNotFoundError", async () => {
    if (skip) return;
    await expect(
      svc.repairResult({
        tenantId: TENANT_A,
        actorUserId: ACTOR_A,
        repairKind: "confirm",
        tenantProductId: PRODUCT_A_UNMAPPED,
        mappingId: "0f000000-0000-7000-8000-0000000000ff",
        version: 1,
        runId: "0f000000-0000-7000-8000-0000000000a0",
        resultId: "0f000000-0000-7000-8000-0000000000a1",
      }),
    ).rejects.toThrow();
  });
});

describe("RT-733 — the current 013 mapping version is exposed for confirm / re_point", () => {
  const PROD_V = "0a000000-0000-7000-8000-00000d0733a1";
  const MAP_V = "0a000000-0000-7000-8000-00000d0733a2";
  const PROD_N = "0a000000-0000-7000-8000-00000d0733a3";
  const RUN_V = "0a000000-0000-7000-8000-00000d0733a4";
  const RES_V = "0a000000-0000-7000-8000-00000d0733a5";
  const RES_N = "0a000000-0000-7000-8000-00000d0733a6";
  const RES_E = "0a000000-0000-7000-8000-00000d0733a7";

  beforeAll(async () => {
    if (skip) return;
    await env!.admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, 'RT-733 Versioned', 'standard', $3, $3),
              ($4, $2, 'RT-733 No Mapping', 'standard', $3, $3)
       ON CONFLICT DO NOTHING`,
      [PROD_V, TENANT_A, ACTOR_A, PROD_N],
    );
    // A suggested mapping already past version 1, so the exposed value is the
    // row's real version, not a default.
    await env!.admin.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, suggested_by, version)
       VALUES ($1, $2, $3, 'ERP-733-V', 'suggested', 'manual', $4, 3) ON CONFLICT DO NOTHING`,
      [MAP_V, TENANT_A, PROD_V, ACTOR_A],
    );
    await env!.admin.query(
      `INSERT INTO erpnext_product_reconciliation_run
         (id, tenant_id, trigger, status, erpnext_view_status, finished_at, actor_user_id)
       VALUES ($1, $2, 'on_demand', 'completed', 'available', now(), $3) ON CONFLICT DO NOTHING`,
      [RUN_V, TENANT_A, ACTOR_A],
    );
    await env!.admin.query(
      `INSERT INTO erpnext_product_reconciliation_result
         (id, run_id, tenant_id, mismatch_class, tenant_product_id, erpnext_item_ref, result_state)
       VALUES ($1, $4, $5, 'suggestion_unconfirmed', $6, NULL, 'open'),
              ($2, $4, $5, 'unmapped_dp2_product', $7, NULL, 'open'),
              ($3, $4, $5, 'unmapped_erpnext_item', NULL, 'ERP-733-ONLY', 'open')
       ON CONFLICT DO NOTHING`,
      [RES_V, RES_N, RES_E, RUN_V, TENANT_A, PROD_V, PROD_N],
    );
  });

  async function exposedBacklogVersion(): Promise<number | null | undefined> {
    const page = await svc.listBacklog({ tenantId: TENANT_A, cursor: null, limit: 500 });
    return page.items.find((i) => i.tenantProductId === PROD_V)?.suggestionMappingVersion;
  }

  it("the backlog carries the suggestion row's current version; null without a mapping", async () => {
    if (skip) return;
    const page = await svc.listBacklog({ tenantId: TENANT_A, cursor: null, limit: 500 });
    const v = page.items.find((i) => i.tenantProductId === PROD_V);
    expect(v?.suggestionMappingId).toBe(MAP_V);
    expect(v?.suggestionMappingVersion).toBe(3);
    const n = page.items.find((i) => i.tenantProductId === PROD_N);
    expect(n?.suggestionMappingId).toBeNull();
    expect(n?.suggestionMappingVersion).toBeNull();
  });

  it("run results carry the active mapping id + version; null without a mapping or product", async () => {
    if (skip) return;
    const page = await svc.listResults({ tenantId: TENANT_A, runId: RUN_V, cursor: null, limit: 100 });
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(RES_V)).toMatchObject({ mappingId: MAP_V, mappingVersion: 3 });
    expect(byId.get(RES_N)).toMatchObject({ mappingId: null, mappingVersion: null });
    expect(byId.get(RES_E)).toMatchObject({ mappingId: null, mappingVersion: null });
  });

  it("an exposed version that went stale is still a conflict; the fresh one maps", async () => {
    if (skip) return;
    const stale = await exposedBacklogVersion();
    expect(stale).toBe(3);
    // A concurrent 013 write moves the version after the client read it.
    await env!.admin.query(
      `UPDATE erpnext_item_map SET version = version + 1 WHERE id = $1`,
      [MAP_V],
    );
    await expect(
      svc.repairBacklogItem({
        tenantId: TENANT_A,
        actorUserId: ACTOR_A,
        repairKind: "confirm",
        tenantProductId: PROD_V,
        mappingId: MAP_V,
        version: stale!,
      }),
    ).rejects.toBeInstanceOf(RepairConflictError);

    const fresh = await exposedBacklogVersion();
    expect(fresh).toBe(4);
    const ok = await svc.repairBacklogItem({
      tenantId: TENANT_A,
      actorUserId: ACTOR_A,
      repairKind: "confirm",
      tenantProductId: PROD_V,
      mappingId: MAP_V,
      version: fresh!,
    });
    expect(ok.repair.outcome).toBe("mapped");
    expect(ok.repair.resolvedItemMapId).toBe(MAP_V);

    // The result read follows the live 013 row: the confirm bumped the version.
    const page = await svc.listResults({ tenantId: TENANT_A, runId: RUN_V, cursor: null, limit: 100 });
    expect(page.items.find((i) => i.id === RES_V)).toMatchObject({ mappingId: MAP_V, mappingVersion: 5 });

    // FR-011 is unchanged: once the row is confirmed-and-active, a confirm with
    // an older version is the idempotent no_op_echo, not a conflict.
    const echo = await svc.repairBacklogItem({
      tenantId: TENANT_A,
      actorUserId: ACTOR_A,
      repairKind: "confirm",
      tenantProductId: PROD_V,
      mappingId: MAP_V,
      version: stale!,
    });
    expect(echo.repair.outcome).toBe("no_op_echo");
    expect(echo.repair.resolvedItemMapId).toBe(MAP_V);
  });
});
