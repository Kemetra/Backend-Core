/**
 * T316 — Catalog schema barrel export test.
 *
 * Asserts that `packages/db/src/schema/index.ts` re-exports every catalog
 * Drizzle table that data-model.md §1–§8 defines:
 *
 *   - global_products            (export: globalProducts)
 *   - tenant_products            (export: tenantProducts)
 *   - tenant_product_categories  (export: tenantProductCategories)
 *   - store_product_overrides    (export: storeProductOverrides)
 *   - product_aliases            (export: productAliases)
 *   - price_history              (export: priceHistory)
 *   - unknown_items              (export: unknownItems)
 *
 * Per tasks.md T331 the barrel must re-export the catalog set. This test is
 * the TDD RED gate for both T320 (the schema files themselves) and T331 (the
 * barrel re-export). It will fail RED today because none of those files
 * exist yet — that is the expected outcome of authoring the spec before the
 * implementation.
 *
 * The test uses `getTableName` from `drizzle-orm` (a stable runtime helper
 * that returns a Drizzle pgTable's underlying SQL name) to confirm that each
 * exported symbol is in fact a Drizzle pgTable instance bound to the correct
 * snake_case table name from data-model.md, not just any value.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getTableName } from "drizzle-orm";

import * as schema from "../../../src/schema";

// ---------------------------------------------------------------------------
// Expected (export-name -> SQL table name) pairs from data-model.md
// ---------------------------------------------------------------------------

const CATALOG_TABLE_EXPORTS: ReadonlyArray<readonly [string, string]> = [
  ["globalProducts", "global_products"],
  ["tenantProducts", "tenant_products"],
  ["tenantProductCategories", "tenant_product_categories"],
  ["storeProductOverrides", "store_product_overrides"],
  ["productAliases", "product_aliases"],
  ["priceHistory", "price_history"],
  ["unknownItems", "unknown_items"],
] as const;

// The catalog modules sanctioned for re-export from
// `packages/db/src/schema/index.ts`. The original seven are data-model.md §1–§8
// (003); `catalog-change-log` is the 010 read-down change-log (spec 010
// data-model §3); `erpnext-item-map` is the 013 product-master identity mapping
// (spec 013 data-model §2); `erpnext-posting-resolution` is the RT-330 frozen
// posting resolution (migration 0037). Any extra `./catalog/<module>` line in the barrel
// signals an unsanctioned table leaking through the public API.
const EXPECTED_CATALOG_MODULES: readonly string[] = [
  "global-products",
  "tenant-products",
  "tenant-product-categories",
  "store-product-overrides",
  "product-aliases",
  "price-history",
  "unknown-items",
  "catalog-change-log",
  "erpnext-item-map",
  "erpnext-warehouse-map",
  "erpnext-posting-status",
  "erpnext-posting-resolution",
  "erpnext-reconciliation",
  "erpnext-product-reconciliation",
];

const SCHEMA_BARREL_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "src",
  "schema",
  "index.ts",
);

/**
 * Parse the schema barrel and return the catalog module slugs it re-exports.
 *
 * Matches lines of the form (with optional whitespace):
 *   export * from "./catalog/<module>";
 *   export * from './catalog/<module>';
 * Returns just the `<module>` token, sorted, so the assertion is order-agnostic.
 */
function readCatalogReExports(): string[] {
  const source = readFileSync(SCHEMA_BARREL_PATH, "utf8");
  const pattern = /export\s+\*\s+from\s+["']\.\/catalog\/([\w-]+)["']\s*;?/g;
  const modules: string[] = [];
  for (const match of source.matchAll(pattern)) {
    modules.push(match[1]!);
  }
  return modules.sort();
}

describe("packages/db/src/schema/index.ts — catalog barrel (T316/T331)", () => {
  it.each(CATALOG_TABLE_EXPORTS)(
    "re-exports %s as the Drizzle pgTable for %s",
    (exportName, expectedTableName) => {
      const exported = (schema as Record<string, unknown>)[exportName];

      expect(exported).toBeDefined();
      // Drizzle's getTableName works only on a real pgTable instance; if the
      // value is something else (a string, a placeholder), it throws.
      // That doubly guards "it's actually a table" and "its SQL name matches".
      expect(getTableName(exported as Parameters<typeof getTableName>[0])).toBe(
        expectedTableName,
      );
    },
  );

  it("re-exports exactly the seven catalog tables (no missing, no extras vs. data-model.md §1–§8)", () => {
    for (const [exportName, expectedTableName] of CATALOG_TABLE_EXPORTS) {
      const exported = (schema as Record<string, unknown>)[exportName];
      expect(exported).toBeDefined();
      expect(getTableName(exported as Parameters<typeof getTableName>[0])).toBe(
        expectedTableName,
      );
    }
  });

  it("source barrel `./catalog/*` re-exports exactly the seven sanctioned modules — no extras, no missing", () => {
    // The runtime re-export check above only fails if a sanctioned export is
    // missing. It cannot detect an EXTRA catalog re-export (e.g. someone adds
    // `export * from "./catalog/draft_table";` for a feature not yet in
    // data-model.md). Parsing the barrel source closes that gap: we assert
    // the set of `./catalog/<module>` import paths equals the sanctioned set.
    const actual = readCatalogReExports();
    const expected = [...EXPECTED_CATALOG_MODULES].sort();
    expect(actual).toEqual(expected);
  });
});
