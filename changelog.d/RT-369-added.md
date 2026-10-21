### Added
- RT-369 `[GATED]`, pending owner approval (RT-287 F6; RT-138 L4 / DL-4,
  owner-ratified 2026-10-02 with the grace clarification):
  `pos-terminal-pairing.openapi.yaml` 1.2.0-draft adds
  `POST /api/pos/v1/terminals/rotate` (`posRotateTerminalToken`,
  contract-only), authenticated by the device bearer. It returns a new token
  once (SHA-256 at rest), `expires_at = now() + 90 days`, the unchanged
  `terminal_id` and the hint `rotate_after = expires_at - 15 days`. The
  presented token stays valid for a 10-minute overlap on every
  device-authenticated route; a retry with the previous token replaces the
  undelivered new token without extending the window. An expired, unrevoked
  device may rotate for 7 days after `expires_at` (the only route that reads
  expiry until RT-370; literal L4, not gated on the enforcement flag); a
  revoked or retired device never. One generic 401, a per-device rotation
  budget (429 `RATE_LIMITED` with `Retry-After`), required non-replayable
  `Idempotency-Key` scoped to the device (409 `idempotency_key_conflict` on
  a same-key retry), `Cache-Control: no-store` / `Pragma: no-cache` on the
  200, its own `RotateError` code set, the client rules (one rotation in
  flight, first-start rotation), and the `pos.device.rotated` /
  `pos.device.rotation_rejected` audit allowlists (reasons `revoked`,
  `retired`, `grace_elapsed`, `previous_expired`, `token_replaced`).
  Decisions coordinator-approved under owner delegation 2026-10-17.
  Additive; no runtime or migration change.
