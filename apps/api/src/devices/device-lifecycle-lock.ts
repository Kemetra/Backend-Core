/**
 * RT-365 — the device lifecycle lock: a transaction-scoped advisory lock
 * keyed on (tenant, device), taken by every path that changes whether a
 * device may hold an open shift:
 *
 *   - the revoke (`DevicesService.revoke`), before it locks the device row
 *     and checks for an open shift;
 *   - a cash-up shift open (`ShiftCashUpService.openShift`) and an
 *     audit-ingest `shift.open` (`PosAuditEventsService`), before they re-read
 *     `revoked_at` and insert.
 *
 * Whichever takes it first wins: a revoke that commits first is seen by the
 * open's re-read (READ COMMITTED: the next statement after the wait sees it),
 * so a shift never opens on a revoked device; an open that commits first is
 * seen by the revoke's open-shift check. The device token was checked at the
 * request's start, so without this a shift open already past authentication
 * could land after the revoke (RT-365 review, Codex P1).
 *
 * An advisory lock needs no table privilege, so the shift-open path does not
 * depend on UPDATE on `devices` (an explicit row lock would). The repo
 * convention (`hashtextextended(key, 0)`, as the sale reprint and cashier
 * admission locks): a hash collision only serializes two unrelated devices.
 */
import type { PoolClient } from "pg";

export async function lockDeviceLifecycle(
  client: PoolClient,
  device: { readonly tenantId: string; readonly deviceId: string },
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `device_lifecycle:${device.tenantId.toLowerCase()}:${device.deviceId.toLowerCase()}`,
  ]);
}
