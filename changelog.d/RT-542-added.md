### Added
- RT-542 `[GATED]`, owner-approved 2026-10-16 (RT-542 comment 12124): the three
  sale-history operations (`listSaleHistory`, `readSaleHistoryDetail`,
  `recordSaleReprint`) lose `x-runtime-status: contract-only` now that the RT-539
  runtime serves them. `sale-history.yaml` stays `1.0.0-draft`; no new field, no
  other operation, no runtime or migration change.
