### Added
- RT-414 `[GATED]`, owner-approved 2026-10-12 (decisions 1–5 on RT-414): OpenAPI contract
  `platform-support-sessions.openapi.yaml` (1.0.0-draft, contract-only). It
  defines the platform support session (RT-391 P0-a, D2): open with a
  mandatory purpose, read current, explicit renew and end, a 60-minute
  server-set expiry, the cross-cutting `support_session_required` /
  `support_session_expired` refusal on tenant-scoped routes (including
  `listMembers`, `updateTenant` and `switchActiveStore`), an `Origin` check
  (`origin_rejected`) on the surface's POSTs and on unsafe-method requests a
  support session admits, and the
  `platform.support_session.*` and `platform.cross_tenant.accessed` audit
  metadata allowlists. `context.openapi.yaml` 1.1.0-draft adds a
  platform-admin-only 403 on `switchActiveTenant` and a nullable
  `support_session` on `ContextResponse`. No runtime or migration change.
