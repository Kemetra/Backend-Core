### Added
- RT-561 `[GATED]`, pending owner approval (RT-556 F1): OpenAPI contract
  `console-sales.openapi.yaml` (1.0.0-draft, contract-only). It defines the
  console read of received sales for Admin-Console spec 012:
  `GET /api/v1/sales` (`consoleListSales`: one required `store_id`, an
  inclusive business-date range of at most 31 days, sale-number and status
  filters, keyset pages) and `GET /api/v1/sales/{saleRef}` (`consoleGetSale`:
  the recorded detail without the POS-only receipt-facts and reprint parts).
  Dashboard session only, roles owner / tenant_admin / store_manager, the
  operator store scope and one non-disclosing 404; audit actions
  `console_sales.listed` / `console_sales.detail_read`. No runtime or
  migration change; `pos-sales/sale-history.yaml` is unchanged.
