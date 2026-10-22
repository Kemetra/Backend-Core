### Added
- RT-431 `[GATED]`, contract-only (decisions D1 to D5 confirmed 2026-10-21,
  recorded on RT-431): `audit.openapi.yaml`
  1.3.0-draft adds `listPlatformAuditEvents` (`GET /api/v1/platform/audit/events`,
  `x-runtime-status: contract-only`), a platform-admin-only read of the
  platform-scoped audit rows (`tenant_id` null: `auth.signin.ok`,
  `auth.signin.failed` and the RT-414 unresolvable-path-tenant
  `platform.cross_tenant.accessed` rows) that `listAuditEvents` never returns.
  `cookieAuth` only; a non-platform-admin, tenant owners included, gets 403. It
  is not tenant-scoped, so RT-414 support-session enforcement does not cover it
  and it needs no support session. Filters: `action`, `kind`, `actor_user_id`,
  `from`, `to`, `cursor`, `limit` (no `tenant_id` / `store_id`), with the
  `listAuditEvents` keyset order (RT-211). New `PlatformAuditEvent` is strict
  with `tenant_id` always null; an email-shaped `actor_label` is returned masked
  (`a***@example.com`). The read is not itself audited. `listAuditEvents` and
  `AuditEvent` are unchanged. No runtime, migration or Console change.
