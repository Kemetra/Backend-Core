### Added
- RT-538 `[GATED]`, owner-authorized 2026-10-16 for implement and merge, not
  deploy (RT-538 comment 12079): storage for the store-wide sale history
  (RT-537 contract). Migration 0047 adds the nullable receipt snapshot columns
  on `sales` (`receipt_*`), `sale_lines.line_seq` and the append-only,
  tenant-RLS `sale_reprints` table; migration 0048 builds
  `idx_sales_tenant_store_business_date` (tenant, store, business date DESC,
  occurred at DESC, id DESC) with `CREATE INDEX CONCURRENTLY`, as a
  single-statement file so the runner does not wrap it in a transaction. No
  backfill, no runtime or contract change; the routes stay contract-only until
  RT-539.
