### Added
- RT-802 `[GATED: OpenAPI contract-only lift]`, owner authorization RT-802
  comment 13276: runtime for `posListChargeablePayers`
  (`GET /api/pos/v1/payer-accounts`, `pos-payers.openapi.yaml` 1.0.0-draft,
  RT-570); the operation is no longer contract-only. Envelope only
  (`PosOperatorEnvelopeSaleGuard`, then the per-device `posReadPayers` rate
  limit). The operator's standing is re-checked live with capture's own check
  (403 `sale_responsibility_role_refused`, capture's body) before the query is
  validated (400). One keyset page (payerRef DESC, cursor bound to the tenant,
  store and category, holding only the last id) of the active payers of the
  envelope's store or tenant-wide; other-store, other-tenant and suspended
  payers are absent. `chargeable` and capture's refusal 4 now share one SQL
  predicate (`chargeablePayerSql` in `sale-responsibilities.ts`; capture's
  behavior is unchanged). Minimum disclosure, `asOf`, `Cache-Control: no-store`,
  no audit event. No migration, no grant change.
