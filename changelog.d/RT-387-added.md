### Added
- RT-387 `[GATED: contract posture lift]`: the shift variance policy runtime
  (AD-CASH-001 F3) on the RT-385 migration 0050; no new migration.
  `CashVariancePolicyModule` ships the seven operations of
  `cash-variance-policy.openapi.yaml` 1.0.0-draft unchanged on the wire, and
  they lose `x-runtime-status: contract-only`: the POS device read (resolved
  policy, strong ETag over the resolved value, `If-None-Match` → 304), the
  tenant default and store override reads, keyset revision lists and
  idempotent publishes (session cookie only; owner / tenant_admin configure,
  store_manager reads its own stores; one non-disclosing 404). Resolution is
  stricter-wins with the tie to the store; publishes check, in the contract's
  order and on the database clock, EGP only, the expiry, an active override
  to clear, stricter-only and the owner rule for a permanent override, then
  `expectedRevisionId` (409), and write the revision with its
  `cash_variance_policy.changed` audit row in one transaction. An expired
  override writes `cash_variance_policy.override_expired` once, lazily, at
  the store's next resolution. Cash-up (`pos-shifts.openapi.yaml`
  1.2.0-draft): `openShift` accepts the optional `frozenPolicy`, records it
  verbatim with its accept-and-flag findings and hashes it only when present
  (a legacy open keeps its exact hash); a close records
  `approvalRequiredByPolicy` / `approvalMissing` from the frozen value
  (`unknown` without one) and persists the post-commit approver verdict in
  `shift_close_approver_checks`, which the 201 carries. Admin shift-close
  reads (`shift-closes.openapi.yaml` 1.1.0-draft) carry `frozenPolicy`, the
  derived values and `approverCheck`, and accept the `approval_required`,
  `approval_missing` and `approver_check` filters. Deploy: run
  `docs/operations/sql/shift-variance-policy-domain-grants.sql` after
  `migrate up` (`DOMAIN_REQUIRED_GRANTS` now lists
  `cash_variance_policy_revisions` and `shift_close_approver_checks` SELECT /
  INSERT).
