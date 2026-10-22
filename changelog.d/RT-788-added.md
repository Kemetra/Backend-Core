### Added
- RT-788 `[GATED]` contract-only lift, owner authorization 2026-10-21 (RT-788
  comment 13275; RT-114 MA-BC2): the runtime of `posCheckApproverEligibility`
  (`POST /api/pos/v1/approvers/eligibility`, contract RT-492), which loses its
  `x-runtime-status: contract-only` marker; no other contract change. Device
  bearer only; tenant and store come from the device row. One tenant-scoped
  read answers each of 1 to 50 distinct ids (case-insensitive duplicates are a
  400) in request order, echoed as sent: eligible iff the user is not deleted,
  has an active membership in the device's tenant with role `owner`,
  `tenant_admin` or `store_manager` (the RT-17 / RT-530 approver set), and can
  access the device's store, which is checked in code because RLS isolates
  tenants only. An unknown, cross-tenant or otherwise ineligible id is
  `eligible: false` with no cause; the cause is logged server-side under the
  request id. `action_kinds` is never emitted; `Cache-Control: no-store`; no
  audit row, no migration.
