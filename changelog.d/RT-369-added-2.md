### Added
- RT-369: runtime for the device token rotation (`DeviceRotationModule`).
  `posRotateTerminalToken` ships unchanged on the wire and loses
  `x-runtime-status: contract-only`. `DeviceRotationAuthGuard` (a reviewed
  device-bearer composite) resolves the current or previous hash, applies
  the rotation decision (retired, revoked, previous_expired /
  token_replaced, 7-day grace) and writes `pos.device.rotation_rejected`
  for a known token it refuses; `PosWriteRateLimitGuard` applies the
  per-device `posRotateDevice` budget (10 / hour, 429 `RATE_LIMITED`); the
  200 is sent `Cache-Control: no-store` / `Pragma: no-cache`; every
  `rotation_rejected` row is written in its own transaction and spends from
  a separate per-device `posRotateRefusalAudit` budget first (20 / hour;
  once spent: still 401, no row, a warn log), so a refused token never
  429s a valid rotation; the
  service re-decides under the device lifecycle lock and the row lock
  (constant-time hash compare), swaps the token and writes
  `pos.device.rotated`. Every device-authenticated route now accepts the
  previous token until `previous_valid_until` (`DeviceRepository`).
  `@Idempotent` gains the opt-in `clientScope: "device"`, so rotate keys are
  per device; every other route keeps its store key. No migration (0040
  already has the rotation columns) and no grant change (the domain role
  already holds SELECT / UPDATE on `devices`).
