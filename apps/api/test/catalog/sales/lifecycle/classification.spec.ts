/**
 * apps/api/test/catalog/sales/lifecycle/classification.spec.ts
 *
 * Slice 008-LIFECYCLE (T075) — data-lifecycle classification + retention guard
 * (SI-012 / gate D.3, Constitution §XIV).
 *
 * The four sale-fact entities (`sales`, `sale_lines`, `sale_voids`,
 * `sale_refunds`) are BUSINESS-CLASS data: catalog references, quantities, and
 * POS-reported totals only. They carry NO PII and NO payment/tender data in v1
 * (tender is deferred per gate A.5). Retention INHERITS the 001 long-horizon,
 * insert-only audit-retention posture for the immutable fact; right-to-erasure
 * TOMBSTONES any future PII field rather than deleting the fact row. The full
 * classification + retention prose is recorded in:
 *   - packages/db/drizzle/0012_sales.sql  (migration header, lines ~50-68)
 *   - specs/008-sales-transaction-capture/data-model.md  (§ "State & lifecycle")
 * — both landed in the [GATED] 008-SCHEMA slice; this slice adds the EXECUTABLE
 * guard only.
 *
 * This is a Docker-FREE introspection guard (mirrors
 * `schema/sales-schema-shape.spec.ts`): it reads the actual persisted column
 * inventory off the Drizzle table objects via `getTableConfig` and asserts it
 * is EXACTLY the recorded business-class allowlist — a tripwire, not a denylist.
 * If a later slice adds, removes, or renames a persisted column, set-equality
 * fails and forces a re-review (the SI-012 reclassification trigger). A
 * secondary collision-safe PII/payment denylist catches the common shapes a
 * future customer-reference / tender column would take.
 *
 * Note: `@data-pulse-2/db/schema` resolves to the package's built `dist/`, so
 * the db package must be built before this spec sees the exports
 * (`pnpm --filter @data-pulse-2/db build`).
 */
import "reflect-metadata";

import * as fs from "node:fs";
import * as path from "node:path";

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

function persistedColumns(table: unknown): string[] {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  return cfg.columns.map((c) => (c as unknown as { name: string }).name).sort();
}

/**
 * The recorded BUSINESS-CLASS persisted-column inventory for each sale-fact
 * table. Every entry is a catalog reference, a quantity/amount, a POS-reported
 * total, server-owned provenance/processing state, a timestamp, or the acting
 * POS-device principal (`created_by` — an operational actor UUID, NOT customer
 * PII). NONE is a customer reference or a tender/payment field. This list IS
 * the machine-checked classification: changing it requires re-running SI-012.
 */
const BUSINESS_CLASS_COLUMNS: ReadonlyArray<{
  name: string;
  table: unknown;
  columns: string[];
}> = [
  {
    name: "sales",
    table: sales,
    columns: [
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
      "sync_status",
      "created_by",
      "created_at",
    ],
  },
  {
    name: "sale_lines",
    table: saleLines,
    columns: [
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
    ],
  },
  {
    name: "sale_voids",
    table: saleVoids,
    columns: [
      "id",
      "sale_id",
      "tenant_id",
      "store_id",
      "voided_at",
      "business_date",
      "source_system",
      "external_id",
      "payload_hash",
      "created_by",
      "created_at",
    ],
  },
  {
    name: "sale_refunds",
    table: saleRefunds,
    columns: [
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
      "created_at",
    ],
  },
  // RT-73 (0032) — re-reviewed under SI-012. `reason` is operator free text
  // that must not carry customer PII. sale_return_tenders records only the
  // refund payout METHOD ('cash') and AMOUNT as a fact (RT-14 D3): no card,
  // account or instrument data, no customer reference. A non-cash method
  // (RT-10) re-triggers SI-012.
  {
    name: "sale_returns",
    table: saleReturns,
    columns: [
      "id",
      "sale_id",
      "tenant_id",
      "store_id",
      "return_seq",
      "returned_at",
      "business_date",
      "currency_code",
      "return_total",
      "reason",
      "source_system",
      "external_id",
      "payload_hash",
      "created_by",
      "created_at",
    ],
  },
  {
    name: "sale_return_lines",
    table: saleReturnLines,
    columns: [
      "id",
      "return_id",
      "sale_line_id",
      "tenant_id",
      "store_id",
      "quantity",
      "line_amount",
      "tax_amount",
      "returned_quantity_after",
    ],
  },
  {
    name: "sale_return_tenders",
    table: saleReturnTenders,
    columns: ["id", "return_id", "tenant_id", "store_id", "ordinal", "method", "amount"],
  },
];

/**
 * Collision-safe PII / payment-class substrings. Each is a fragment that would
 * appear in a customer-reference or tender/payment column name but does NOT
 * collide with any business-class column above. Deliberately AVOIDS bare
 * `name` (would false-positive on `line_name`); `created_by` / `source_system`
 * are operational provenance, not customer PII.
 */
const PII_PAYMENT_SUBSTRINGS = [
  "customer",
  "patient",
  "email",
  "phone",
  "address",
  "ssn",
  "national_id",
  "first_name",
  "last_name",
  "full_name",
  "dob",
  "birth",
  "tender",
  "payment",
  "card",
  "cash",
  "pan",
  "iban",
  "account_number",
  "cvv",
];

describe("008-LIFECYCLE (T075) — sale-fact data-class classification (SI-012 / §XIV)", () => {
  describe.each(BUSINESS_CLASS_COLUMNS)(
    "$name persists EXACTLY the recorded business-class columns",
    ({ table, columns }) => {
      it("set-equals the business-class allowlist (tripwire on add/remove/rename)", () => {
        const actual = persistedColumns(table);
        const expected = [...columns].sort();
        // Set-equality: any drift (a new customer-reference or tender column,
        // or a removed/renamed field) fails here and forces SI-012 re-review.
        expect(actual).toEqual(expected);
      });
    },
  );

  describe("no PII / payment-class field is persisted in v1 (gate A.5 — tender deferred)", () => {
    it.each(BUSINESS_CLASS_COLUMNS)(
      "$name has zero PII/payment-class columns",
      ({ table }) => {
        const offending = persistedColumns(table).filter((col) =>
          PII_PAYMENT_SUBSTRINGS.some((frag) =>
            col.toLowerCase().includes(frag),
          ),
        );
        expect(offending).toEqual([]);
      },
    );
  });
});

describe("008-LIFECYCLE (T075) — classification + retention recorded in source-of-truth", () => {
  // The retention posture (001-inherited, insert-only; tombstone-on-erasure) is
  // PROSE, not a column shape — so the durable record lives in the migration
  // header + data-model.md. These secondary assertions prove that record exists
  // (kept lenient: keyword presence, not brittle wording).
  // repoRoot: __dirname is apps/api/test/catalog/sales/lifecycle → SIX hops up
  // (lifecycle→sales→catalog→test→api→apps→root). DO NOT reduce to five: five
  // resolves to <repo>/apps and the readFileSync calls below ENOENT on
  // <repo>/apps/packages/... CodeRabbit flagged "use one fewer .." — that is a
  // miscount; an autofix once applied it and broke the suite (PR #430). Six.
  const repoRoot = path.resolve(__dirname, "../../../../../..");

  it("0012_sales.sql header records business-class + 001-inherited retention", () => {
    const sqlPath = path.join(
      repoRoot,
      "packages/db/drizzle/0012_sales.sql",
    );
    const text = fs.readFileSync(sqlPath, "utf8");
    expect(text).toMatch(/BUSINESS-CLASS/i);
    expect(text).toMatch(/SI-012/);
    expect(text).toMatch(/001 long-horizon/i);
    expect(text).toMatch(/tombston/i);
  });

  it("data-model.md records the SI-012 business-class classification + retention", () => {
    const dmPath = path.join(
      repoRoot,
      "specs/008-sales-transaction-capture/data-model.md",
    );
    const text = fs.readFileSync(dmPath, "utf8");
    expect(text).toMatch(/business-class/i);
    expect(text).toMatch(/SI-012/);
    expect(text).toMatch(/inherits the 001/i);
    expect(text).toMatch(/tombston/i);
  });
});
