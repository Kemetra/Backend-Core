### Changed
- RT-417 `[GATED]`, owner-authorized 2026-10-12 (RT-417 comment 11671; owner
  decision R-1, RT-413 comment 11669): the contracts for payer
  responsibilities captured on the sale (035 narrowed to Option B).
  `settlement/settlement.yaml` 2.0.0 is BREAKING, replacing the stale
  1.0.0-draft: only `consoleCreatePayerAccount` and `consoleListPayerAccounts`
  remain (still contract-only until RT-418); `consoleApplyPayment`,
  `consoleSubmitClaim`, `consoleReconcileRemittance`,
  `posRecordSettlementIntent`, `consoleGetReceivable` and
  `consoleListReceivables` are removed (listed in `x-retired-operations`; the
  runtime keeps serving them until RT-422); `PayerAccountCreate.creditTerms` is
  removed and `externalRef` is the ERPNext Customer link.
  `pos-sales/sales.yaml` 1.10.0-draft (additive): optional
  `CaptureSaleRequest.responsibilities[{payerRef, amount, sequence}]`, the
  coverage rule `sum(tenders) + sum(responsibilities) = posTotal` (422
  `sale_responsibility_mismatch`), 422 `sale_responsibility_payer_invalid`,
  hashed into the payload, and an optional `Sale.responsibilities`.
  Responsibilities are accepted only on the `operatorAuthorization` path,
  captured synchronously before finalize; on the device path they are 422
  `sale_responsibility_offline_refused` (owner decision 2026-10-16, option A),
  and an envelope operator outside owner / tenant_admin / store_manager gets 403
  `sale_responsibility_role_refused` (the capture 403 is now `CaptureForbidden`,
  carrying it and the RT-224 `refused`). One payer per sale in this version
  (`maxItems: 1`: one Sales Invoice and one `documentRef` per work item), and a
  non-null `PayerAccountCreate.externalRef` must be nonblank.
  `erpnext-connector/posting-feed.yaml` 1.8.0-draft (additive):
  `Sale.responsibilities[{payerExternalRef, amount, sequence}]`, failing closed
  for an unmapped payer; such sales and their reversals are held off the feed
  until the Connector supports them (RT-419). Acknowledged oasdiff findings for
  the settlement removals. Recorded as Amendment A2 in the 035 decision record.
  No runtime or migration change.
