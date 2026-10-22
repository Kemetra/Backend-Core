### Added
- RT-435 `[GATED: OpenAPI contract + migration]`, owner-approved 2026-10-19
  (RT-435 comment 12993, D1–D4; RT-290 Gate 4): inventory status moves and
  relocations. `inventory.yaml` 1.6.0-draft adds `createStatusMove`
  (`POST /api/inventory/v1/stores/{storeId}/status-moves`),
  `createRelocation` (`POST .../relocations`) and the tenant return landing
  policy (`GET`/`PUT /api/inventory/v1/settings/return-landing`, `sellable`
  default | `return_inspection`). Each move is one `adjustment` event with an
  `inventory_position_events` record and exactly two effects (`-q` from,
  `+q` to; DC-1 keys `<kind>:<eventId>:from|to`), `erp_neutral` in the same
  transaction under the V1 mapping profile (M-5, Q10); a non-zero per-bucket
  net fails closed. Physical on-hand never changes. Governed Reason Codes
  (D1); moves out of damaged / expired / a hold are owner / tenant_admin only
  (D2). `StockMovement.integrationState` gains `erp_neutral` (5 acknowledged
  oasdiff findings, `consumer:none`). Migration `0056_inventory_position_events`
  (+ guarded down) and `docs/operations/sql/inventory-position-events-domain-grants.sql`
  (deploy step 2; boot check). No package or CI change.
