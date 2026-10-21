### Added
- RT-367 `[GATED]` (RT-287 F4 + F9; D-Q1 and D-Q4 as amended; decisions C1
  and C2 owner-approved 2026-10-17, the PR itself pending the owner's GATED
  approval): `devices.openapi.yaml` 1.2.0-draft adds the Console pairing
  codes, contract-only: `POST /api/v1/pairing-codes`
  (`consoleIssuePairingCode`; required non-replayable `Idempotency-Key`; the
  code is returned once and never stored), `GET /api/v1/pairing-codes`
  (`consoleListPairingCodes`, live pending codes in scope) and
  `POST /api/v1/pairing-codes/{pairingCodeId}/cancel`
  (`consoleCancelPairingCode`, idempotent). A code with `replacesDeviceId`
  replaces (same store) or moves (another store) the device; the issue and
  the redemption decide with the shared lifecycle evaluator, and a blocked
  replace / move is 409 with the preview; a device is replaced at most once
  (409 `replacement_already_pending` / `device_already_replaced`).
  `pos-terminal-pairing.openapi.yaml` 1.1.0-draft: `terminal_id` survives
  rotation, not re-pairing; the token is no longer "long-lived"; `expires_at`
  is populated; and a new 409 `REPLACEMENT_BLOCKED` for the pair-time Cash
  Session re-check. That last one is NOT additive: it is a POS-visible value
  added to the closed `error.code` enum, which oasdiff grades as breaking
  (cross-repo POS contract change; POS must handle `REPLACEMENT_BLOCKED`,
  tracked as RT-591). The owner approved it on 2026-10-17, and
  `tools/oasdiff/breaking-ignore.txt` acknowledges the five findings. No
  runtime or migration change.
