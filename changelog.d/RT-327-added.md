### Added
- RT-327 step 1 `[GATED]` OpenAPI contract, owner authorization 2026-10-21
  (RT-327 comments 13216, 13232, 13279; AD-DEVICE-001 ratified with D-5 and D-7
  amended, RT-323 comment 13215): POS fleet version truth and the runtime
  compatibility signal. New `pos-device-health.openapi.yaml` 1.0.0-draft, five
  operations, all `x-runtime-status: contract-only`:
  `posReportDeviceHeartbeat` (`POST /api/pos/v1/terminals/heartbeat`, `device`
  bearer; closed snake_case body `app_version`, `update_channel`,
  `update_state`, `pending_version`, `schema_head`, `source_clock_at`; identity
  only from the guard, server-clock `last_seen_at`, at most one store per device
  per 60 s with the reply always returned; `HeartbeatAck` with the channel
  policy, `pos_contract_revision`, `min_supported_grace_until` and `compliance`
  `ok` / `below_minimum` / `unknown`), `consoleListDeviceHealth` /
  `consoleGetDeviceHealth` (devices-surface auth and 404 scope; liveness
  `online` / `stale` / `offline` / `unknown` derived at read from the heartbeat
  clock; D-5 `lastSeenAt` + `lastSeenSource` over heartbeat and activity), and
  `platformGetPosVersionPolicy` / `platformSetPosVersionPolicy` (platform admin
  only, compare-and-set, 422 on version order, audited
  `pos.release_policy.changed`). Body `app_version` has the exact
  `X-POS-App-Version` schema; the heartbeat is not an RT-719 reporting
  operation and neither records nor clears the build identity.
  `pos-terminal-pairing.openapi.yaml` 1.4.0-draft names the rotate-soon hint
  set and the 13 build identity reporting operations by operationId (fixes the
  stale rule of RT-719 comment 13271) and adds the heartbeat to the hint set
  only. `devices.openapi.yaml` is unchanged. No runtime, migration, POS or
  Console change.
