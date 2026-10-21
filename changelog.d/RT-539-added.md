### Added
- RT-539 (RT-534 S3; owner decisions OD-534-1..8): the store-wide POS sale
  history runtime on the RT-538 schema. `GET /api/pos/v1/sale-history`
  (business-date range, at most 31 days, keyset pages), `GET
  /api/pos/v1/sale-history/{saleRef}` (the full recorded detail) and `POST
  /api/pos/v1/sale-history/{saleRef}/reprints` (authorize / record), behind
  `SaleHistoryAuthGuard`: the manager/admin envelope sees every sale of its
  store; the device bearer plus `X-Cashier-Admission` sees only the admitted
  cashier's own sales, from every till of the store. Per-device rate limits
  (`posReadSaleHistory`, `posWriteSaleReprint`). `captureSale` accepts the
  optional `receipt` snapshot (kept out of `payload_hash`, first write wins)
  and stores each line's position as `line_seq`. Deploy step 2 gains
  `sale-reprints-domain-grants.sql`; the API refuses to boot without it. The
  contract's `x-runtime-status: contract-only` markers are unchanged ([GATED]).
