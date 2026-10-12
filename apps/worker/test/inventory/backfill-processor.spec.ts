/**
 * T064 / T063b [TC] — Off-request inventory-backfill worker (009-US4).
 *
 * Proves the InventoryBackfillProcessor turns CAPTURED 008 sales into
 * sale-linked outbound movements OFF-REQUEST (FR-032/060, FR-033, §V):
 *
 *   T064  — one outbound per captured sale line, provenance recorded, on-hand
 *           decremented; a re-run is idempotent (no duplicate, on-hand stable).
 *           A null-product line never auto-creates a product (FR-023/R5).
 *   T063b — it establishes tenant context BEFORE any DB access (the processor
 *           runs on the non-superuser `app` pool, so skipping it would fail
 *           RLS); a sibling assertion pins that the app role genuinely cannot
 *           INSERT a movement without the GUC (no trivial bypass — T561 pattern);
 *           and it never resolves / mutates a sale outside its tenant scope.
 *
 * Docker/Testcontainers required. Soft-skips with MIGRATION_TEST_ALLOW_SKIP=1.
 * Registered in jest.config.cjs `dockerOutboxSuites` so the no-Docker fast job
 * excludes it (project_008_worker_ci_jest_exclusion / F-04).
 */
import {
  applyAllUpAndCreateAppRole,
  APP_ROLE_NAME,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import {
  InventoryBackfillProcessor,
  InventoryBackfillSaleNotFoundError,
  InventoryBackfillCrossUnitError,
  InventoryBackfillTooManyLinesError,
  MAX_BACKFILL_MOVEMENTS,
} from "../../src/inventory/backfill.processor";
import {
  seedCapturedSaleForBackfill,
  seedManyLines,
  readOnHand,
  countMovements,
} from "./__support__/seed";

// Hex-only UUID literals (memory: restrict mnemonic prefixes to a-f).
const TENANT_A = "1c0e0000-0000-7000-8000-0000000000a1";
const STORE_A = "1c0e0000-0000-7000-8000-0000000000b1";
const ACTOR_A = "1c0e0000-0000-7000-8000-0000000000c1";
const PRODUCT_A = "1c0e0000-0000-7000-8000-0000000000e1";
const SALE_A = "1c0e0000-0000-7000-8000-0000000000d1";
const SALE_ADHOC = "1c0e0000-0000-7000-8000-0000000000d2";
const SALE_WRONGUNIT = "1c0e0000-0000-7000-8000-0000000000d4";
// 009-POLISH T101 — an over-ceiling sale (>500 lines) + a boundary sale (≤500).
const SALE_OVER_CEILING = "1c0e0000-0000-7000-8000-0000000000d5";
const PRODUCT_CEIL = "1c0e0000-0000-7000-8000-0000000000e5";
const SALE_AT_CEILING = "1c0e0000-0000-7000-8000-0000000000d6";
const PRODUCT_CEIL2 = "1c0e0000-0000-7000-8000-0000000000e6";

const TENANT_B = "1c0e0000-0000-7000-8000-0000000000a2";
const STORE_B = "1c0e0000-0000-7000-8000-0000000000b2";
const ACTOR_B = "1c0e0000-0000-7000-8000-0000000000c2";
const PRODUCT_B = "1c0e0000-0000-7000-8000-0000000000e2";
const SALE_B = "1c0e0000-0000-7000-8000-0000000000d3";

const SOURCE_SYSTEM = "pos-backfill";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);

    // Tenant A: a captured sale with two product-referenced lines (qty 2 + 3).
    await seedCapturedSaleForBackfill(env.admin, {
      tenantId: TENANT_A,
      storeId: STORE_A,
      saleId: SALE_A,
      actorId: ACTOR_A,
      productId: PRODUCT_A,
      slugSuffix: "a",
      lines: [
        { quantity: "2.0000", unit: "ea", productRef: PRODUCT_A },
        { quantity: "3.0000", unit: "ea", productRef: PRODUCT_A },
      ],
    });

    // Tenant A: a captured sale whose line has NO product (ad-hoc, R5).
    await seedCapturedSaleForBackfill(env.admin, {
      tenantId: TENANT_A,
      storeId: STORE_A,
      saleId: SALE_ADHOC,
      actorId: ACTOR_A,
      productId: PRODUCT_A, // already seeded; re-seed is idempotent
      slugSuffix: "a",
      lines: [{ quantity: "4.0000", unit: "ea", productRef: null }],
    });

    // Tenant A: a captured sale whose line references PRODUCT_A but in a
    // DIFFERENT unit ('kg' vs the 'ea' SALE_A establishes) — FR-022 cross-unit.
    await seedCapturedSaleForBackfill(env.admin, {
      tenantId: TENANT_A,
      storeId: STORE_A,
      saleId: SALE_WRONGUNIT,
      actorId: ACTOR_A,
      productId: PRODUCT_A, // already seeded; re-seed idempotent
      slugSuffix: "a",
      lines: [{ quantity: "1.0000", unit: "kg", productRef: PRODUCT_A }],
    });

    // Tenant B (cross-tenant isolation probe).
    await seedCapturedSaleForBackfill(env.admin, {
      tenantId: TENANT_B,
      storeId: STORE_B,
      saleId: SALE_B,
      actorId: ACTOR_B,
      productId: PRODUCT_B,
      slugSuffix: "b",
      lines: [{ quantity: "1.0000", unit: "ea", productRef: PRODUCT_B }],
    });

    // 009-POLISH T101 — OVER-ceiling sale: 1 seeded line + 500 bulk = 501 (>500).
    await seedCapturedSaleForBackfill(env.admin, {
      tenantId: TENANT_A,
      storeId: STORE_A,
      saleId: SALE_OVER_CEILING,
      actorId: ACTOR_A,
      productId: PRODUCT_CEIL,
      slugSuffix: "a",
      lines: [{ quantity: "1.0000", unit: "ea", productRef: PRODUCT_CEIL }],
    });
    await seedManyLines(env.admin, {
      saleId: SALE_OVER_CEILING,
      tenantId: TENANT_A,
      storeId: STORE_A,
      productId: PRODUCT_CEIL,
      count: MAX_BACKFILL_MOVEMENTS, // 1 + 500 = 501 > ceiling
    });

    // T101 boundary — AT-ceiling sale: 1 seeded line + 499 bulk = 500 (≤500).
    await seedCapturedSaleForBackfill(env.admin, {
      tenantId: TENANT_A,
      storeId: STORE_A,
      saleId: SALE_AT_CEILING,
      actorId: ACTOR_A,
      productId: PRODUCT_CEIL2,
      slugSuffix: "a",
      lines: [{ quantity: "1.0000", unit: "ea", productRef: PRODUCT_CEIL2 }],
    });
    await seedManyLines(env.admin, {
      saleId: SALE_AT_CEILING,
      tenantId: TENANT_A,
      storeId: STORE_A,
      productId: PRODUCT_CEIL2,
      count: MAX_BACKFILL_MOVEMENTS - 1, // 1 + 499 = 500 == ceiling (allowed)
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      console.warn(`\n[inventory/backfill-processor.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
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
    console.warn("[inventory/backfill-processor.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

describe("T064: backfill appends one outbound per captured sale line", () => {
  it("decrements on-hand by the summed line quantities and records provenance", async () => {
    if (maybeSkip()) return;

    const before = await readOnHand(env!.admin, STORE_A, PRODUCT_A);
    expect(before).toBe(0);

    const processor = new InventoryBackfillProcessor(env!.app);
    const result = await processor.process({
      saleId: SALE_A,
      tenantId: TENANT_A,
      storeId: STORE_A,
      actorId: ACTOR_A,
      sourceSystem: SOURCE_SYSTEM,
      correlationId: "corr-backfill-a",
    });

    expect(result.saleId).toBe(SALE_A);
    expect(result.appended).toBe(2);
    expect(result.deduped).toBe(0);
    expect(result.applied).toBe(true);

    // Two outbounds (-2 + -3) → on-hand -5.
    expect(await readOnHand(env!.admin, STORE_A, PRODUCT_A)).toBe(-5);
    expect(await countMovements(env!.admin, STORE_A, PRODUCT_A)).toBe(2);

    // Provenance recorded: both movements carry the sale id + source/external.
    const prov = await env!.admin.query<{ sale_id: string; source_system: string }>(
      `SELECT sale_id, source_system FROM stock_movements
        WHERE store_id = $1 AND tenant_product_ref = $2`,
      [STORE_A, PRODUCT_A],
    );
    expect(prov.rows).toHaveLength(2);
    for (const r of prov.rows) {
      expect(r.sale_id).toBe(SALE_A);
      expect(r.source_system).toBe(SOURCE_SYSTEM);
    }
  });

  it("is idempotent: re-running the same sale appends nothing and leaves on-hand unchanged (FR-033)", async () => {
    if (maybeSkip()) return;

    const onHandBefore = await readOnHand(env!.admin, STORE_A, PRODUCT_A);
    const countBefore = await countMovements(env!.admin, STORE_A, PRODUCT_A);

    const processor = new InventoryBackfillProcessor(env!.app);
    const result = await processor.process({
      saleId: SALE_A,
      tenantId: TENANT_A,
      storeId: STORE_A,
      actorId: ACTOR_A,
      sourceSystem: SOURCE_SYSTEM,
      correlationId: "corr-backfill-a-rerun",
    });

    // Every line deduped — fully idempotent re-run.
    expect(result.appended).toBe(0);
    expect(result.deduped).toBe(2);
    expect(result.applied).toBe(false);

    expect(await readOnHand(env!.admin, STORE_A, PRODUCT_A)).toBe(onHandBefore);
    expect(await countMovements(env!.admin, STORE_A, PRODUCT_A)).toBe(countBefore);
  });

  it("rejects a sale line whose unit is inconsistent with the product's established unit (FR-022)", async () => {
    if (maybeSkip()) return;

    // PRODUCT_A's established unit is 'ea' (set by the SALE_A backfill above).
    // SALE_WRONGUNIT's line references PRODUCT_A in 'kg' — MUST be rejected, no
    // silent coercion. (The transaction rolls back, so no movement is written.)
    const countBefore = await countMovements(env!.admin, STORE_A, PRODUCT_A);

    const processor = new InventoryBackfillProcessor(env!.app);
    await expect(
      processor.process({
        saleId: SALE_WRONGUNIT,
        tenantId: TENANT_A,
        storeId: STORE_A,
        actorId: ACTOR_A,
        sourceSystem: SOURCE_SYSTEM,
        correlationId: "corr-wrongunit",
      }),
    ).rejects.toBeInstanceOf(InventoryBackfillCrossUnitError);

    // No partial side-effect: the rejected line wrote no movement.
    expect(await countMovements(env!.admin, STORE_A, PRODUCT_A)).toBe(countBefore);
  });

  it("never auto-creates a product for an ad-hoc null-product line (FR-023/R5)", async () => {
    if (maybeSkip()) return;

    const tpBefore = await env!.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_products WHERE tenant_id = $1`,
      [TENANT_A],
    );

    const processor = new InventoryBackfillProcessor(env!.app);
    const result = await processor.process({
      saleId: SALE_ADHOC,
      tenantId: TENANT_A,
      storeId: STORE_A,
      actorId: ACTOR_A,
      sourceSystem: SOURCE_SYSTEM,
      correlationId: "corr-backfill-adhoc",
    });
    expect(result.appended).toBe(1);

    // The movement persists with a NULL product ref; no product was created.
    const tpAfter = await env!.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_products WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(tpAfter.rows[0]!.n).toBe(tpBefore.rows[0]!.n);

    const nullProd = await env!.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movements
        WHERE store_id = $1 AND tenant_product_ref IS NULL AND sale_id = $2`,
      [STORE_A, SALE_ADHOC],
    );
    expect(Number(nullProd.rows[0]!.n)).toBe(1);
  });
});

describe("T063b: tenant context + RLS isolation (§V)", () => {
  it("FAILS to insert a movement when the connection has NO tenant context (no trivial bypass)", async () => {
    if (maybeSkip()) return;

    // Direct INSERT on the app pool with NO app.current_tenant GUC: the
    // stock_movements_tenant_insert WITH CHECK denies (tenant_id != NULL),
    // proving the processor MUST establish tenant context before DB access.
    // The row carries a valid position (RT-432, 0044) so RLS — not the
    // position CHECK — is what refuses it.
    const primary = await env!.admin.query<{ id: string }>(
      `SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`,
      [STORE_A],
    );
    const client = await env!.app.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO stock_movements
             (tenant_id, store_id, movement_type, quantity, stocking_unit,
              created_by, stock_location_id, inventory_status)
           VALUES ($1, $2, 'outbound', -1::numeric(19,4), 'ea', $3, $4, 'sellable')`,
          [TENANT_A, STORE_A, ACTOR_A, primary.rows[0]!.id],
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      client.release();
    }
  });

  it("does not resolve / backfill a sale outside the caller's tenant scope", async () => {
    if (maybeSkip()) return;

    // Processor bound to TENANT_A cannot resolve TENANT_B's sale → non-disclosing.
    const processor = new InventoryBackfillProcessor(env!.app);
    await expect(
      processor.process({
        saleId: SALE_B,
        tenantId: TENANT_A,
        storeId: STORE_B,
        actorId: ACTOR_A,
        sourceSystem: SOURCE_SYSTEM,
        correlationId: "corr-cross",
      }),
    ).rejects.toBeInstanceOf(InventoryBackfillSaleNotFoundError);

    // TENANT_B's product has no movements — nothing was backfilled cross-tenant.
    expect(await countMovements(env!.admin, STORE_B, PRODUCT_B)).toBe(0);
  });

  it("redacts: a failed-job log carries ONLY safe identifiers (§XIV)", async () => {
    if (maybeSkip()) return;

    const MISSING = "1c0e0000-0000-7000-8000-0000000000ee";
    const logged: Array<Record<string, unknown>> = [];
    const logger = { error: (obj: Record<string, unknown>) => logged.push(obj) };
    const processor = new InventoryBackfillProcessor(env!.app, logger);

    await expect(
      processor.process({
        saleId: MISSING,
        tenantId: TENANT_A,
        storeId: STORE_A,
        actorId: ACTOR_A,
        sourceSystem: SOURCE_SYSTEM,
        correlationId: "corr-redact",
      }),
    ).rejects.toBeInstanceOf(InventoryBackfillSaleNotFoundError);

    expect(logged).toHaveLength(1);
    const entry = logged[0]!;
    expect(Object.keys(entry).sort()).toEqual(
      ["correlation_id", "error_class", "job_name", "sale_id", "store_id", "tenant_id"].sort(),
    );
    expect(entry["error_class"]).toBe("InventoryBackfillSaleNotFoundError");
    for (const forbidden of ["quantity", "line_amount", "payload", "payload_hash", "lines"]) {
      expect(entry).not.toHaveProperty(forbidden);
    }
  });
});

describe("T101 (009-POLISH) — per-request backfill ceiling (plan §1.5)", () => {
  it(`rejects a job over the ${MAX_BACKFILL_MOVEMENTS}-movement ceiling with NO partial writes`, async () => {
    if (maybeSkip()) return;

    // SALE_OVER_CEILING has 501 lines (> ceiling). Reject deterministically and
    // write ZERO movements (the guard is before the append loop).
    const before = await countMovements(env!.admin, STORE_A, PRODUCT_CEIL);
    expect(before).toBe(0);

    const processor = new InventoryBackfillProcessor(env!.app);
    await expect(
      processor.process({
        saleId: SALE_OVER_CEILING,
        tenantId: TENANT_A,
        storeId: STORE_A,
        actorId: ACTOR_A,
        sourceSystem: SOURCE_SYSTEM,
        correlationId: "corr-over-ceiling",
      }),
    ).rejects.toBeInstanceOf(InventoryBackfillTooManyLinesError);

    // No unbounded path AND no partial application.
    expect(await countMovements(env!.admin, STORE_A, PRODUCT_CEIL)).toBe(0);
  });

  it(`accepts a job exactly at the ${MAX_BACKFILL_MOVEMENTS}-movement boundary`, async () => {
    if (maybeSkip()) return;

    // SALE_AT_CEILING has exactly 500 lines (== ceiling, allowed).
    const processor = new InventoryBackfillProcessor(env!.app);
    const result = await processor.process({
      saleId: SALE_AT_CEILING,
      tenantId: TENANT_A,
      storeId: STORE_A,
      actorId: ACTOR_A,
      sourceSystem: SOURCE_SYSTEM,
      correlationId: "corr-at-ceiling",
    });
    expect(result.appended).toBe(MAX_BACKFILL_MOVEMENTS);
    expect(await countMovements(env!.admin, STORE_A, PRODUCT_CEIL2)).toBe(
      MAX_BACKFILL_MOVEMENTS,
    );
  });
});

describe("APP_ROLE_NAME sanity: app_test role has rolbypassrls=false", () => {
  it("confirms the RLS premise (no trivial bypass)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=$1`,
      [APP_ROLE_NAME],
    );
    expect(r.rows[0]!.rolbypassrls).toBe(false);
  });
});
