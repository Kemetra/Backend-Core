### Added
- RT-649 `[GATED]`, owner-approved 2026-10-19 (BC-009-1, RT-642 D0 P3):
  OpenAPI contract `console-sales-summary.openapi.yaml` (1.0.0-draft,
  contract-only). `consoleGetSalesSummary` (`GET /api/v1/sales-summary`) is
  the deterministic sales KPI read for Admin-Console spec 009 P-6 and a
  future Daily Briefing: per store, per business date (store timezone, DST
  via the tz database) and per currency, received-sale count and gross
  total, voids, returns, legacy refunds, shift-close outcomes and sync /
  ERP-posting attention counts, with `asOf`, `completeness: received_only`,
  explicit `unknown` buckets, exact four-digit decimal money, a 31-day
  range, store paging and server scope totals. Dashboard session, roles
  owner / tenant_admin / store_manager, non-disclosing 404, audited
  `console_sales.summary_read`. No runtime or migration change.
