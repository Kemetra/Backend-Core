### Added
- RT-730 (CAT-R2 of RT-281): runtime for the console catalog read
  (`ConsoleCatalogModule`, `apps/api/src/catalog/console-catalog/`). All three
  operations ship unchanged on the wire and lose `x-runtime-status:
  contract-only`. Reads run under the RLS tenant context; store data
  (`storeView`, store-scoped identifiers, overrides) carries an explicit
  store predicate from the operator store scope. The Tenant ⊕ Store Override
  resolver is extracted from the POS read-down into
  `catalog/store-resolution/store-product-resolution.ts` and shared by both
  reads (a Testcontainers parity test pins `storeView` to the read-down
  projection). The keyset cursor is a compact, filter-bound byte layout. A
  soft-deleted store is absent on this surface for every scope (owner
  decision): its `store_id` is a 404 and its overrides and store-scoped
  identifiers are never shown or matched, unlike console-sales. No
  migration, package or CI change.
