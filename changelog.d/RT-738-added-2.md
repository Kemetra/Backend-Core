### Added
- RT-738 `[GATED]`, owner-approved 2026-10-19 (CAT-W1 + CAT-W2 of RT-281):
  `catalog/console-catalog.yaml` 1.1.0-draft (additive) adds seven interim,
  audited console catalog writes, contract-only until the RT-738 runtime:
  `consoleCreateCatalogProduct` (`Idempotency-Key`),
  `consoleUpdateCatalogProduct` and `consoleRetireCatalogProduct`
  (`expectedUpdatedAt` → 409 `stale_write`), `consoleAddProductIdentifier`
  (non-disclosing 409 `alias_conflict`) and `consoleRetireProductIdentifier`
  (owner / tenant_admin), and `consoleUpsertStoreOverride` /
  `consoleRetireStoreOverride` (availability for store_manager on in-scope
  stores; tax category owner / tenant_admin only). No price field (O-2), no
  identifier move, 403 `origin_rejected` on cookie writes, soft-deleted
  stores a 404. Labelled interim, pre Change Sets (decision 400). No runtime
  or migration change.
