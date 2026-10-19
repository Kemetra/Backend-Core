/**
 * RT-730 (CAT-R2) — explicit wire projections of the console catalog read
 * (`catalog/console-catalog.yaml`, RT-729). Rows are never returned as-is
 * (§IV): no `created_by` / `updated_by`, no ERP mapping. Money is the stored
 * exact decimal string ({@link storedAmount}); timestamps are RFC 3339 UTC.
 */
import { storedAmount, type ResolvedStoreColumns } from "../store-resolution/store-product-resolution";

export type ProductStatus = "active" | "inactive" | "retired";
export type TrackingMode = "none" | "batch" | "serial";

export interface Money {
  readonly amount: string;
  readonly currencyCode: string;
}

export interface StoreView {
  readonly storeId: string;
  readonly effectivePrice: Money | null;
  readonly effectiveActive: boolean;
  readonly effectiveTaxCategory: string;
  readonly hasOverride: boolean;
}

export interface ConsoleCatalogProductSummary {
  readonly productId: string;
  readonly name: string;
  readonly status: ProductStatus;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly primarySku: string | null;
  readonly primaryBarcode: string | null;
  readonly defaultPrice: Money | null;
  readonly taxCategory: string;
  readonly trackingMode: TrackingMode;
  readonly updatedAt: string;
  readonly storeView?: StoreView;
}

export interface ConsoleCatalogProductPage {
  readonly items: ConsoleCatalogProductSummary[];
  readonly nextCursor: string | null;
}

export interface ProductIdentifier {
  readonly identifierType: string;
  readonly value: string;
  readonly storeId: string | null;
  readonly sourceSystem: string | null;
  readonly createdAt: string;
}

export interface StoreOverride {
  readonly storeId: string;
  readonly price: Money | null;
  readonly isActive: boolean | null;
  readonly taxCategory: string | null;
  readonly updatedAt: string;
}

export interface ConsoleCatalogProductDetail {
  readonly summary: ConsoleCatalogProductSummary;
  readonly description: string | null;
  readonly expiryRequired: boolean;
  readonly sourceGlobalProductId: string | null;
  readonly createdAt: string;
  readonly identifiers: ProductIdentifier[];
  readonly storeOverrides: StoreOverride[];
}

export interface ConsoleCatalogCategory {
  readonly categoryId: string;
  readonly name: string;
  readonly description: string | null;
  readonly updatedAt: string;
}

/** A product row of the summary SELECT (`PRODUCT_SUMMARY_COLUMNS_SQL`). */
export interface ProductSummaryRow {
  readonly product_id: string;
  readonly name: string;
  readonly is_active: boolean;
  readonly retired_at: Date | null;
  readonly category_id: string | null;
  readonly category_name: string | null;
  readonly primary_sku: string | null;
  readonly primary_barcode: string | null;
  readonly default_price: string | null;
  readonly default_currency_code: string | null;
  readonly tax_category: string;
  readonly tracking_mode: TrackingMode;
  readonly updated_at: Date;
}

export interface ProductDetailRow extends ProductSummaryRow {
  readonly description: string | null;
  readonly expiry_required: boolean;
  readonly source_global_product_id: string | null;
  readonly created_at: Date;
}

export interface IdentifierRow {
  readonly identifier_type: string;
  readonly value: string;
  readonly store_id: string | null;
  readonly source_system: string | null;
  readonly created_at: Date;
}

export interface OverrideRow {
  readonly store_id: string;
  readonly price: string | null;
  readonly currency_code: string | null;
  readonly is_active: boolean | null;
  readonly tax_category: string | null;
  readonly updated_at: Date;
}

export interface CategoryRow {
  readonly category_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly updated_at: Date;
}

function money(amount: string | null, currencyCode: string | null): Money | null {
  if (amount === null || currencyCode === null) return null;
  return { amount: storedAmount(amount, currencyCode), currencyCode };
}

function statusOf(row: { is_active: boolean; retired_at: Date | null }): ProductStatus {
  if (row.retired_at !== null) return "retired";
  return row.is_active ? "active" : "inactive";
}

export function toSummary(row: ProductSummaryRow): ConsoleCatalogProductSummary {
  return {
    productId: row.product_id,
    name: row.name,
    status: statusOf(row),
    categoryId: row.category_id,
    categoryName: row.category_name,
    primarySku: row.primary_sku,
    primaryBarcode: row.primary_barcode,
    defaultPrice: money(row.default_price, row.default_currency_code),
    taxCategory: row.tax_category,
    trackingMode: row.tracking_mode,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The store's view of a product, from the shared resolver's columns. A retired product is never active. */
export function toStoreView(storeId: string, row: ResolvedStoreColumns & { retired_at: Date | null }): StoreView {
  return {
    storeId,
    effectivePrice: money(row.resolved_price, row.resolved_currency),
    effectiveActive: row.resolved_active && row.retired_at === null,
    effectiveTaxCategory: row.resolved_tax_category,
    hasOverride: row.has_override,
  };
}

export function toDetail(
  row: ProductDetailRow,
  identifiers: readonly IdentifierRow[],
  overrides: readonly OverrideRow[],
): ConsoleCatalogProductDetail {
  return {
    summary: toSummary(row),
    description: row.description,
    expiryRequired: row.expiry_required,
    sourceGlobalProductId: row.source_global_product_id,
    createdAt: row.created_at.toISOString(),
    identifiers: identifiers.map((i) => ({
      identifierType: i.identifier_type,
      value: i.value,
      storeId: i.store_id,
      sourceSystem: i.source_system,
      createdAt: i.created_at.toISOString(),
    })),
    storeOverrides: overrides.map((o) => ({
      storeId: o.store_id,
      price: money(o.price, o.currency_code),
      isActive: o.is_active,
      taxCategory: o.tax_category,
      updatedAt: o.updated_at.toISOString(),
    })),
  };
}

export function toCategory(row: CategoryRow): ConsoleCatalogCategory {
  return {
    categoryId: row.category_id,
    name: row.name,
    description: row.description,
    updatedAt: row.updated_at.toISOString(),
  };
}
