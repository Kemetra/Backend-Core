### Added
- RT-570 `[GATED]`, owner authorization 2026-10-21 (RT-417 F2): contract-only POS
  payer lookup for the till, new `pos-payers.openapi.yaml` 1.0.0-draft with
  `posListChargeablePayers` (`GET /api/pos/v1/payer-accounts`, operator envelope
  only, `x-runtime-status: contract-only`). Returns the active payers of the
  envelope's store scope (store-scoped to this store or tenant-wide), each with
  `payerRef`, `displayName`, `category`, `erpCustomerLinked` and a server
  `chargeable` decision that is exactly the capture payer predicate (not a credit
  limit or balance: ERPNext owns those). Owner / tenant_admin / store_manager
  only, else 403 `sale_responsibility_role_refused`; other-store, other-tenant
  and suspended payers are absent; no `externalRef`, store, status or credit
  data on the wire; keyset by `payerRef`, no free-text search in v1. v1 defines no
  offline freshness rule (option A forbids offline credit). Decision record
  `docs/planning/rt-570-pos-payer-lookup.md`. No runtime, migration, Connector or
  POS change.
