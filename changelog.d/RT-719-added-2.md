### Added
- RT-719 step 2 `[GATED]` migration `0073_device_build_identity` and
  contract-only lift, owner authorization 2026-10-22 (RT-719 comment 13394; PR +
  CI only, never applied to a lab or live database): the runtime of
  `consoleGetFleetBaseline` (`GET /api/v1/device-builds/baseline`), which loses
  its `x-runtime-status: contract-only` marker with no other contract change
  (description wording only), and the recording of the POS build identity.
  Migration `0073` adds four NULLABLE columns to `devices`
  (`reported_build_commit`, `reported_app_version`, `reported_contract_pin`,
  `build_reported_at`; bounded patterns, no default, a CHECK that ties them
  together; additive, no grant needed, the existing tenant RLS isolates them;
  the down drops only them and so discards every reported identity). The
  thirteen reporting operations (`@ReportsBuildIdentity()`: catalog snapshot and
  deltas, cashier admissions, shifts, cash movements, sale history and reprint,
  cash variance policy, captureSale on its device path) read the optional
  `X-POS-Build-Commit`, `X-POS-App-Version` and `X-POS-Contract-Pin` headers in
  `PosDeviceAuthGuard` and store them with the existing throttled RT-370
  last-seen write: a value that is longer, malformed or repeated is missing and
  never an error or a change to the answer; without a valid commit the identity
  is unknown and the stored one is CLEARED (an older build never reads as the
  newer one); any other device-token route neither records nor clears it; a
  refused request records nothing; a failed store is counted and swallowed. New
  signal `pos_build_identity_report_total{outcome=recorded|unknown|failed}`,
  never a value in a label. `DeviceSummary` / `DeviceDetail` now send the
  optional `buildIdentity` (null until a terminal reports; kept on a revoked
  device). The baseline is one snapshot over the ACTIVE devices in the caller's
  store scope: one entry per distinct identity with its device count and the
  oldest and latest server-clock report, an explicit `unknownDeviceCount`
  (never folded into a build), ordered by commit, version and pin in code-unit
  order with nulls last, owner / tenant_admin / store_manager only, a
  non-disclosing 404 (never 403), audited as `devices.fleet_baseline_read`
  (scope, store and entry count, never a value). The POS change that sends the
  headers and the lab proof (RT-329) are separate work.
