### Added
- RT-431 `[GATED]` contract-only lift (implementation authorized on RT-431,
  comment 13277): `listPlatformAuditEvents` runtime.
  `PlatformAuditController` (`GET /api/v1/platform/audit/events`) is its own
  class behind `SessionOnlyAdminGuard` then `PlatformAdminGuard`
  (`users.is_platform_admin`, checked before query validation). It is not
  behind `TenantContextGuard`, so RT-414 enforcement does not cover it, and it
  writes no `platform.cross_tenant.accessed` row. The read runs under the
  platform-admin context with an explicit `tenant_id IS NULL` on the list and
  on the RT-211 cursor anchor (`DrizzleAuditRepository.listPlatformPage`,
  shared scope predicate). `actor_label` is masked (D5); there is no
  self-audit; the console rate-limit class is `expensiveRead`. EXPLAIN
  (ANALYZE) as `app_test` shows that the existing
  `audit_events_tenant_time_idx` serves the `tenant_id IS NULL` predicate,
  but not the keyset order. It has no `id` column, so every page top-N sorts
  the whole null-tenant bucket (about 1 ms at 4k rows, 58 to 81 ms at 400k,
  where the planner picks a parallel seq scan). That is the same ordering
  design as `listAuditEvents`. An ordered index is separate `[GATED]`
  migration work, and no migration is in this change. The `x-runtime-status`
  marker and note are removed from `audit.openapi.yaml`.
