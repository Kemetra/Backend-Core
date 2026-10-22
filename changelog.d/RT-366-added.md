### Added
- RT-366 `[GATED]`, pending owner approval (RT-287 F3; D-Q1, D-Q2 and D-Q4
  as amended): `devices.openapi.yaml` 1.1.0-draft adds
  `GET /api/v1/devices/{deviceId}/impact?action=revoke|replace|move|retire`
  (`consoleGetDeviceImpact`, contract-only). It is the read-only lifecycle
  impact preview for Admin-Console RT-372. It returns the verdict
  (`allowed`, `allowed_with_custody_exception`, `blocked` with a
  `blockCode`, `forbidden_recovery` or `no_change`), the recovery-revoke
  `requires` list, the open shift with its server-received cash-up facts,
  the operator-session and pending-pairing-code cascade counts, and the
  replace links. The verdict maps one-to-one onto the revoke's outcome. The
  revoke and the RT-367 / RT-368 mutations must decide with the same
  evaluator. The revoke's 409 gains an optional `error.details` holding the
  preview. Additive only. No runtime or migration change.
