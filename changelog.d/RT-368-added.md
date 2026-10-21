### Added
- RT-368 `[GATED]`, pending owner approval (RT-287 F5; D-Q2 and D-Q4 as
  amended): `devices.openapi.yaml` 1.3.0-draft adds
  `POST /api/v1/devices/{deviceId}/retire` (`consoleRetireDevice`,
  contract-only). Retire is a closeout, never a delete: it decides with the
  shared lifecycle evaluator under the device lifecycle lock (409
  `unresolved_cash_session` / `unresolved_custody_exception` with the retire
  preview), revokes an active device first with reason `retired` through the
  revoke cascade, cancels the device's pending codes, sets the retire
  attribution and writes `pos.device.retired`. Idempotent (`already_retired`),
  terminal, no un-retire, no DELETE. No runtime or migration change.
