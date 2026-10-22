### Added
- RT-327 step 2 `[GATED]` migration `0068_pos_device_health` and contract-only
  lift, owner authorization 2026-10-21 (RT-327 comments 13279, 13360, 13393; wave 1
  authorization relayed by the coordinating session): the runtime of the five
  `pos-device-health.openapi.yaml` operations, each of which loses its
  `x-runtime-status: contract-only` marker with no other contract change.
  Migration `0068` adds `device_health` (one row per device; tenant RLS, no
  DELETE policy) and `pos_version_policy` (global per channel; readable in any
  context, writable only in the platform-admin context, no DELETE policy), with
  a domain-role grants step (`docs/operations/sql/pos-device-health-domain-grants.sql`,
  `DOMAIN_REQUIRED_GRANTS`). `posReportDeviceHeartbeat`
  (`POST /api/pos/v1/terminals/heartbeat`, device bearer): identity only from
  the guard, a closed body (an unknown or identity key is a 400 and nothing is
  stored), the server clock as `last_seen_at`, at most one stored beat per
  device per 60 s (database-throttled, concurrent beats converge to one) with
  the `HeartbeatAck` always returned and computed from the request, a stored
  beat replacing every field (an omitted one becomes NULL), a failed store
  counted `refused` and swallowed. `pos_contract_revision` is the code constant
  `POS_CONTRACT_REVISION` (1, the revision that ships the heartbeat). New
  signal `pos_device_heartbeat_total{outcome=stored|throttled|refused}`; no
  audit row per beat. `consoleListDeviceHealth` / `consoleGetDeviceHealth`
  (`/api/v1/device-health`, owner / tenant_admin / store_manager inside the
  operator store scope, non-disclosing 404, never 403): one row per device in
  scope including devices that never sent a heartbeat, liveness `online` (30
  min) / `stale` (24 h) / `offline` / `unknown` derived at read from the
  heartbeat clock, compliance derived at read against the current policy
  (semantic-version precedence, a pre-release is below its release, `unknown`
  never `ok` on missing data), `lastSeenAt` + `lastSeenSource` over the
  heartbeat and activity clocks (D-5), keyset paging by device id.
  `platformGetPosVersionPolicy` / `platformSetPosVersionPolicy`
  (`/api/v1/platform/pos-version-policy`, platform admin only: 403 for any
  other signed-in user, 401 for a bearer): compare-and-set on
  `expectedRevision`, a body equal to the stored values is a no-op 200 with no
  audit row, 409 `policy_revision_conflict`, 422 `version_order_invalid`, and
  every effective change writes one platform-scoped `pos.release_policy.changed`
  audit row (`tenant_id` NULL; `channel`, `old`, `new`) in the same
  transaction. No Admin-Console, POS or lab change; the migration is not
  applied to any lab or live database by this change.
