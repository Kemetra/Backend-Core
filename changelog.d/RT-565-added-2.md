### Added
- RT-565 `[GATED]` migrations 0057-0061, owner-approved 2026-10-19 (RT-565
  comment 12969): runtime for the console posting freshness. The sync-ops
  summary now serves `asOf` and `postingFreshness`
  (`apps/api/src/catalog/erpnext-sync-ops/posting-freshness.read.ts`): one
  statement, so one snapshot, with `asOf` = `clock_timestamp()` taken inside
  it; tenant-wide probes, or one `LATERAL ... LIMIT 1` probe per store for a
  `store_id` filter or an RT-192 membership scope. Five partial indexes on
  `erpnext_posting_status` (D7), one `CREATE INDEX CONCURRENTLY` file each
  (the 0048 rule): posted_at tenant-first and store-first, pending created_at
  tenant-first and store-first, and the fixed-size pre-0042 legacy-posted
  set. Roles, RLS, store scope and the 404 are unchanged. No package or CI
  change.
