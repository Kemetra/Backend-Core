### Added
- RT-365 `[GATED]`, pending owner approval (RT-287 F2; decisions D-Q3 and
  D-Q4 as amended, RT-287 comments 11488 / 11493 / 11499): OpenAPI contract
  `devices.openapi.yaml` (1.0.0-draft, contract-only). It defines the
  Console device registry for Admin-Console RT-371 / RT-372:
  `GET /api/v1/devices` (store and trust-state filters, exception-first
  keyset pages), `GET /api/v1/devices/{deviceId}` and
  `POST /api/v1/devices/{deviceId}/revoke` (structured reason, operator-session
  and pending-pairing-code cascade, idempotent, and the Cash Session rule:
  security revokes always succeed, a `hardware_failure` recovery revoke needs
  owner / tenant_admin, a note and an acknowledgement, every other reason is
  409 `unresolved_cash_session` while the device has an open shift). The
  custody exception is derived (a revoked device with an open shift), not
  stored. No runtime or migration change.
