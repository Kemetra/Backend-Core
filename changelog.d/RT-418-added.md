### Added
- RT-418 `[GATED]` migration `0051_sale_responsibilities`, pending owner
  approval: the runtime for the RT-417 contracts (owner decisions R-1 and
  option A). Migration: append-only, RLS-forced `sale_responsibilities`
  (composite FKs to `sales` and to `payer_account (id, tenant_id)`, amount
  > 0, one row per payer and per sequence), `sales.responsibility_count`
  (0..1, the feed's visibility guard), `erpnext_posting_resolution
  .payer_external_ref` (the payer's ERPNext Customer link frozen with each
  resolution version), and `payer_account.credit_terms` dropped. Capture
  (`pos-sales/sales.yaml` 1.10.0-draft) accepts `responsibilities` (one
  payer), hashes them into the payload, and decides, after a replay
  resolves: 403 `sale_responsibility_role_refused` (envelope operator not an
  active owner / tenant_admin / store_manager of the store), 422
  `sale_responsibility_offline_refused` (the RT-224 device path), the combined
  coverage rule (422 `sale_responsibility_mismatch`; it replaces the RT-76
  tender rule, and the tender rule now also runs after the replay check, so a
  replay with different tenders is a 409, never a 422), the line price
  invariant, then one non-disclosing 422
  `sale_responsibility_payer_invalid`; a replay with different
  responsibilities is a 409. `Sale.responsibilities` on capture and read.
  Posting feed (`posting-feed.yaml` 1.8.0-draft): `sale.responsibilities
  [{payerExternalRef, amount, sequence}]` from the frozen resolution
  (`payloadHash` unchanged); a responsibility-bearing `sale_post` is held
  until `ERPNEXT_FEED_RESPONSIBILITIES_ENABLED` is on (after RT-419), its
  reversals are always held, its `sale_post` is held while a void, refund or
  return exists, and the feed fails closed: a sale whose responsibility rows
  are not all visible, or whose (frozen) payer link is NULL or blank, is
  held, never offered as cash or to the store Customer. Lifting the gate
  hold needs `docs/operations/sql/sale-responsibilities-feed-rehead.sql`
  (deploy/README.md "Enabling credit posting"); the flag is not yet mapped
  into the api container (unmapped = held). Payer routes (`settlement/settlement.yaml` 2.0.0)
  `consoleCreatePayerAccount` / `consoleListPayerAccounts` ship
  (`PayerAccountsModule`) and lose `x-runtime-status: contract-only`.
  Deploy: run `docs/operations/sql/sale-responsibilities-domain-grants.sql`
  after `migrate up` (`DOMAIN_REQUIRED_GRANTS` now lists
  `sale_responsibilities` SELECT / INSERT and `payer_account` SELECT /
  INSERT / UPDATE).
