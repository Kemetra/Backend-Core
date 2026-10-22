### Added
- RT-492 `[GATED]`, pending owner approval (RT-114 MA-BC1; owner decision
  RT-114 comment 11888, reconciled with RT-284 comment 11887): OpenAPI
  contract `pos-approvers.openapi.yaml` (1.0.0-draft, contract-only).
  `posCheckApproverEligibility` (`POST /api/pos/v1/approvers/eligibility`,
  `device` bearer only, tenant and store from the device row) takes 1 to 50
  distinct `user_ids` and answers one `{ user_id, eligible }` per id, in
  request order. V1 eligibility: not deleted, an active membership in the
  device's tenant, a role in `{owner, tenant_admin, store_manager}` and
  access to the device's store. Unknown, cross-tenant and every other
  ineligible user are the same `eligible: false`, with no cause. The
  optional `action_kinds` is reserved for RT-284 P-A: the server omits it in
  1.0.0-draft, and clients honour it when present. Read-only, not audited,
  `Cache-Control: no-store`. The runtime ships in MA-BC2. No runtime or
  migration change.
