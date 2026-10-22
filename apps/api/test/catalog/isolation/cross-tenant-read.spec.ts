/**
 * T341 — Catalog cross-tenant read isolation.
 *
 * Purpose
 * -------
 * Proves that Tenant A's runtime context cannot read Tenant B's catalog
 * rows across all six tenant-scoped catalog tables. All assertions run
 * against the non-superuser `app_test` role via `runWithTenantContext`
 * so they hit the real RLS policies — no superuser false positives.
 *
 * HTTP layer decision
 * -------------------
 * No catalog HTTP controllers or services exist in `apps/api/src/` as of
 * the T341 slice. The catalog module is schema-only (Phase 2 of spec
 * 003-catalog-foundation). Assertions are therefore made at the direct
 * DB / RLS layer, which is the appropriate test surface for this phase
 * and mirrors the approach taken by T335 and the auth-token isolation
 * tests. When Phase 3 ships catalog services and controllers, those will
 * be covered by separate service-layer specs (T350, T360, T372 etc.).
 *
 * Tables covered
 * --------------
 * - tenant_products              (two rows per tenant: 1 active + 1 retired)
 * - tenant_product_categories    (one row per tenant)
 * - store_product_overrides      (two rows per tenant — asserted per store,
 *                                 one at a time, because the 0008 SELECT
 *                                 policy requires `app.current_store`)
 * - product_aliases              (two rows per tenant: barcode + store-scoped sku)
 * - price_history                (two rows per tenant: tenant-level + store-X)
 * - unknown_items                (two rows per tenant — asserted per store,
 *                                 same 0008 policy constraint as overrides)
 *
 * global_products is intentionally NOT covered here: it has no tenant_id
 * column and its SELECT policy is intentionally unrestricted for the
 * runtime role (the global catalog is visible to all tenants). T343
 * (rls-bypass-probe) is the appropriate suite for global_products policy
 * probing.
 *
 * Assertion groups
 * ----------------
 * (A) Tenant A context — sees own rows only (row count = expected per tenant)
 * (B) Tenant A context — cannot read specific Tenant B rows even when IDs known
 * (C) Symmetry — Tenant B context mirrors the same guarantees
 * (D) Fail-closed — runtime role without ANY tenant GUC sees zero rows
 */
import { Pool } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db/middleware/tenant-context";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
  APP_ROLE_NAME,
  APP_ROLE_PASSWORD,
} from "../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  CATALOG_FIXTURE_IDS,
  CATALOG_FIXTURE_COUNTS,
} from "../__support__/isolation-harness";

// --------------------------------------------------------------------------
// Suite-level state
// --------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;

// ---- Lifecycle -------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[cross-tenant-read.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// ---- Guard helper -------------------------------------------------------

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[cross-tenant-read.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

// ---- Tenant + store context helper --------------------------------------
//
// `store_product_overrides` and `unknown_items` carry the post-0011 RLS
// store-axis CASE guard (`0011_catalog_store_carveout_sentinel.sql`).
// The three-way guard distinguishes:
//   '*'    → TRUE  (tenant-owner cross-store carve-out)
//   ''     → FALSE (GUC never set → fail-closed)
//   <uuid> → store_id equality (store-scoped)
// Callers that want cross-store visibility must set
// `app.current_store = '*'` — the old `''` sentinel is no longer the
// carve-out signal and is now fail-closed.
//
// As a result, every read of those two tables under a runtime role
// must set `app.current_store` to a real store UUID. The native
// `runWithTenantContext` helper only sets `app.current_tenant`, so we
// wrap it here and prepend a `set_config('app.current_store', $1, true)`
// call.
//
// Production code paths (T350+ services) will route through a similar
// store-context helper once the services land; for now this lives only
// in tests against the schema.
async function runWithTenantStoreContext<T>(
  pool: import("pg").Pool,
  ctx: { tenantId: string; isPlatformAdmin: boolean; storeId: string },
  work: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  return runWithTenantContext(
    pool,
    { tenantId: ctx.tenantId, isPlatformAdmin: ctx.isPlatformAdmin },
    async (client) => {
      await client.query("SELECT set_config('app.current_store', $1, true)", [
        ctx.storeId,
      ]);
      return work(client);
    },
  );
}

// --------------------------------------------------------------------------
// Group A — Tenant A context sees own rows only
// --------------------------------------------------------------------------

describe("T341 — cross-tenant read isolation: Tenant A sees own rows only", () => {
  const ctx = { tenantId: CATALOG_FIXTURE_IDS.tenantA, isPlatformAdmin: false };

  it("tenant_products: Tenant A sees exactly 2 rows (own tenant only)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM tenant_products ORDER BY id`,
      );
      return r.rows;
    });
    // 2 per tenant (1 active + 1 retired) — only Tenant A's rows visible
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.tenant_products / 2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(CATALOG_FIXTURE_IDS.tenantA);
    }
  });

  it("tenant_product_categories: Tenant A sees exactly 1 row (own tenant only)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM tenant_product_categories ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.tenant_product_categories / 2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(CATALOG_FIXTURE_IDS.tenantA);
    }
  });

  it("store_product_overrides: Tenant A sees exactly 2 rows (own tenant only)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      // '*' = tenant-owner all-stores carve-out (rls-test-matrix.md §4.3). Safe
      // after 0009: the CASE guard handles the '*' sentinel without a uuid cast error.
      await client.query(`SELECT set_config('app.current_store', '*', true)`);
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM store_product_overrides ORDER BY id`,
      );
      return r.rows;
    });
    // 2 per tenant (one per store)
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.store_product_overrides / 2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(CATALOG_FIXTURE_IDS.tenantA);
    }
  });

  it("product_aliases: Tenant A sees exactly 2 rows (own tenant only)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM product_aliases ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.product_aliases / 2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(CATALOG_FIXTURE_IDS.tenantA);
    }
  });

  it("price_history: Tenant A sees exactly 2 rows (own tenant only)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM price_history ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.price_history / 2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(CATALOG_FIXTURE_IDS.tenantA);
    }
  });

  it("unknown_items: Tenant A sees exactly 2 rows (own tenant only)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      // '*' = tenant-owner all-stores carve-out (rls-test-matrix.md §4.3). Safe
      // after 0009: the CASE guard handles the '*' sentinel without a uuid cast error.
      await client.query(`SELECT set_config('app.current_store', '*', true)`);
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM unknown_items ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.unknown_items / 2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(CATALOG_FIXTURE_IDS.tenantA);
    }
  });
});

// --------------------------------------------------------------------------
// Group B — Tenant A context cannot read specific Tenant B rows by known ID
// --------------------------------------------------------------------------

describe("T341 — cross-tenant read isolation: Tenant A cannot read Tenant B rows by known ID", () => {
  const ctx = { tenantId: CATALOG_FIXTURE_IDS.tenantA, isPlatformAdmin: false };

  it("tenant_products: direct-by-id lookup of Tenant B's active product returns empty", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM tenant_products WHERE id = $1`,
        [CATALOG_FIXTURE_IDS.productBActive],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("tenant_products: direct-by-id lookup of Tenant B's retired product returns empty", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM tenant_products WHERE id = $1`,
        [CATALOG_FIXTURE_IDS.productBRetired],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("tenant_product_categories: direct-by-id lookup of Tenant B's category returns empty", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM tenant_product_categories WHERE id = $1`,
        [CATALOG_FIXTURE_IDS.categoryB],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("store_product_overrides: direct-by-id lookup of Tenant B's Store-X override returns empty", async () => {
    if (maybeSkip()) return;
    // The 0008 policy demands `app.current_store` even for negative
    // assertions — set Tenant A's own store so the cast does not raise.
    const rows = await runWithTenantStoreContext(
      env!.app,
      { ...ctx, storeId: CATALOG_FIXTURE_IDS.storeAX },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.overrideBX],
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("store_product_overrides: direct-by-id lookup of Tenant B's Store-Y override returns empty", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      { ...ctx, storeId: CATALOG_FIXTURE_IDS.storeAX },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.overrideBY],
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("product_aliases: direct-by-id lookup of Tenant B's barcode alias returns empty", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM product_aliases WHERE id = $1`,
        [CATALOG_FIXTURE_IDS.aliasBBarcode],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("product_aliases: direct-by-id lookup of Tenant B's POS alias returns empty", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM product_aliases WHERE id = $1`,
        [CATALOG_FIXTURE_IDS.aliasBXPos],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("price_history: direct-by-id lookup of Tenant B's tenant-level row returns empty", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM price_history WHERE id = $1`,
        [CATALOG_FIXTURE_IDS.priceHistBTenant],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("price_history: direct-by-id lookup of Tenant B's store-X row returns empty", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM price_history WHERE id = $1`,
        [CATALOG_FIXTURE_IDS.priceHistBStoreX],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("unknown_items: direct-by-id lookup of Tenant B's Store-X item returns empty", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      { ...ctx, storeId: CATALOG_FIXTURE_IDS.storeAX },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM unknown_items WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.unknownBX],
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("unknown_items: direct-by-id lookup of Tenant B's Store-Y item returns empty", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      { ...ctx, storeId: CATALOG_FIXTURE_IDS.storeAX },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM unknown_items WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.unknownBY],
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Group C — Tenant B symmetry
// --------------------------------------------------------------------------

describe("T341 — cross-tenant read isolation: Tenant B symmetry", () => {
  const ctx = { tenantId: CATALOG_FIXTURE_IDS.tenantB, isPlatformAdmin: false };

  it("tenant_products: Tenant B context sees exactly 2 own rows", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM tenant_products ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.tenant_products / 2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(CATALOG_FIXTURE_IDS.tenantB);
    }
  });

  it("tenant_product_categories: Tenant B context sees exactly 1 own row", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM tenant_product_categories ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.tenant_product_categories / 2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(CATALOG_FIXTURE_IDS.tenantB);
    }
  });

  it("store_product_overrides: Tenant B context sees exactly 2 own rows", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      // '*' = tenant-owner all-stores carve-out (rls-test-matrix.md §4.3). Safe
      // after 0009: the CASE guard handles the '*' sentinel without a uuid cast error.
      await client.query(`SELECT set_config('app.current_store', '*', true)`);
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM store_product_overrides ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.store_product_overrides / 2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(CATALOG_FIXTURE_IDS.tenantB);
    }
  });

  it("price_history: Tenant B context sees exactly 2 own rows", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM price_history ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.price_history / 2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(CATALOG_FIXTURE_IDS.tenantB);
    }
  });

  it("product_aliases: Tenant B context sees only its own rows", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM product_aliases ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.product_aliases / 2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(CATALOG_FIXTURE_IDS.tenantB);
    }
  });

  it("unknown_items: Tenant B context sees only its own rows", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      // '*' = tenant-owner all-stores carve-out (rls-test-matrix.md §4.3). Safe
      // after 0009: the CASE guard handles the '*' sentinel without a uuid cast error.
      await client.query(`SELECT set_config('app.current_store', '*', true)`);
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM unknown_items ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.unknown_items / 2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(CATALOG_FIXTURE_IDS.tenantB);
    }
  });

  it("unknown_items: Tenant B context cannot see Tenant A's Store-X item by known ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      { ...ctx, storeId: CATALOG_FIXTURE_IDS.storeBX },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM unknown_items WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.unknownAX],
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("tenant_products: Tenant B context cannot see Tenant A's active product by known ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM tenant_products WHERE id = $1`,
        [CATALOG_FIXTURE_IDS.productAActive],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Group D — Fail-closed: runtime role without ANY tenant GUC sees zero rows
// --------------------------------------------------------------------------

describe("T341 — cross-tenant read isolation: runtime role without GUC is fail-closed", () => {
  /**
   * A fresh Pool connected as the runtime role but WITHOUT calling
   * runWithTenantContext means no tenant GUC is set. RLS policies that rely
   * on `current_setting('app.current_tenant', true)::uuid` will produce a
   * NULL tenant ID (the `true` suppresses the GUC-missing error, yielding '').
   * An empty string cast to uuid is invalid and falls through to the
   * `is_platform_admin` branch, which is 'false' — so RLS hides all rows.
   * This group proves that misconfigured contexts (no GUC at all) do NOT
   * accidentally expose any seeded catalog rows.
   */
  let noGucPool: Pool | null = null;

  beforeAll(async () => {
    if (dockerSkipped || !env) return;
    noGucPool = new Pool({ connectionString: env.uriFor(APP_ROLE_NAME, APP_ROLE_PASSWORD) });
  });

  afterAll(async () => {
    await noGucPool?.end().catch(() => undefined);
  });

  it("tenant_products: runtime role without GUC sees 0 rows", async () => {
    if (maybeSkip() || !noGucPool) return;
    const r = await noGucPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tenant_products`,
    );
    expect(r.rows[0]?.count).toBe("0");
  });

  it("tenant_product_categories: runtime role without GUC sees 0 rows", async () => {
    if (maybeSkip() || !noGucPool) return;
    const r = await noGucPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tenant_product_categories`,
    );
    expect(r.rows[0]?.count).toBe("0");
  });

  it("store_product_overrides: runtime role without GUC is fail-closed (zero rows or RLS error)", async () => {
    if (maybeSkip() || !noGucPool) return;
    // Post-0008 the SELECT policy ANDs `app.current_tenant` with a
    // store check that performs `''::uuid` on the empty default,
    // which raises `invalid input syntax for type uuid: ""`. Either
    // outcome (no rows OR error) proves no data was visible — that
    // is what fail-closed means in this context.
    try {
      const r = await noGucPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM store_product_overrides`,
      );
      expect(r.rows[0]?.count).toBe("0");
    } catch (err) {
      expect(String(err)).toMatch(/invalid input syntax for type uuid/);
    }
  });

  it("product_aliases: runtime role without GUC sees 0 rows", async () => {
    if (maybeSkip() || !noGucPool) return;
    const r = await noGucPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM product_aliases`,
    );
    expect(r.rows[0]?.count).toBe("0");
  });

  it("price_history: runtime role without GUC sees 0 rows", async () => {
    if (maybeSkip() || !noGucPool) return;
    const r = await noGucPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM price_history`,
    );
    expect(r.rows[0]?.count).toBe("0");
  });

  it("unknown_items: runtime role without GUC is fail-closed (zero rows or RLS error)", async () => {
    if (maybeSkip() || !noGucPool) return;
    // Same 0008 caveat as store_product_overrides above — see comment.
    try {
      const r = await noGucPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM unknown_items`,
      );
      expect(r.rows[0]?.count).toBe("0");
    } catch (err) {
      expect(String(err)).toMatch(/invalid input syntax for type uuid/);
    }
  });
});
