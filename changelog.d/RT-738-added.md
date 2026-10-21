### Added
- RT-738 (CAT-W1 + CAT-W2 of RT-281): runtime for the seven interim console
  catalog writes (`ConsoleCatalogWriteController` / `ConsoleCatalogWriteService`
  in `apps/api/src/catalog/console-catalog/`); they lose `x-runtime-status:
  contract-only` and ship unchanged on the wire. Each write is one RLS tenant
  transaction holding the change, its `audit_events` row and the detail it
  answers with; POS propagation stays on the 0015 `catalog_change_log`
  triggers. `expectedUpdatedAt` compares at millisecond precision and a write
  reruns its transaction rather than reuse its row's `updated_at`
  millisecond, so every accepted write's `updatedAt` is strictly later. Price
  is never written; store data follows the operator store scope, and a
  soft-deleted store is a 404. `ConsoleCatalogReadService.detailIn` lets a
  write answer from its own transaction. No migration, package or CI change.
