### Added
- RT-449 `[GATED]` migration `0072_inventory_safety` + `inventory.yaml`
  1.7.0-draft (RT-50 Gate 7 F2, PR 1 of 2; authorized in RT-449 comment
  13434, PR + CI only): tracking holds, recall, identity expiry correction and
  the Inventory Safety Revision. `placeQualityHold` puts a `quality_hold` on a
  tracking identity and `createInventoryRecall` (a Recall safety Business
  Event; the product is never retired) a `recall_hold` on each listed
  identity; both move the identity's positive `sellable` and
  `return_inspection` positions into the hold's status as RT-435 status
  moves (`erp_neutral` effect pairs carrying the identity; negative positions
  are never moved). `releaseTrackingHold` (owner only) ends a hold once: a
  quality hold's quantity returns to `sellable` (to `recall_hold` while a
  recall is active on the identity); a recall hold's quantity stays for the
  Gate 8 disposition. `correctTrackingIdentityExpiry` corrects an identity's
  expiry with history; 0072's identity guard refuses any expiry change
  without its correction row, and now also freezes `manufactured_on`. Every
  placement, release, recall, expiry correction and tracking-profile change
  steps the tenant's monotonic Safety Revision exactly once, with one change
  row (the POS feed's delta source in PR 2). All operations are tenant-level,
  owner / tenant_admin (release: owner); replays and refusals write nothing.
  `tenant_inventory_settings.safety_ttl_seconds` (60–900, NULL = 900) is
  stored for PR 2. Deploy: apply 0072 and
  `docs/operations/sql/inventory-safety-domain-grants.sql` before the API
  rolls out. Nothing writes tracking identities until RT-451 / F6, so these
  operations act on nothing in production before then.
