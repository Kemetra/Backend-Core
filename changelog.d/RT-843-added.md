### Added
- RT-843 `[GATED]`, owner-approved 2026-10-23 (RT-782 follow-up): OpenAPI
  `tenants.openapi.yaml` 1.2.0-draft. `TenantSummary` (the `listTenants` row)
  gains a required `status` (`active | suspended | pending`, same enum as
  `Tenant.status`), read from the existing `tenants.status` column so the
  platform tenant directory needs no per-row `readTenant`. Response-only,
  additive; no migration, no request or status-code change.
