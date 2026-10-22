### Added
- RT-367: runtime for the Console pairing codes (`PairingCodesController` /
  `PairingCodesService` in `DevicesModule`). The three operations ship
  unchanged on the wire and lose `x-runtime-status: contract-only`. The issue
  generates a 16-character code, stores only its hash, returns it once
  (`@Idempotent` with `replay: "forbid"`) and, for `replacesDeviceId`, decides
  replace / move with the shared lifecycle evaluator under the replaced
  device's lifecycle lock. `posPairTerminal` re-decides in its burn
  transaction (refusal: 409 `REPLACEMENT_BLOCKED`, code left pending), then
  auto-revokes a still-active replaced device through the RT-365 cascade
  (reason `replaced` / `moved`, no actor user) and writes `pos.device.paired`;
  it now returns `expires_at`. The revoke's SQL and cascade moved to
  `device-lifecycle.store.ts`, shared by the revoke, the issue and the pair;
  the revoke's 409 code is now the evaluator's `blockCode`. One replacement
  per device: the issue refuses a second (409 `replacement_already_pending` /
  `device_already_replaced`) and the redemption cancels sibling codes on
  every path. The issue's 201 is `Cache-Control: no-store`. A
  `REPLACEMENT_BLOCKED` redemption gives its per-code attempt back, so a
  blocked replacement code stays redeemable once the shift closes. Deploy:
  `docs/operations/sql/device-lifecycle-domain-grants.sql` (step 2) now also
  grants the domain role SELECT / INSERT / UPDATE on `pairing_codes`, which
  `DOMAIN_REQUIRED_GRANTS` checks at boot; the lookup role may hold SELECT
  only on it (`AUTH_LOOKUP_FORBIDDEN_GRANTS`). No migration.
