### Added
- RT-365: runtime for the Console device registry (`DevicesModule`). The
  three operations ship unchanged on the wire and lose `x-runtime-status:
  contract-only`. Dashboard session, roles owner / tenant_admin /
  store_manager, the operator store scope, one non-disclosing 404 body. The
  revoke locks the device row, applies the RT-287 D-Q4 (amended) decision,
  sets the revoke fields, revokes the device's live `pos_operator` tokens,
  cancels its pending pairing codes and writes `pos.device.revoked` (RT-135
  allowlist: reason, counts, custody flag, shift id) in one transaction; it
  never writes a shift or cash fact. `packages/db` now declares the 0040
  device lifecycle columns (0040 must be applied before this deploys), and the
  read-down audits (`catalog.snapshot.read`, `catalog.deltas.read`) carry the
  reading `device_id` (RT-138 L8). The revoke, the cash-up shift open and the
  audit-ingest `shift.open` share a per-device advisory lock
  (`device-lifecycle-lock.ts`), and a shift open rechecks `revoked_at` under
  it, so a shift never opens on a device after its revoke commits (the
  cash-up open is refused with the revoked-device 401). Projections carry
  `lastSeenSource` (`activity` when `lastSeenAt` is set). No migration.
