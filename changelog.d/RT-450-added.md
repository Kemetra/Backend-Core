### Added
- RT-450 `[GATED]`, owner authorization 2026-10-21 (RT-50 Gate 7 follow-up F3,
  rules G7-7 to G7-9, G7-11 and G7-13, owner decision RT-50 comment 11765):
  contract-only tracked selling, all additive. New
  `pos-sales/tracked-lines.yaml` 1.0.0-draft defines the POS Tracked Line
  Validation `posValidateTrackedLine` (`operatorAuthorization`, or `device`
  with `operatorUserId`; answers `accepted` or `refused` with the seven closed
  reasons; records every validation; no `Idempotency-Key`, never refuses on
  quantity) and the lot lookup `posListTrackedLots` (server FEFO rank, advisory
  sellable position); both are `x-runtime-status: contract-only`.
  `pos-sales/sales.yaml` 1.15.0-draft adds the optional
  `CaptureSaleLine.tracking`, `CaptureSaleRequest.safetyRevision` and
  `safetySyncedAt`, their `SaleLine` / `Sale` echoes, and documents the G7-9
  ingest classification on `captureSale` (capture never rejects for tracking
  reasons; `tracking_unresolved`). `catalog/read-down.yaml` 1.1.0-draft adds the
  optional `SellableCatalogRow.tracking { mode, expiry_required }`.
  `erpnext-connector/posting-feed.yaml` 1.10.0-draft adds the optional,
  nullable `SaleLine.erpnextBatchRef` and `trackingMode` (Connector accepts
  before Backend-Core emits). `erpnext-connector/stock-view.yaml` 1.4.0-draft
  adds the optional `BinEntry.tracking` (Item flags and batch-wise book
  evidence; Backend-Core accepts before the Connector sends). The POS must not
  call or send any of it before the RT-451 runtime is deployed. No runtime,
  migration, Connector or POS change.
