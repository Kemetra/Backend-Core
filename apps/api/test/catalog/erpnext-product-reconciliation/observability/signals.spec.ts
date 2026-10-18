/**
 * signals.spec.ts — 021-POLISH (T037/T038/T039) observability + data-class checks.
 *
 * Docker-FREE. Verifies the new §VII signal `erpnext_product_reconciliation_total`:
 *   1. is registered in the SHARED `ALLOWED_METRIC_LABELS` closed allowlist
 *      (the worker-obs gotcha — the shared registry is the load-bearing entry);
 *   2. is UNLABELED (no PII/money/per-tenant/per-instance labels, §VII/§XIV);
 *   3. label-policy compliant (a forbidden label is rejected);
 *   4. its emission helper is callable without a live MetricReader (no-op idiom);
 *   5. §XIV data-class guard (T039): the owned schema carries NO money/PII column.
 */
import "reflect-metadata";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ALLOWED_METRIC_LABELS,
  validateMetricLabels,
} from "@data-pulse-2/shared";

import { recordErpnextProductReconciliation } from "../../../../src/observability/metrics/api.metrics";

const METRIC = "erpnext_product_reconciliation_total";

describe("021 observability — erpnext_product_reconciliation_total (T037/T038)", () => {
  it("is registered in the shared ALLOWED_METRIC_LABELS allowlist", () => {
    expect(ALLOWED_METRIC_LABELS[METRIC]).toBeDefined();
  });

  it("is UNLABELED (no PII/money/per-tenant/per-instance labels, §VII/§XIV)", () => {
    expect(ALLOWED_METRIC_LABELS[METRIC]).toEqual([]);
  });

  it("accepts an empty label set (the only legal call shape)", () => {
    expect(validateMetricLabels(METRIC, [])).toBeNull();
  });

  it("rejects a forbidden per-tenant label", () => {
    const result = validateMetricLabels(METRIC, ["tenant_id"]);
    expect(result).not.toBeNull();
  });

  it("the emission helper is callable without a live MetricReader (no-op)", () => {
    expect(() => recordErpnextProductReconciliation()).not.toThrow();
  });
});

describe("021 §XIV data-class guard — owned schema (T039)", () => {
  const schemaSrc = readFileSync(
    resolve(
      __dirname,
      "..", "..", "..", "..", "..", "..",
      "packages", "db", "src", "schema", "catalog",
      "erpnext-product-reconciliation.ts",
    ),
    "utf8",
  );
  const migrationSrc = readFileSync(
    resolve(
      __dirname,
      "..", "..", "..", "..", "..", "..",
      "packages", "db", "drizzle",
      "0023_erpnext_product_reconciliation.sql",
    ),
    "utf8",
  );

  const FORBIDDEN_COLUMNS = [
    "amount",
    "price",
    "cost",
    "valuation",
    "stock_value",
    "tender",
    "payment",
    "email",
    "phone",
    "password",
  ];

  it("the Drizzle schema declares NO money/PII column", () => {
    for (const col of FORBIDDEN_COLUMNS) {
      expect(schemaSrc).not.toMatch(new RegExp(`"${col}"`));
    }
  });

  it("the migration declares NO DELETE policy (retention = state, §XIV)", () => {
    expect(migrationSrc).not.toMatch(/FOR\s+DELETE/i);
  });

  it("the migration ENABLEs + FORCEs RLS on all three owned tables", () => {
    const enables = migrationSrc.match(/ENABLE ROW LEVEL SECURITY/g) ?? [];
    const forces = migrationSrc.match(/FORCE  ROW LEVEL SECURITY/g) ?? [];
    expect(enables).toHaveLength(3);
    expect(forces).toHaveLength(3);
  });

  it("the migration uses the empty-GUC CASE guard (fail-closed RLS)", () => {
    expect(migrationSrc).toMatch(
      /current_setting\('app\.current_tenant', true\) = '' THEN NULL/,
    );
  });
});
