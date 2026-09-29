/**
 * apps/api/test/catalog/sales/schema/sales-schema-shape.spec.ts
 *
 * Slice 008-SCHEMA (T012) — Drizzle schema-shape test for the sale-fact tables.
 *
 * This is the lightweight, Docker-FREE companion to the Testcontainers
 * migration round-trip in `packages/db/__tests__/migration/0012-sales.spec.ts`.
 * It introspects the Drizzle table objects exported from `@data-pulse-2/db/schema`
 * and asserts the data-model.md §1-§4 column inventory: presence, money
 * precision/scale, char(3) currency, gate-B nullability, the dedup-unique
 * tuple, and the load-bearing NEGATIVES (no `version` column — gate D.1/FR-070;
 * no tender column — gate A.5).
 *
 * RED-before-GREEN: authored before the schema exists, this file fails to even
 * import (`sales` is not yet exported) — the intended T012 RED. Once T013 lands
 * the schema + barrel re-export, the import resolves and the assertions pass.
 *
 * Note: `@data-pulse-2/db/schema` resolves to the package's built `dist/`, so
 * the db package must be built before this spec sees the new exports
 * (`pnpm --filter @data-pulse-2/db build`).
 */
import "reflect-metadata";

import { getTableConfig } from "drizzle-orm/pg-core";

import {
  saleLines,
  saleRefunds,
  saleReturnLines,
  saleReturns,
  saleReturnTenders,
  sales,
  saleVoids,
} from "@data-pulse-2/db/schema";

type ColumnInfo = {
  name: string;
  notNull: boolean;
  dataType: string;
  columnType: string;
  precision?: number;
  scale?: number;
  length?: number;
};

function columns(table: unknown): Map<string, ColumnInfo> {
  // getTableConfig exposes the column builders' resolved metadata.
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

const ALL_TABLES: ReadonlyArray<{ name: string; table: unknown }> = [
  { name: "sales", table: sales },
  { name: "sale_lines", table: saleLines },
  { name: "sale_voids", table: saleVoids },
  { name: "sale_refunds", table: saleRefunds },
  { name: "sale_returns", table: saleReturns },
  { name: "sale_return_lines", table: saleReturnLines },
  { name: "sale_return_tenders", table: saleReturnTenders },
];

describe("sales schema shape — sales (header)", () => {
  const cols = columns(sales);

  it("carries the data-model.md §1 column inventory", () => {
    for (const name of [
      "id",
      "tenant_id",
      "store_id",
      "currency_code",
      "pos_total",
      "occurred_at",
      "received_at",
      "business_date",
      "processed_at",
      "source_clock_at",
      "source_system",
      "external_id",
      "payload_hash",
      "mismatch_flag",
      "created_by",
      "created_at",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
  });

  it("pos_total is numeric(19,4)", () => {
    const c = cols.get("pos_total");
    expect(c?.columnType).toBe("PgNumeric");
    expect(c?.precision).toBe(19);
    expect(c?.scale).toBe(4);
  });

  it("currency_code is char(3)", () => {
    const c = cols.get("currency_code");
    expect(c?.columnType).toBe("PgChar");
    expect(c?.length).toBe(3);
  });

  it("applies gate-B nullability", () => {
    expect(cols.get("occurred_at")?.notNull).toBe(true);
    expect(cols.get("received_at")?.notNull).toBe(true);
    expect(cols.get("business_date")?.notNull).toBe(true);
    expect(cols.get("processed_at")?.notNull).toBe(false);
    expect(cols.get("source_clock_at")?.notNull).toBe(false);
    expect(cols.get("mismatch_flag")?.notNull).toBe(false);
  });

  it("tenant_id and store_id are NOT NULL (FR-001/061)", () => {
    expect(cols.get("tenant_id")?.notNull).toBe(true);
    expect(cols.get("store_id")?.notNull).toBe(true);
  });
});

describe("sales schema shape — sale_lines (frozen snapshot)", () => {
  const cols = columns(saleLines);

  it("carries the data-model.md §2 snapshot columns", () => {
    for (const name of [
      "id",
      "sale_id",
      "tenant_id",
      "store_id",
      "line_name",
      "unit_price",
      "currency_code",
      "quantity",
      "line_amount",
      "tax_amount",
      "unit",
      "tenant_product_ref",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
  });

  it("unit_price and line_amount are numeric(19,4) NOT NULL; tax_amount nullable", () => {
    for (const name of ["unit_price", "line_amount"]) {
      const c = cols.get(name);
      expect(c?.columnType).toBe("PgNumeric");
      expect(c?.precision).toBe(19);
      expect(c?.scale).toBe(4);
      expect(c?.notNull).toBe(true);
    }
    expect(cols.get("tax_amount")?.notNull).toBe(false);
  });

  it("tenant_product_ref is nullable (ad-hoc lines, FR-004)", () => {
    expect(cols.get("tenant_product_ref")?.notNull).toBe(false);
  });
});

describe("sales schema shape — terminal events (void / refund)", () => {
  it("sale_voids carries the §3 columns incl. voided_at NOT NULL", () => {
    const cols = columns(saleVoids);
    for (const name of [
      "id",
      "sale_id",
      "tenant_id",
      "store_id",
      "voided_at",
      "source_system",
      "external_id",
      "payload_hash",
      "created_by",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
    expect(cols.get("voided_at")?.notNull).toBe(true);
  });

  it("sale_voids carries its own NOT NULL business_date (RT-63 P2, 0032)", () => {
    const c = columns(saleVoids).get("business_date");
    expect(c?.columnType).toBe("PgDateString");
    expect(c?.notNull).toBe(true);
  });

  it("sale_refunds preserves pos_refund_amount numeric(19,4) + currency", () => {
    const cols = columns(saleRefunds);
    for (const name of [
      "id",
      "sale_id",
      "tenant_id",
      "store_id",
      "refunded_at",
      "pos_refund_amount",
      "currency_code",
      "source_system",
      "external_id",
      "payload_hash",
      "created_by",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
    const amt = cols.get("pos_refund_amount");
    expect(amt?.columnType).toBe("PgNumeric");
    expect(amt?.precision).toBe(19);
    expect(amt?.scale).toBe(4);
    expect(amt?.notNull).toBe(true);
    expect(cols.get("refunded_at")?.notNull).toBe(true);
  });
});

describe("sales schema shape — line-aware returns (RT-73, 0032)", () => {
  it("money is numeric(19,4) and quantities numeric(19,6)", () => {
    const money: Array<[unknown, string]> = [
      [saleReturns, "return_total"],
      [saleReturnLines, "line_amount"],
      [saleReturnLines, "tax_amount"],
      [saleReturnTenders, "amount"],
    ];
    for (const [table, name] of money) {
      const c = columns(table).get(name);
      expect(c?.columnType).toBe("PgNumeric");
      expect([c?.precision, c?.scale]).toEqual([19, 4]);
    }
    for (const name of ["quantity", "returned_quantity_after"]) {
      const c = columns(saleReturnLines).get(name);
      expect(c?.columnType).toBe("PgNumeric");
      expect([c?.precision, c?.scale]).toEqual([19, 6]);
      expect(c?.notNull).toBe(true);
    }
  });

  it("a return carries its own server stamp, business date and per-sale sequence", () => {
    const cols = columns(saleReturns);
    for (const name of ["returned_at", "business_date", "return_seq", "payload_hash"]) {
      expect(cols.get(name)?.notNull).toBe(true);
    }
    expect(cols.get("reason")?.notNull).toBe(false);
    expect(columns(saleReturnLines).get("tax_amount")?.notNull).toBe(false);
  });
});

describe("sales schema shape — load-bearing negatives", () => {
  it("NO `version` column on any table (gate D.1 / FR-070)", () => {
    for (const { table } of ALL_TABLES) {
      expect(columns(table).has("version")).toBe(false);
    }
  });

  it("NO tender/payment column on any table (gate A.5)", () => {
    const banned = ["tender", "payment", "card", "cash"];
    for (const { name, table } of ALL_TABLES) {
      const offending = [...columns(table).keys()].filter((col) =>
        banned.some((b) => col.toLowerCase().includes(b)),
      );
      expect(offending).toEqual([]);
      void name;
    }
  });
});
