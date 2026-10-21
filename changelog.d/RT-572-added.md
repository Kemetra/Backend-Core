### Added
- RT-572 `[GATED: contract posture lift]`: runtime for `consoleUpdatePayerAccount`
  (`PATCH /api/v1/settlement/payer-accounts/{payerRef}`, `settlement.yaml` 2.1.0);
  the operation is no longer contract-only. `PayerAccountsService.update` runs one
  transaction: lock the payer row, then 404 (absent / other tenant / store-scoped
  outside the caller's stores), 403 `payer_scope_insufficient` (a `status` or
  `externalRef` field on a tenant-wide payer without tenant-wide store scope; by
  presence), 409 `payer_version_conflict`, then a no-op returns the unchanged
  payer, else `version + 1` and `settlement.payer_account.updated` in the same
  transaction (tenant-level, `store_id` null, for a tenant-wide payer; field
  names, status and `externalRef` before / after, never the display name).
  `payerRef` is validated as a uuid before any SQL cast. No migration (it uses the
  existing `payer_account.version`; 0053 is not consumed) and no new grant
  (`payer_account` `UPDATE` and `audit_events` `INSERT` already exist; comments
  and `docs/operations/database-roles.md` updated).
