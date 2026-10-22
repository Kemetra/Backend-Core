### Added
- RT-735 `[GATED]`, owner authorization 2026-10-21 (RT-735 comments 13234 and
  13280; applying to the lab or a live database is not authorized): the two
  indexes behind `listStockMovements` (RT-731). Migration 0064 builds
  `idx_stock_movements_tenant_store_occurred` (tenant, store, occurred at DESC,
  id DESC) and 0065 builds `idx_stock_movements_tenant_store_product_occurred`
  (tenant, store, product, occurred at DESC, id DESC), each with `CREATE INDEX
  CONCURRENTLY` as a single-statement file so the runner does not wrap it in a
  transaction. Additive only; no runtime or contract change. On a 2M-row ledger
  the first page of `scope=all` drops from a full scan and sort (about 1.2 s,
  46k buffers) to 55 index buffers (0.1 ms); the per-product page loses its
  sort of every product row.
