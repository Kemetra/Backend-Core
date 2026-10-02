/**
 * apps/api/test/inventory/schema/stock-movements-schema-shape.spec.ts
 *
 * Slice 009-SCHEMA (T012) — Drizzle schema-shape test for the inventory tables.
 *
 * The lightweight, Docker-FREE companion to the Testcontainers migration
 * round-trip in `packages/db/__tests__/migration/0014-inventory.spec.ts`. It
 * introspects the Drizzle table objects exported from `@data-pulse-2/db/schema`
 * and asserts the data-model.md §1 / §4 column inventory: presence, quantity
 * precision/scale, nullability, the SINGLE backfill dedup index, and the
 * load-bearing NEGATIVES — no `version` column (R7), no manual idempotency_key
 * unique index (R4/FR-030), no batch/expiry/serial column on the base movement
 * (FR-041), no money/payment column (§XIV).
 *
 * RED-before-GREEN: authored before the schema exists, this file fails to even
 * import (`stockMovements` not yet exported) — the intended T012 RED. Once T013
 * lands the schema + barrel re-export, the import resolves and the assertions
 * pass.
 *
 * Note: `@data-pulse-2/db/schema` resolves to the package's built `dist/`, so
 * the db package must be built before this spec sees the new exports
 * (`pnpm --filter @data-pulse-2/db build`).
 */
import "reflect-metadata";

import { getTableConfig } from "drizzle-orm/pg-core";

import { stockCounts, stockMovements } from "@data-pulse-2/db/schema";

type ColumnInfo = {
  name: string;
  notNull: boolean;
  dataType: string;
  columnType: string;
  precision?: number | undefined;
  scale?: number | undefined;
  length?: number | undefined;
};

function columns(table: unknown): Map<string, ColumnInfo> {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  const out = new Map<string, ColumnInfo>();
  for (const col of cfg.columns) {
    const c = col as unknown as {
      name: string;
      notNull: boolean;
      dataType: string;
      columnType: string;
      precision?: number;
      scale?: number;
      size?: number;
      length?: number;
    };
    out.set(c.name, {
      name: c.name,
      notNull: c.notNull,
      dataType: c.dataType,
      columnType: c.columnType,
      precision: c.precision,
      scale: c.scale,
      length: c.length ?? c.size,
    });
  }
  return out;
}

function indexPredicates(table: unknown): string[] {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  return cfg.indexes.map((ix) => (ix as { config?: { name?: string } }).config?.name ?? "");
}

// ===========================================================================
// stock_movements — the append-only ledger (data-model.md §1)
// ===========================================================================
describe("inventory schema shape — stock_movements", () => {
  const cols = columns(stockMovements);

  it("carries the data-model.md §1 column inventory", () => {
    for (const name of [
      "id",
      "tenant_id",
      "store_id",
      "movement_type",
      "quantity",
      "stocking_unit",
      "tenant_product_ref",
      "reason",
      "occurred_at",
      "received_at",
      "idempotency_key",
      "source_system",
      "external_id",
      "sale_id",
      "sale_line_id",
      "terminal_event_ref",
      "transfer_group_id",
      "stock_count_id",
      "created_by",
      "created_at",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
  });

  it("quantity is numeric(19,4) and NOT NULL (exact-decimal, no float — FR-022)", () => {
    const c = cols.get("quantity");
    expect(c?.columnType).toBe("PgNumeric");
    expect(c?.precision).toBe(19);
    expect(c?.scale).toBe(4);
    expect(c?.notNull).toBe(true);
  });

  it("applies the §X nullability contract", () => {
    // NOT NULL — scope, type, quantity, unit, timestamps, actor.
    expect(cols.get("tenant_id")?.notNull).toBe(true);
    expect(cols.get("store_id")?.notNull).toBe(true);
    expect(cols.get("movement_type")?.notNull).toBe(true);
    expect(cols.get("stocking_unit")?.notNull).toBe(true);
    expect(cols.get("occurred_at")?.notNull).toBe(true);
    expect(cols.get("received_at")?.notNull).toBe(true);
    expect(cols.get("created_by")?.notNull).toBe(true);
    // NULLABLE — ad-hoc product (R5), lineage-only key, provenance refs, linkage.
    expect(cols.get("tenant_product_ref")?.notNull).toBe(false);
    expect(cols.get("idempotency_key")?.notNull).toBe(false);
    expect(cols.get("source_system")?.notNull).toBe(false);
    expect(cols.get("external_id")?.notNull).toBe(false);
    expect(cols.get("sale_id")?.notNull).toBe(false);
    expect(cols.get("terminal_event_ref")?.notNull).toBe(false);
    expect(cols.get("transfer_group_id")?.notNull).toBe(false);
    expect(cols.get("stock_count_id")?.notNull).toBe(false);
  });

  it("has EXACTLY ONE movement-level dedup index = the backfill provenance unique (R4/FR-031)", () => {
    const names = indexPredicates(stockMovements);
    expect(names).toContain("uq_stock_movements_tenant_source_external");
    // NO manual (tenant_id, store_id, idempotency_key) unique index — manual
    // dedup lives in the 001/005 interceptor (FR-030, "no new primitive").
    const idempotencyIndexes = names.filter((n) => n.includes("idempotency_key"));
    expect(idempotencyIndexes).toEqual([]);
  });

  // ---- Load-bearing NEGATIVES ------------------------------------------------
  it("has NO `version` column (append-only fact, R7 — no optimistic concurrency)", () => {
    expect(cols.has("version")).toBe(false);
  });

  it("has NO batch/expiry/serial column on the base movement (pharmacy seam is a future FK, FR-041)", () => {
    for (const forbidden of [
      "batch",
      "batch_lot_number",
      "lot",
      "lot_number",
      "expiry",
      "expiry_date",
      "serial",
      "serial_number",
      "stock_lot_id",
      "stock_serial_id",
    ]) {
      expect(cols.has(forbidden)).toBe(false);
    }
  });

  it("has NO money/payment/currency column (§XIV business-class)", () => {
    for (const forbidden of [
      "currency_code",
      "amount",
      "price",
      "unit_price",
      "tender",
      "payment",
    ]) {
      expect(cols.has(forbidden)).toBe(false);
    }
  });
});

// ===========================================================================
// stock_counts — physical count (data-model.md §4)
// ===========================================================================
describe("inventory schema shape — stock_counts", () => {
  const cols = columns(stockCounts);

  it("carries the data-model.md §4 column inventory", () => {
    for (const name of [
      "id",
      "tenant_id",
      "store_id",
      "tenant_product_ref",
      "counted_quantity",
      "derived_on_hand_at_count",
      "stocking_unit",
      "counted_at",
      "created_by",
      "created_at",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
  });

  it("counted_quantity + derived_on_hand_at_count are numeric(19,4)", () => {
    for (const name of ["counted_quantity", "derived_on_hand_at_count"]) {
      const c = cols.get(name);
      expect(c?.columnType).toBe("PgNumeric");
      expect(c?.precision).toBe(19);
      expect(c?.scale).toBe(4);
    }
  });

  it("tenant_product_ref is nullable (ad-hoc product, R5); scope + count fields NOT NULL", () => {
    expect(cols.get("tenant_product_ref")?.notNull).toBe(false);
    expect(cols.get("tenant_id")?.notNull).toBe(true);
    expect(cols.get("store_id")?.notNull).toBe(true);
    expect(cols.get("counted_quantity")?.notNull).toBe(true);
    expect(cols.get("derived_on_hand_at_count")?.notNull).toBe(true);
  });
});
