### Added
- RT-366: runtime for the device impact preview. `consoleGetDeviceImpact`
  ships unchanged on the wire and loses `x-runtime-status: contract-only`.
  One pure evaluator (`device-lifecycle.evaluator.ts`) decides
  revoke / replace / move / retire, and `decideRevoke` is now that verdict
  plus the body's note and acknowledgement checks (revoke behaviour
  unchanged). A revoke with `other` previews `requires: [note]`, matching
  the body schema's 400. The preview reads the device, its open shift, the shift's
  server-received cash-up facts and the cascade counts in one statement,
  over the same predicates the revoke's cascade updates. It takes no lock and
  writes nothing (audited `devices.impact_read`). The revoke now decides from
  that same read under its locks, and its 409 carries the refused state's
  preview as `error.details`. No migration.
