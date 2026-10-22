/**
 * apps/api/test/catalog/erpnext-posting/schema/erpnext-posting-status-schema-shape.spec.ts
 *
 * Slice 015-SCHEMA (T012a) — Drizzle schema-shape test for erpnext_posting_status.
 *
 * The lightweight, Docker-FREE companion to the Testcontainers migration
 * round-trip in
 * `packages/db/__tests__/migration/0019-erpnext-posting-status.spec.ts`. It
 * introspects the Drizzle table object exported from `@data-pulse-2/db/schema`
 * and asserts the 015 data-model.md §5 column inventory + the load-bearing
 * NEGATIVES (no money/amount column — this is a STATE-only table).
 *
 * RED-before-GREEN: authored before the schema exists, this file fails to even
 * import (`erpnextPostingStatus` not yet exported) — the intended T012a RED.
 * Once the schema + barrel re-export land, the import resolves and assertions
 * pass.
 *
 * Note: `@data-pulse-2/db/schema` resolves to the package's built `dist/`, so
 * the db package must be built before this spec sees the new export
 * (`pnpm --filter @data-pulse-2/db build`).
 */
import "reflect-metadata";

import { getTableConfig } from "drizzle-orm/pg-core";

import { erpnextPostingStatus } from "@data-pulse-2/db/schema";

type ColumnInfo = {
  name: string;
  notNull: boolean;
  dataType: string;
  columnType: string;
  hasDefault: boolean;
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
      hasDefault: boolean;
    };
    out.set(c.name, {
      name: c.name,
      notNull: c.notNull,
      dataType: c.dataType,
      columnType: c.columnType,
      hasDefault: c.hasDefault,
    });
  }
  return out;
}

function indexNames(table: unknown): string[] {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  return cfg.indexes.map(
    (ix) => (ix as { config?: { name?: string } }).config?.name ?? "",
  );
}

// ===========================================================================
// erpnext_posting_status — ERPNext posting lifecycle (data-model.md §5)
// ===========================================================================
describe("posting-status schema shape — erpnext_posting_status", () => {
  const cols = columns(erpnextPostingStatus);

  it("carries the data-model.md §5 column inventory", () => {
    for (const name of [
      "id",
      "tenant_id",
      "store_id",
      "sale_id",
      "kind",
      "source_ref_id",
      "source_system",
      "external_id",
      "payload_hash",
      "status",
      "document_ref",
      "rejection_category",
      "retry_count",
      "sequence",
      "created_at",
      "updated_at",
      "correlation_id",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
  });

  it("tenant_id + store_id + sale_id + source_ref_id are NOT NULL", () => {
    expect(cols.get("tenant_id")?.notNull).toBe(true);
    expect(cols.get("store_id")?.notNull).toBe(true);
    expect(cols.get("sale_id")?.notNull).toBe(true);
    expect(cols.get("source_ref_id")?.notNull).toBe(true);
  });

  it("kind is a NOT NULL text discriminator (sale_post | reversal)", () => {
    const c = cols.get("kind");
    expect(c?.notNull).toBe(true);
    expect(c?.columnType).toBe("PgText");
  });

  it("status is a NOT NULL text lifecycle field defaulting to 'pending'", () => {
    const c = cols.get("status");
    expect(c?.notNull).toBe(true);
    expect(c?.columnType).toBe("PgText");
    expect(c?.hasDefault).toBe(true);
  });

  it("document_ref is NULLABLE (set only on a posted ack — O-3 replay anchor)", () => {
    expect(cols.get("document_ref")?.notNull).toBe(false);
  });

  it("rejection_category is NULLABLE (set only on permanently_rejected)", () => {
    expect(cols.get("rejection_category")?.notNull).toBe(false);
  });

  it("RT-410 (0071): rejection_message is a NULLABLE text column (set only on permanently_rejected)", () => {
    const c = cols.get("rejection_message");
    expect([c?.notNull, c?.columnType]).toEqual([false, "PgText"]);
  });

  it("retry_count is a NOT NULL integer with a default", () => {
    const c = cols.get("retry_count");
    expect(c?.notNull).toBe(true);
    expect(c?.columnType).toBe("PgInteger");
    expect(c?.hasDefault).toBe(true);
  });

  it("payload_hash is a NOT NULL fixed-width char(64)", () => {
    const c = cols.get("payload_hash");
    expect(c?.notNull).toBe(true);
    expect(c?.columnType).toBe("PgChar");
  });

  it("sequence is the DB-assigned IDENTITY feed cursor (bigint, has default)", () => {
    const c = cols.get("sequence");
    // GENERATED ALWAYS AS IDENTITY → Drizzle reports it as defaulted/DB-assigned.
    expect(c?.hasDefault).toBe(true);
    expect(c?.dataType).toBe("bigint");
  });

  it("has the O-3 source-ref unique + the pending-feed + provenance indexes", () => {
    const ix = indexNames(erpnextPostingStatus);
    expect(ix).toContain("UQ_idx_erpnext_posting_status_source_ref");
    expect(ix).toContain("idx_erpnext_posting_status_pending");
    expect(ix).toContain("idx_erpnext_posting_status_provenance");
  });

  it("stores NO money / amount column (state-only table; amounts live on the 008 sale fact)", () => {
    // Load-bearing negatives: this table tracks posting STATE, not the sale.
    // Money is projected into the work-item at read time from sales/sale_lines.
    for (const forbidden of [
      "amount",
      "pos_total",
      "line_amount",
      "unit_price",
      "tax_amount",
      "total",
      "money",
      "currency_code",
    ]) {
      expect(cols.has(forbidden)).toBe(false);
    }
  });
});
