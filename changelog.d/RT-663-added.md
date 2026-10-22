### Added
- RT-663 `[GATED]` migration `0055_ai_entitlements_usage` (owner-approved
  2026-10-19 for authoring and CI verification only; not applied to any lab
  or live database). It is storage only, for AD-AI-ENT-001 and
  AD-AI-PROV-001 D-6, and has no runtime until RT-664. It adds:
  - the code-owned, versioned, default-deny AI plan catalog (seed `core@1`
    grants no feature and no meter);
  - immutable `tenant_ai_entitlements` revisions on a tenant-wide
    `entitlement_version` chain, platform-admin INSERT only;
  - the tenant owner opt-out chain `tenant_ai_feature_opt_outs` (D-5);
  - `ai_usage_counters` per tenant, store, meter and UTC window;
  - the single append-only `ai_usage_ledger`: `reserved`, then
    `committed` / `released`, unique (tenant, feature, kind, idempotency_key),
    with the AI-09 run metadata. A dispute is settled by a platform-admin-only
    compensating `adjusted` row (T20).

  Every table forces RLS. There is no price column and no grant.
