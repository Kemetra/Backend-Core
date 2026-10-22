### Added
- RT-414 runtime (RT-391 P0-a, D2) on `[GATED]` migration
  `0062_platform_support_sessions` (approved 2026-10-21 under the owner's
  delegation). The four support-session operations ship and their
  `contract-only` markers are lifted (`platform-support-sessions.openapi.yaml`
  1.2.0-draft). A platform admin in a tenant they are not a member of is
  admitted to every `TenantContextGuard` route, `switchActiveStore`,
  `listMembers` and `updateTenant` only through an active support session;
  expiry is refused server-side and renewal is explicit (capped at opened + 8
  hours). Each such request writes one `platform.cross_tenant.accessed` row,
  and open, renew and end write `platform.support_session.*` rows, all visible
  to the tenant's owner and tenant_admin. A suspended tenant opens a read-only
  session (`support_session_read_only`); on it `updateTenant` is admitted only
  for a status-only body, so the tenant can be reactivated. `switchActiveTenant` refuses a non-member
  platform admin (403 `support_session_required`), and sign-out and tenant
  switch end the session. Deploy: run
  `docs/operations/sql/platform-support-sessions-domain-grants.sql` in step 2.
