### Added
- RT-662 `[GATED]`, owner-approved 2026-10-19 (RT-644 ENT-BC1,
  AD-AI-ENT-001): OpenAPI contract `ai-entitlements.openapi.yaml`
  (1.0.0-draft, contract-only). `consoleGetTenantAiEntitlements`
  (`GET /api/v1/tenants/{tenant_id}/ai/entitlements`) returns the `full`
  view to owner / tenant_admin (state, effective dates, per-feature
  availability, tenant opt-outs, UTC request meters) and the `minimal`
  `available | unavailable` view to store_manager; store_staff, another
  tenant and an absent tenant get the same non-disclosing 404, decided
  before any entitlement read; 503 `entitlement_unavailable` fails closed.
  `consolePutTenantAiFeatureOptOut` (`PUT .../ai/entitlements/opt-outs/
  {feature_id}`) is the owner-only, subtract-only opt-out write (D-5):
  required `reason`, `Idempotency-Key`, audited
  `ai_entitlement.opt_out_changed`, guarded by its own `optOutVersion`
  (never `entitlementVersion`), 403 `origin_rejected`, 409 on a stale
  revision, 422 `not_entitled` for an opt-in beyond the plan. The full view
  and every `check` decision report both `entitlementVersion` and
  `optOutVersion`. Also the closed AI reason-code set (§4.4 plus `feature_disabled_tenant`)
  and the server-internal `check` input and decision schemas
  (`x-internal`, no HTTP route). No price, currency, plan name, quota size,
  billing event or grace duration. No runtime or migration change; the
  runtime ships in RT-664.
