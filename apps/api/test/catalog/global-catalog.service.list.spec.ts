/**
 * T360 — GlobalCatalogService.list — RED test.
 *
 * Purpose
 * -------
 * Pins the contract that `GlobalCatalogService.list` must satisfy:
 *   - Any authenticated tenant-side actor can read active global_products
 *     rows (spec §5.1 — "any authenticated tenant user, read-only").
 *   - Retired rows (retired_at IS NOT NULL) are excluded.
 *   - The same set is visible from Tenant A and Tenant B contexts —
 *     global_products is platform-wide, NOT tenant-scoped (data-model.md §2,
 *     RLS: SELECT TRUE for runtime role).
 *   - The service is the ONLY sanctioned read path for Global Product Index
 *     from tenant-side actors (tasks.md T360 description).
 *
 * Spec references
 * ---------------
 *   spec.md §5.1 — Global Product Index: reference only, read-only for all
 *     authenticated tenant users; Platform Admin is the sole writer.
 *   data-model.md §2 — global_products RLS SELECT policy is `TRUE` (any
 *     authenticated session), but retired rows should not surface in the list.
 *   tasks.md T360 — acceptance: service exists, list path returns active rows
 *     visible from any tenant context.
 *
 * RED design
 * ----------
 * This file imports `GlobalCatalogService` from its expected implementation
 * path (`../../src/modules/catalog/global-catalog.service`). That module does
 * NOT exist yet (T361 implements it). The test runner therefore fails at the
 * module-resolution stage, producing:
 *
 *   Cannot find module '../../src/modules/catalog/global-catalog.service'
 *
 * That is the correct RED reason for this slice.
 *
 * Docker availability
 * -------------------
 * Mirrors the T341 pattern: if Docker is unavailable the spec emits a
 * console.warn and returns from each `it` via `maybeSkip()`. Set
 * `MIGRATION_TEST_ALLOW_SKIP=1` in the environment to enable this path.
 * When Docker IS available the full Testcontainers + RLS path runs.
 *
 * Fixture notes
 * -------------
 * Reuses the two standard tenants (TENANT_A, TENANT_B) and the platform
 * GLOBAL_PRODUCT seeded by `seedCatalogIsolationFixture`. Adds ONE
 * additional retired global product (T360_RETIRED_GLOBAL) via a local
 * INSERT in `beforeAll` to verify the active-only filter.
 *
 * Signature pinned by this test
 * -----------------------------
 * T361 must implement:
 *   class GlobalCatalogService {
 *     constructor(@Inject(PG_POOL) pool: Pool)
 *     async list(): Promise<GlobalProductRow[]>
 *   }
 *
 * where `GlobalProductRow` is at minimum `{ id: string; name: string;
 * retired_at: string | null }`. The exact DTO shape is T361's decision;
 * the test asserts only id presence and retired_at exclusion. No
 * pagination is mandated by the spec for v1; T361 may add it later
 * under a separate RED slice.
 *
 * Note for Maestro: the list signature (no pagination, no filter params)
 * was decided at T360 test-authoring time. The spec does not mandate
 * pagination for v1 list. T361 must match this exact signature.
 */

// ---------------------------------------------------------------------------
// RED import — module does not exist yet. This is the intended failure point.
// ---------------------------------------------------------------------------
import { GlobalCatalogService } from "../../src/modules/catalog/global-catalog.service";

import { runWithTenantContext } from "@data-pulse-2/db/middleware/tenant-context";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  CATALOG_FIXTURE_IDS,
  GLOBAL_PRODUCT,
} from "./__support__/isolation-harness";

// ---------------------------------------------------------------------------
// Additional fixture ID — retired global product (local to this spec)
// ---------------------------------------------------------------------------

/**
 * A retired global_product inserted by this spec's beforeAll to verify
 * `GlobalCatalogService.list` excludes retired rows. The mnemonic prefix
 * `0c` keeps it adjacent to the harness GLOBAL_PRODUCT prefix.
 */
const RETIRED_GLOBAL_PRODUCT = "0c000000-0000-7000-8000-00000000c002";

/** Actor ID used as created_by for the retired row (no FK, any UUID). */
const PLATFORM_ACTOR = "0c000000-0000-7000-8000-0000000000ac";

// ---------------------------------------------------------------------------
// Suite-level state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;

// ---- Lifecycle -----------------------------------------------------------

beforeAll(async () => {
  // Narrow MIGRATION_TEST_ALLOW_SKIP=1 to Docker-only failures so a real
  // regression in migrations/seeds is not silently swallowed.
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[global-catalog.service.list.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  // Container is up — failures past this point are real and must not skip.
  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Insert a retired global_product to exercise the active-only filter.
  await env.admin.query(
    `INSERT INTO global_products
       (id, name, suggested_tax_category, retired_at, created_by)
     VALUES ($1, 'T360 Retired Global Product', 'standard', now(), $2)
     ON CONFLICT DO NOTHING`,
    [RETIRED_GLOBAL_PRODUCT, PLATFORM_ACTOR],
  );
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// ---- Guard helper ----------------------------------------------------------

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn(
      "[global-catalog.service.list.spec] skipping — Docker unavailable",
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Group A — Happy path: active global products visible from Tenant A context
// ---------------------------------------------------------------------------

describe("T360 — GlobalCatalogService.list: happy path from Tenant A context", () => {
  it("returns a non-empty array that includes the harness GLOBAL_PRODUCT", async () => {
    if (maybeSkip()) return;
    const service = new GlobalCatalogService(env!.admin);
    await runWithTenantContext(
      env!.admin,
      { tenantId: CATALOG_FIXTURE_IDS.tenantA, isPlatformAdmin: false },
      async () => {
        const rows = await service.list();
        expect(Array.isArray(rows)).toBe(true);
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(GLOBAL_PRODUCT);
      },
    );
  });

  it("every returned row has an id and name", async () => {
    if (maybeSkip()) return;
    const service = new GlobalCatalogService(env!.admin);
    await runWithTenantContext(
      env!.admin,
      { tenantId: CATALOG_FIXTURE_IDS.tenantA, isPlatformAdmin: false },
      async () => {
        const rows = await service.list();
        for (const row of rows) {
          expect(typeof row.id).toBe("string");
          expect(row.id.length).toBeGreaterThan(0);
          expect(typeof row.name).toBe("string");
          expect(row.name.length).toBeGreaterThan(0);
        }
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Group B — Active-only filter: retired row excluded
// ---------------------------------------------------------------------------

describe("T360 — GlobalCatalogService.list: active-only filter", () => {
  it("does NOT include the retired global product in the list", async () => {
    if (maybeSkip()) return;
    const service = new GlobalCatalogService(env!.admin);
    await runWithTenantContext(
      env!.admin,
      { tenantId: CATALOG_FIXTURE_IDS.tenantA, isPlatformAdmin: false },
      async () => {
        const rows = await service.list();
        const ids = rows.map((r) => r.id);
        expect(ids).not.toContain(RETIRED_GLOBAL_PRODUCT);
      },
    );
  });

  it("no returned row has a non-null retired_at", async () => {
    if (maybeSkip()) return;
    const service = new GlobalCatalogService(env!.admin);
    await runWithTenantContext(
      env!.admin,
      { tenantId: CATALOG_FIXTURE_IDS.tenantA, isPlatformAdmin: false },
      async () => {
        const rows = await service.list();
        for (const row of rows) {
          // retired_at must be null for every returned record
          expect(row.retired_at).toBeNull();
        }
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Group C — Cross-tenant consistency: same global rows from Tenant B
// ---------------------------------------------------------------------------

describe("T360 — GlobalCatalogService.list: cross-tenant consistency (global = platform-wide)", () => {
  it("Tenant B context sees the same harness GLOBAL_PRODUCT", async () => {
    if (maybeSkip()) return;
    const service = new GlobalCatalogService(env!.admin);
    await runWithTenantContext(
      env!.admin,
      { tenantId: CATALOG_FIXTURE_IDS.tenantB, isPlatformAdmin: false },
      async () => {
        const rows = await service.list();
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(GLOBAL_PRODUCT);
      },
    );
  });

  it("Tenant A and Tenant B see the identical id set", async () => {
    if (maybeSkip()) return;
    const service = new GlobalCatalogService(env!.admin);

    let idsFromA: string[] = [];
    let idsFromB: string[] = [];

    await runWithTenantContext(
      env!.admin,
      { tenantId: CATALOG_FIXTURE_IDS.tenantA, isPlatformAdmin: false },
      async () => {
        const rows = await service.list();
        idsFromA = rows.map((r) => r.id).sort();
      },
    );

    await runWithTenantContext(
      env!.admin,
      { tenantId: CATALOG_FIXTURE_IDS.tenantB, isPlatformAdmin: false },
      async () => {
        const rows = await service.list();
        idsFromB = rows.map((r) => r.id).sort();
      },
    );

    expect(idsFromA).toEqual(idsFromB);
  });

  it("Neither tenant context returns the retired global product", async () => {
    if (maybeSkip()) return;
    const service = new GlobalCatalogService(env!.admin);

    for (const tenantId of [
      CATALOG_FIXTURE_IDS.tenantA,
      CATALOG_FIXTURE_IDS.tenantB,
    ]) {
      await runWithTenantContext(
        env!.admin,
        { tenantId, isPlatformAdmin: false },
        async () => {
          const rows = await service.list();
          const ids = rows.map((r) => r.id);
          expect(ids).not.toContain(RETIRED_GLOBAL_PRODUCT);
        },
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Group D — Service is the list path, not raw SQL
// ---------------------------------------------------------------------------

describe("T360 — GlobalCatalogService.list: service is the sanctioned read path", () => {
  it("GlobalCatalogService class is importable and has a list method", () => {
    // This test passes only once T361 creates the module. Until then,
    // the import at the top of this file fails the entire suite, keeping
    // every test in this file RED for the right reason.
    expect(typeof GlobalCatalogService).toBe("function");
    const proto = GlobalCatalogService.prototype as unknown as Record<string, unknown>;
    expect(typeof proto["list"]).toBe("function");
  });
});
