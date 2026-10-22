### Added
- RT-719 `[GATED]` OpenAPI contract, owner authorization 2026-10-21 (RT-709 O-8;
  fleet baseline for the RT-713 POS compatibility matrix): which POS build each
  paired terminal runs. Additive. `pos-terminal-pairing.openapi.yaml` 1.3.0-draft
  states the "Build identity report (RT-719)" rule, and the 13 device-token
  operations (the RT-639 set) document three OPTIONAL request headers,
  `X-POS-Build-Commit`, `X-POS-App-Version` and `X-POS-Contract-Pin`, each a
  bounded closed pattern (exactly 40 `[0-9a-f]`; a semver of at most 32
  characters), no PII, never logged raw or used as a metric label; a terminal
  that sends none stays valid and reads as unknown, never a default.
  `devices.openapi.yaml` 1.5.0-draft adds the OPTIONAL, nullable `buildIdentity`
  key to `DeviceSummary` / `DeviceDetail` (absent and `null` both mean unknown).
  New `console-device-builds.openapi.yaml` 1.0.0-draft adds
  `consoleGetFleetBaseline` (the distinct builds on the active devices in scope
  with a count each and `unknownDeviceCount`, mapped onto the RT-709 C.1
  `fleet_baseline.installed` entries), `x-runtime-status: contract-only`. The
  AD-DEVICE-001 D-1 heartbeat (RT-327) stays the canonical reporting channel;
  `reportedAt` is the server clock and `lastSeenAt` is untouched. Migration
  proposal and open decisions in `docs/planning/rt-719-pos-build-identity.md`.
  No runtime, migration or POS change.
