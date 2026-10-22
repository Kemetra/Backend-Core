### Added
- RT-427 on `[GATED]` migration `0063_inventory_effects_activation` (owner-approved
  2026-10-21: migration as proposed, decisions 1–6 as recommended). Sale, void
  and return Inventory Effects are written in the same transaction as their
  `erpnext.posting.requested` intent (RT-289 DC-1 / DC-2), per tenant behind
  `tenant_inventory_settings.sale_effects_activated_at`, which is OFF (NULL) for
  every tenant; with it OFF nothing changes. A sale line writes `-q` at the
  store's primary location / sellable (`sale_line:<id>`), a void compensates
  each sale effect at its position (`void:<voidId>:<lineId>`), a return writes
  `+q` in the tenant's return landing status (`return_line:<id>`), a refund
  writes nothing. Effects start `not_posted` and the posting-requested consumer
  links them `pending` / `rejected` when it creates the posting row; RT-426
  moves them from there. Lines that cannot be written exactly are skipped
  (`inventory_sale_effect_skipped_total`), never stall the sale. Activation is
  the operator CLI `packages/db/dist/cli/inventory-effects.js activate`: it
  refuses unless every store has a fresh complete Bin snapshot and no posting
  in flight, takes an Inventory Anchor per store (`inventory_anchors` /
  `inventory_anchor_lines`) and backfills no sale; `compare` prints the
  read-only anchor + effects vs latest Bin comparison. The dead
  `InventoryBackfillProcessor` is deleted. Deploy: run
  `docs/operations/sql/inventory-anchors-domain-grants.sql` in step 2.
