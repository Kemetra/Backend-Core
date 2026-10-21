### Added
- RT-649 / RT-739: runtime for `consoleGetSalesSummary` (`ConsoleSalesSummaryController`
  and service in `ConsoleSalesModule`); the operation loses
  `x-runtime-status: contract-only`. One SQL statement (one snapshot) counts
  and sums every fact per store, business date, currency and state through
  tenant RLS and the explicit operator store scope; legacy refunds and shift
  closes are bucketed by the store-local date of their instant (`AT TIME
  ZONE`, DST-correct); sums are added as exact BigInt decimals. Audited
  `console_sales.summary_read` (read kind), console rate limit class
  `expensiveRead`. No migration, package, lockfile or CI change. RT-739
  lands the runtime of #861, which had merged into a stacked branch rather
  than `main`.
