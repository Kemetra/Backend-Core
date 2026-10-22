### Added
- RT-562 (RT-556 F2): runtime for the console sales read
  (`ConsoleSalesModule`). Both operations ship unchanged on the wire and lose
  `x-runtime-status: contract-only`. Dashboard session only, roles owner /
  tenant_admin / store_manager, the operator store scope with an explicit
  `store_id` predicate (sales RLS is tenant-only), one non-disclosing 404 body,
  an inclusive 31-day range, and a cursor bound to the operation, tenant,
  store and every filter. A filtered request (`sale_number`, `sync_status`,
  `voided`, `return_state`, `erp_posting_state`) reads at most 500 sales, so
  a page may be short or empty with a non-null cursor. Reuses the RT-539
  sale-history query and projections; the list reads migration 0048's index.
  No migration; `sale-history.yaml` and `sales.yaml` are unchanged.
