/**
 * T323 — Drizzle schema shape test for `price_history`.
 *
 * RED-first authoring under TDD. The catalog schema files are gated under
 * T320 and do not yet exist on disk; importing them here is intentional
 * and must fail the suite with a module-resolution error until T320 lands.
 * Once T320 lands, the assertions below must pass exactly as written —
 * they encode the data-model.md §7 contract for `price_history`.
 *
 * Contract anchors (data-model.md §7):
 *   - Q1   monetary amount = numeric(19,4) NOT NULL
 *   - Q2   currency_code   = char(3) NOT NULL on every row that stores money
 *   - Q9   effective interval semantics + at-most-one-open-interval per
 *          (tenant_id, store_id, product_id) WHERE effective_to IS NULL
 *          + no `retired_at` (rows are immutable; not soft-deleted)
 *
 * RLS-driven UPDATE/DELETE immutability (`price_history_no_update_delete`)
 * is asserted by the future migration-level suite (T326+). This file
 * exercises only the Drizzle schema shape contributed by T320.
 */
import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";

import { priceHistory } from "../../../src/schema/catalog/price-history";

const dialect = new PgDialect();

function renderSQL(value: unknown): string {
  if (value == null) return "";
  return dialect.sqlToQuery(value as SQL).sql;
}

/**
 * `PgDialect` emits quoted identifiers (`"price_history"."store_id"`), which
 * breaks regex assertions that expect `\s+` between a column name and an
 * operator. Strip the quotes for matching — we are verifying the structural
 * predicate, not the rendering convention.
 */
function normalizeRenderedSql(sql: string): string {
  return sql.replaceAll('"', "");
}

describe("price_history Drizzle schema (T323)", () => {
  it("maps to the SQL table name 'price_history'", () => {
    expect(getTableName(priceHistory)).toBe("price_history");
  });

  // ---------------------------------------------------------------------------
  // Column presence + nullability
  // ---------------------------------------------------------------------------
  describe("columns", () => {
    it("declares the documented column set with no extras", () => {
      const cols = getTableColumns(priceHistory);
      // data-model.md §7 documents exactly these columns.
      expect(Object.keys(cols).sort()).toEqual(
        [
          "id",
          "tenantId",
          "productId",
          "storeId",
          "price",
          "currencyCode",
          "effectiveFrom",
          "effectiveTo",
          "changedBy",
          "correlationId",
          "createdAt",
        ].sort(),
      );
    });

    it("does NOT declare a `retired_at` / `retiredAt` column — Q9 (immutable, no soft-delete)", () => {
      const cols = getTableColumns(priceHistory);
      expect(Object.prototype.hasOwnProperty.call(cols, "retiredAt")).toBe(
        false,
      );
      expect(Object.prototype.hasOwnProperty.call(cols, "retired_at")).toBe(
        false,
      );
    });

    it("id is a NOT NULL uuid primary key", () => {
      const cols = getTableColumns(priceHistory);
      const id = cols["id"]!;
      expect(id.name).toBe("id");
      expect(id.notNull).toBe(true);
      expect(id.primary).toBe(true);
      expect(String(id.columnType).toLowerCase()).toContain("uuid");
    });

    it("tenant_id is uuid NOT NULL", () => {
      const cols = getTableColumns(priceHistory);
      const t = cols["tenantId"]!;
      expect(t.name).toBe("tenant_id");
      expect(t.notNull).toBe(true);
      expect(String(t.columnType).toLowerCase()).toContain("uuid");
    });

    it("product_id is uuid NOT NULL and references tenant_products", () => {
      const cols = getTableColumns(priceHistory);
      const p = cols["productId"]!;
      expect(p.name).toBe("product_id");
      expect(p.notNull).toBe(true);
      expect(String(p.columnType).toLowerCase()).toContain("uuid");
      // FK target: tenant_products.id — verified via the table config below.
    });

    it("store_id is uuid NULL — NULL = tenant-level history, set = store-level history (data-model §7)", () => {
      const cols = getTableColumns(priceHistory);
      const s = cols["storeId"]!;
      expect(s.name).toBe("store_id");
      // data-model.md §7 explicitly: `store_id ... NULL` allowed; NULL means
      // tenant-level price history, set means store-override-level history.
      expect(s.notNull).toBe(false);
      expect(String(s.columnType).toLowerCase()).toContain("uuid");
    });

    it("price is numeric(19,4) NOT NULL — Q1", () => {
      // Q1
      const cols = getTableColumns(priceHistory);
      const price = cols["price"]!;
      expect(price.name).toBe("price");
      expect(price.notNull).toBe(true);
      // drizzle pg-core surfaces numeric precision/scale via the column type.
      const colType = String(price.columnType).toLowerCase();
      expect(colType).toContain("numeric");
      // Precision 19, scale 4 — explicit per Q1 / data-model §1 "monetary amount".
      // We pin the constructor config to detect drift from numeric(19,4).
      const col = price as unknown as {
        precision?: number;
        scale?: number;
      };
      expect(col.precision).toBe(19); // Q1
      expect(col.scale).toBe(4); // Q1
    });

    it("currency_code is char(3) NOT NULL — Q2", () => {
      // Q2
      const cols = getTableColumns(priceHistory);
      const cc = cols["currencyCode"]!;
      expect(cc.name).toBe("currency_code");
      expect(cc.notNull).toBe(true); // Q2: every row storing money carries currency
      const colType = String(cc.columnType).toLowerCase();
      // Drizzle's PgChar surfaces as either "PgChar" or via getSQLType()
      // returning "char(3)". Assert both length and char-ness.
      expect(colType).toContain("char");
      const col = cc as unknown as { length?: number };
      expect(col).toHaveLength(3); // Q2: ISO 4217 fixed width
    });

    it("effective_from is timestamptz NOT NULL — Q9", () => {
      // Q9
      const cols = getTableColumns(priceHistory);
      const ef = cols["effectiveFrom"]!;
      expect(ef.name).toBe("effective_from");
      expect(ef.notNull).toBe(true); // Q9
      const colType = String(ef.columnType).toLowerCase();
      expect(colType).toContain("timestamp");
      const col = ef as unknown as { withTimezone?: boolean };
      expect(col.withTimezone).toBe(true);
    });

    it("effective_to is timestamptz NULL — NULL marks the current open interval — Q9", () => {
      // Q9
      const cols = getTableColumns(priceHistory);
      const et = cols["effectiveTo"]!;
      expect(et.name).toBe("effective_to");
      expect(et.notNull).toBe(false); // Q9: NULL = current open interval
      const colType = String(et.columnType).toLowerCase();
      expect(colType).toContain("timestamp");
      const col = et as unknown as { withTimezone?: boolean };
      expect(col.withTimezone).toBe(true);
    });

    it("changed_by is uuid NOT NULL (actor never body-supplied)", () => {
      const cols = getTableColumns(priceHistory);
      const cb = cols["changedBy"]!;
      expect(cb.name).toBe("changed_by");
      expect(cb.notNull).toBe(true);
      expect(String(cb.columnType).toLowerCase()).toContain("uuid");
    });

    it("correlation_id is uuid NOT NULL (links to the audit event that caused the change)", () => {
      const cols = getTableColumns(priceHistory);
      const ci = cols["correlationId"]!;
      expect(ci.name).toBe("correlation_id");
      // data-model.md §7 marks correlation_id NOT NULL on price_history
      // (unlike most other tables where it is NULL) because the row is
      // itself the audit event for the price change.
      expect(ci.notNull).toBe(true);
      expect(String(ci.columnType).toLowerCase()).toContain("uuid");
    });

    it("created_at is timestamptz NOT NULL with a default", () => {
      const cols = getTableColumns(priceHistory);
      const ca = cols["createdAt"]!;
      expect(ca.name).toBe("created_at");
      expect(ca.notNull).toBe(true);
      expect(ca.hasDefault).toBe(true);
      const colType = String(ca.columnType).toLowerCase();
      expect(colType).toContain("timestamp");
      const col = ca as unknown as { withTimezone?: boolean };
      expect(col.withTimezone).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Foreign keys (composition only — referential targets are asserted by the
  // migration-level suite via pg_constraint; here we assert that the FK
  // builders are present in the table config).
  // ---------------------------------------------------------------------------
  describe("foreign keys", () => {
    it("declares FKs from tenant_id, product_id, and store_id", () => {
      const cfg = getTableConfig(priceHistory);
      const fkRefs = cfg.foreignKeys.map((fk) => {
        const ref = fk.reference();
        return {
          columns: ref.columns.map((c) => c.name).sort(),
          foreignTable: getTableName(ref.foreignTable),
        };
      });
      // Three FKs expected: tenants, tenant_products, stores.
      const targetTables = fkRefs.map((f) => f.foreignTable).sort();
      expect(targetTables).toEqual(
        ["stores", "tenant_products", "tenants"].sort(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Indexes — open-interval enforcement (Q9 / R-1)
  // ---------------------------------------------------------------------------
  describe("partial unique indexes — at most one open interval", () => {
    it("declares a tenant-level open-interval partial unique index — Q9", () => {
      // Q9
      const cfg = getTableConfig(priceHistory);
      // data-model.md §7:
      //   UQ_idx_price_history_tenant_open
      //     ON price_history (tenant_id, product_id)
      //     WHERE store_id IS NULL AND effective_to IS NULL
      const idx = cfg.indexes.find(
        (i) => i.config.name === "UQ_idx_price_history_tenant_open",
      );
      expect(idx).toBeDefined();
      const config = idx!.config as {
        unique?: boolean;
        columns: Array<{ name: string }>;
        where?: unknown;
      };
      expect(config.unique).toBe(true);
      expect(config.columns.map((c) => c.name)).toEqual([
        "tenant_id",
        "product_id",
      ]);
      // Q9 — tenant-level open interval: WHERE must be
      //   store_id IS NULL AND effective_to IS NULL
      // The conjoined regex asserts both clauses are present in order with
      // an `AND` between them, so a future drift to e.g. `store_id IS NOT
      // NULL` or a missing `effective_to` clause fails the test.
      // The `(?:\w+\.)?` allows the rendered table qualifier
      // (`price_history.effective_to`) that PgDialect emits after the AND.
      const whereStr = normalizeRenderedSql(renderSQL(config.where)).toLowerCase();
      expect(whereStr).toMatch(
        /store_id\s+is\s+null\s+and\s+(?:\w+\.)?effective_to\s+is\s+null/,
      );
    });

    it("declares a store-level open-interval partial unique index — Q9", () => {
      // Q9
      const cfg = getTableConfig(priceHistory);
      // data-model.md §7:
      //   UQ_idx_price_history_store_open
      //     ON price_history (tenant_id, product_id, store_id)
      //     WHERE store_id IS NOT NULL AND effective_to IS NULL
      const idx = cfg.indexes.find(
        (i) => i.config.name === "UQ_idx_price_history_store_open",
      );
      expect(idx).toBeDefined();
      const config = idx!.config as {
        unique?: boolean;
        columns: Array<{ name: string }>;
        where?: unknown;
      };
      expect(config.unique).toBe(true);
      expect(config.columns.map((c) => c.name)).toEqual([
        "tenant_id",
        "product_id",
        "store_id",
      ]);
      // Q9 — store-level open interval: WHERE must be
      //   store_id IS NOT NULL AND effective_to IS NULL
      // The conjoined regex requires both clauses with the correct null-tests
      // joined by `AND`; a token-only check could pass on a wrongly inverted
      // predicate (e.g. store_id IS NULL). `(?:\w+\.)?` allows the rendered
      // table qualifier (`price_history.effective_to`).
      const whereStr = normalizeRenderedSql(renderSQL(config.where)).toLowerCase();
      expect(whereStr).toMatch(
        /store_id\s+is\s+not\s+null\s+and\s+(?:\w+\.)?effective_to\s+is\s+null/,
      );
    });

    it("declares a tenant timeline index ordered by effective_from (asc/desc verified at migration layer)", () => {
      const cfg = getTableConfig(priceHistory);
      const idx = cfg.indexes.find(
        (i) => i.config.name === "idx_price_history_product_timeline",
      );
      expect(idx).toBeDefined();
      const config = idx!.config as {
        unique?: boolean;
        columns: Array<{ name: string; order?: unknown }>;
      };
      expect(config.unique).toBeFalsy();
      expect(config.columns.map((c) => c.name)).toEqual([
        "tenant_id",
        "product_id",
        "effective_from",
      ]);
      // data-model.md §7 prescribes `effective_from DESC` for this timeline
      // index. Drizzle 0.45.x does NOT surface column direction on the
      // index config builder (the `.desc()` modifier is captured inside the
      // SQL fragment emitted at migration generation time, not on
      // `config.columns[i].order`). Reliable DESC verification therefore
      // lives at the migration-level suite (T326+) which can inspect the
      // generated SQL via `pg_indexes.indexdef`. Here we assert the
      // strongest reliable shape: column set and order on the index,
      // non-unique, no WHERE predicate.
      expect(config.columns[2]?.name).toBe("effective_from");
      expect(
        (idx!.config as { where?: unknown }).where,
      ).toBeUndefined();
    });

    it("declares a store timeline index partial on store_id IS NOT NULL", () => {
      const cfg = getTableConfig(priceHistory);
      const idx = cfg.indexes.find(
        (i) => i.config.name === "idx_price_history_store_timeline",
      );
      expect(idx).toBeDefined();
      const config = idx!.config as {
        unique?: boolean;
        columns: Array<{ name: string }>;
        where?: unknown;
      };
      expect(config.unique).toBeFalsy();
      expect(config.columns.map((c) => c.name)).toEqual([
        "tenant_id",
        "product_id",
        "store_id",
        "effective_from",
      ]);
      // Partial on store_id IS NOT NULL: assert the full predicate, not just
      // tokens, so an inverted predicate (`store_id IS NULL`) would fail.
      const whereStr = normalizeRenderedSql(renderSQL(config.where)).toLowerCase();
      expect(whereStr).toMatch(/store_id\s+is\s+not\s+null/);
    });
  });

  // ---------------------------------------------------------------------------
  // CHECK constraints (data-model §7)
  // ---------------------------------------------------------------------------
  describe("check constraints", () => {
    it("declares price_history_interval_order — closed intervals must end after they start — Q9", () => {
      // Q9
      const cfg = getTableConfig(priceHistory);
      const ck = cfg.checks.find(
        (c) => c.name === "price_history_interval_order",
      );
      expect(ck).toBeDefined();
      const expr = renderSQL((ck as unknown as { value: unknown }).value).toLowerCase();
      // The predicate must reference both effective_to and effective_from.
      expect(expr).toContain("effective_to");
      expect(expr).toContain("effective_from");
    });

    it("declares price_history_price_positive — price >= 0 — Q1", () => {
      // Q1
      const cfg = getTableConfig(priceHistory);
      const ck = cfg.checks.find(
        (c) => c.name === "price_history_price_positive",
      );
      expect(ck).toBeDefined();
      const expr = renderSQL((ck as unknown as { value: unknown }).value).toLowerCase();
      expect(expr).toContain("price");
      expect(expr).toContain(">=");
      expect(expr).toContain("0");
    });
  });
});
