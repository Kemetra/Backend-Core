### Added
- RT-572 `[GATED]`, pending owner approval: `settlement/settlement.yaml` 2.1.0 adds
  `consoleUpdatePayerAccount` (`PATCH /api/v1/settlement/payer-accounts/{payerRef}`,
  contract-only), so a payer created without `externalRef` (its ERPNext Customer
  link) can be repaired instead of failing every credit sale with
  `sale_responsibility_payer_invalid`. Additive to 2.0.0: no existing operation
  or schema changes. Body `PayerAccountUpdate`: `expectedVersion` (the existing
  `PayerAccount.version`, int4-bounded, so no new column) plus at least one of
  `displayName`, `externalRef` (set or replace, never cleared; an identifier of
  1..140 characters with no surrounding whitespace, control, zero-width or separator characters) and
  `status` (active / suspended); `category` and `storeId` are immutable. A stale
  `expectedVersion` is 409 `payer_version_conflict`; a no-op is 200 with the
  version unchanged. A `status` or `externalRef` change of a tenant-wide payer
  needs tenant-wide store scope (else 403 `payer_scope_insufficient`). `suspended` also
  fails credit reversals of that payer's sales closed under RT-577 D12. An
  effective update writes `settlement.payer_account.updated` in the same
  transaction as the update (field names, status and `externalRef` before / after, never the
  displayName). A changed `externalRef` never touches a posting that already
  froze its payer link (RT-332); an operator re-resolution re-reads the live
  value. Runtime follows in the RT-572 runtime PR.
