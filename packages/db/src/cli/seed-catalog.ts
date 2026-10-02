#!/usr/bin/env node
/**
 * Backend-Core P-0 preprod GOLDEN CATALOG seed.
 *
 * Seeds the pilot retail catalog (the read prerequisite for the POS-010
 * read-down smoke) into the tenant/store created by `bootstrap-pilot.ts`.
 * Runs AFTER the bootstrap (it requires the pilot tenant + store + a seed
 * actor user to already exist).
 *
 * WHAT THIS SEEDS (per the 6 ratified Golden-Catalog decisions, 2026-06-10):
 *   - tenant_product_categories — one row per distinct `category` (flat; the
 *     table has no parent_id). Decision 1.
 *   - tenant_products           — one row per pilot product:
 *       name, optional description, category_id (the flat category),
 *       default_price (DECIMAL STRING, numeric(19,4)) + default_currency_code
 *       (paired; EGP), tax_category = 'standard' (decision 4), is_active=true.
 *       created_by/updated_by = the seed actor user. NO stock (decision 2).
 *       NO Rx flag — RX is encoded in category/name only (decision 5).
 *   - product_aliases           — per product: each `sku` value as
 *       identifier_type='sku' (source_system NULL), and each 12/13/14-digit
 *       value as identifier_type='barcode' (source_system NULL). Decision /
 *       transform rules: 10-digit Materials are internal SKUs, NOT barcodes.
 *
 * SELLABILITY (read-down R5): a product is only returned by the snapshot if it
 * is active AND not retired AND has BOTH price and currency present. This seed
 * therefore sets default_price + default_currency_code on every product; a row
 * with no price will be silently excluded from the smoke's catalogue.
 *
 * INPUT — the pilot product data is NOT committed (the source Excel
 * `index_demo.xlsx` must never enter the repo). The curated pilot rows are read
 * at runtime from a JSON file named by `PILOT_CATALOG_FILE`. Shape:
 *   {
 *     "products": [
 *       {
 *         "name": "Paracetamol 500mg",        // required, 1..500 chars (cleaned of marker glyphs)
 *         "category": "OTC Analgesics",       // required, 1..200 chars (flat)
 *         "price": "12.50",                    // required, DecimalAmount string numeric(19,4)
 *         "currencyCode": "EGP",               // optional, defaults to PILOT_CURRENCY (EGP)
 *         "description": "...",                // optional
 *         "skus": ["1234567890"],              // optional; each -> product_aliases sku
 *         "barcodes": ["6223000000001"]        // optional; each MUST be 12/13/14 digits -> barcode
 *       }
 *     ]
 *   }
 *
 * RLS: all inserts run in ONE transaction under
 * `set_config('app.current_tenant', <pilot tenant>, true)` (mirrors
 * `runWithTenantContext`; is_platform_admin stays false — tenant-scoped writes).
 *
 * Idempotent: categories upsert on (tenant_id, name); products are skipped if a
 * same-(tenant, name) active row already exists; aliases skipped if a
 * same-(tenant, product, identifier_type, value) active row exists. Re-running
 * with the same file is a no-op.
 *
 * Reads `DATABASE_URL` (same as migrate.ts / bootstrap-pilot.ts).
 *
 * Usage:
 *   PILOT_TENANT_ID=... PILOT_SEED_ACTOR_USER_ID=... \
 *   PILOT_CATALOG_FILE=/path/to/pilot-catalog.json \
 *   PILOT_CURRENCY=EGP \
 *   node dist/cli/seed-catalog.js
 *
 *   (PILOT_TENANT_ID + PILOT_SEED_ACTOR_USER_ID come from bootstrap-pilot's
 *    printed `tenant_id` / `operator_user_id`.)
 *
 * Exit codes: 0 success · 1 SQL/runtime error · 2 DATABASE_URL missing ·
 *             4 required PILOT_* env missing · 5 catalog file missing/invalid.
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const TAX_CATEGORY = 'standard'; // decision 4 — uniform for the pilot.
const DEFAULT_CURRENCY = 'EGP';
const BARCODE_LENGTHS = new Set([12, 13, 14]); // transform rule — else internal SKU.

interface PilotProduct {
  name: string;
  category: string;
  price: string;
  currencyCode?: string;
  description?: string;
  skus?: string[];
  barcodes?: string[];
}

interface SeedConfig {
  tenantId: string;
  seedActorUserId: string;
  catalogFile: string;
  currency: string;
}

interface SeedSummary {
  categories_inserted: number;
  products_inserted: number;
  products_skipped: number;
  aliases_inserted: number;
}

const DECIMAL_AMOUNT = /^-?[0-9]{1,15}(\.[0-9]{1,4})?$/;

function fail(code: number, message: string): never {
  console.error(`seed-catalog: ${message}`);
  process.exit(code);
}

function readEnvConfig(): SeedConfig {
  const tenantId = process.env['PILOT_TENANT_ID'];
  const seedActorUserId = process.env['PILOT_SEED_ACTOR_USER_ID'];
  const catalogFile = process.env['PILOT_CATALOG_FILE'];
  if (!tenantId || !seedActorUserId) {
    fail(
      4,
      'PILOT_TENANT_ID and PILOT_SEED_ACTOR_USER_ID are required ' +
        "(from bootstrap-pilot's printed tenant_id / operator_user_id).",
    );
  }
  if (!catalogFile) {
    fail(4, 'PILOT_CATALOG_FILE is required (path to the curated pilot-catalog JSON).');
  }
  return {
    tenantId,
    seedActorUserId,
    catalogFile,
    currency: process.env['PILOT_CURRENCY'] ?? DEFAULT_CURRENCY,
  };
}

/** Load + validate the curated pilot products. Never throws raw — exits 5 on bad input. */
function loadProducts(file: string): PilotProduct[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    fail(5, `cannot read PILOT_CATALOG_FILE: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(5, `PILOT_CATALOG_FILE is not valid JSON: ${file}`);
  }
  const products = (parsed as { products?: unknown }).products;
  if (!Array.isArray(products) || products.length === 0) {
    fail(5, 'catalog file must contain a non-empty `products` array.');
  }
  return products.map((p, i) => validateProduct(p, i));
}

function validateProduct(value: unknown, index: number): PilotProduct {
  if (typeof value !== 'object' || value === null) {
    fail(5, `products[${index}] is not an object.`);
  }
  const p = value as Record<string, unknown>;
  const name = p['name'];
  const category = p['category'];
  const price = p['price'];
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 500) {
    fail(5, `products[${index}].name must be a non-empty string <= 500 chars.`);
  }
  if (typeof category !== 'string' || category.trim().length === 0 || category.length > 200) {
    fail(5, `products[${index}].category must be a non-empty string <= 200 chars.`);
  }
  if (typeof price !== 'string' || !DECIMAL_AMOUNT.test(price)) {
    fail(
      5,
      `products[${index}].price must be a DecimalAmount string (numeric(19,4)); got ${String(price)}.`,
    );
  }
  const skus = asStringArray(p['skus'], index, 'skus');
  const barcodes = asStringArray(p['barcodes'], index, 'barcodes');
  for (const b of barcodes) {
    if (!BARCODE_LENGTHS.has(b.length) || !/^[0-9]+$/.test(b)) {
      fail(5, `products[${index}].barcodes entry "${b}" must be a 12/13/14-digit numeric string.`);
    }
  }
  const result: PilotProduct = {
    name: name.trim(),
    category: category.trim(),
    price,
    skus,
    barcodes,
  };
  if (typeof p['currencyCode'] === 'string') result.currencyCode = p['currencyCode'];
  if (typeof p['description'] === 'string') result.description = p['description'];
  return result;
}

function asStringArray(value: unknown, index: number, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    fail(5, `products[${index}].${field} must be an array of strings.`);
  }
  return value as string[];
}

/** Set tenant context for RLS (mirrors runWithTenantContext; tenant-scoped, not platform). */
async function setContext(client: Client, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
  await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
}

async function seed(
  client: Client,
  cfg: SeedConfig,
  products: PilotProduct[],
): Promise<SeedSummary> {
  await setContext(client, cfg.tenantId);
  const summary: SeedSummary = {
    categories_inserted: 0,
    products_inserted: 0,
    products_skipped: 0,
    aliases_inserted: 0,
  };

  // Resolve-or-create each distinct category (idempotent on (tenant_id, name)).
  const categoryIds = new Map<string, string>();
  const distinctCategories = [...new Set(products.map((p) => p.category))];
  for (const name of distinctCategories) {
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM tenant_product_categories WHERE tenant_id = $1 AND name = $2 AND retired_at IS NULL',
      [cfg.tenantId, name],
    );
    if (existing.rows[0]) {
      categoryIds.set(name, existing.rows[0].id);
      continue;
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO tenant_product_categories (tenant_id, name, created_by)
       VALUES ($1, $2, $3) RETURNING id`,
      [cfg.tenantId, name, cfg.seedActorUserId],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error(`category insert returned no id for "${name}"`);
    categoryIds.set(name, id);
    summary.categories_inserted += 1;
  }

  // Products + aliases.
  for (const p of products) {
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM tenant_products WHERE tenant_id = $1 AND name = $2 AND retired_at IS NULL',
      [cfg.tenantId, p.name],
    );
    let productId: string;
    if (existing.rows[0]) {
      productId = existing.rows[0].id;
      summary.products_skipped += 1;
    } else {
      const categoryId = categoryIds.get(p.category);
      const currency = p.currencyCode ?? cfg.currency;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO tenant_products
           (tenant_id, name, description, category_id, default_price,
            default_currency_code, is_active, tax_category, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $8) RETURNING id`,
        [
          cfg.tenantId,
          p.name,
          p.description ?? null,
          categoryId ?? null,
          p.price,
          currency,
          TAX_CATEGORY,
          cfg.seedActorUserId,
        ],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error(`product insert returned no id for "${p.name}"`);
      productId = id;
      summary.products_inserted += 1;
    }

    // Aliases: skus -> 'sku', barcodes -> 'barcode' (both source_system NULL).
    const aliasRows: Array<{ type: 'sku' | 'barcode'; value: string }> = [
      ...p.skus!.map((value) => ({ type: 'sku' as const, value })),
      ...p.barcodes!.map((value) => ({ type: 'barcode' as const, value })),
    ];
    for (const a of aliasRows) {
      const existingAlias = await client.query<{ id: string }>(
        `SELECT id FROM product_aliases
         WHERE tenant_id = $1 AND product_id = $2 AND identifier_type = $3
           AND value = $4 AND retired_at IS NULL`,
        [cfg.tenantId, productId, a.type, a.value],
      );
      if (existingAlias.rows[0]) continue;
      await client.query(
        `INSERT INTO product_aliases
           (tenant_id, product_id, identifier_type, value, source_system, created_by)
         VALUES ($1, $2, $3, $4, NULL, $5)`,
        [cfg.tenantId, productId, a.type, a.value, cfg.seedActorUserId],
      );
      summary.aliases_inserted += 1;
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    fail(2, 'DATABASE_URL is required');
  }
  const cfg = readEnvConfig();
  const products = loadProducts(cfg.catalogFile);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      const summary = await seed(client, cfg, products);
      await client.query('COMMIT');
      console.log(
        `seed-catalog: done (idempotent). tenant_id=${cfg.tenantId} ` +
          `input=${products.length} products`,
      );
      console.log(JSON.stringify(summary, null, 2));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`seed-catalog: ${message}`);
  process.exit(1);
});
