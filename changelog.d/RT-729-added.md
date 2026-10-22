### Added
- RT-729 `[GATED]`, owner-approved 2026-10-19 (CAT-R1 of RT-281): OpenAPI
  contract `catalog/console-catalog.yaml` (1.0.0-draft, contract-only). It
  defines the console read of the Tenant Catalog for Admin-Console RF-3 and
  the RT-724 link product picker: `consoleListCatalogProducts` (search by
  exact active barcode / sku / plu or case-insensitive name substring, status
  and category filters, an optional store's effective view, keyset cursor),
  `consoleGetCatalogProduct` (identifiers and store overrides in the caller's
  store scope) and `consoleListCatalogCategories`. Dashboard session only,
  roles owner / tenant_admin / store_manager, non-disclosing 404, no per-read
  audit. No runtime or migration change; the runtime ships in RT-730.
