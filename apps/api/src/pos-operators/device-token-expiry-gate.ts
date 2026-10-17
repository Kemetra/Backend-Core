/**
 * RT-370 (RT-138 L2) deployment gate for device credential expiry.
 *
 * Off (the default): every device route accepts a token whatever its
 * `devices.expires_at`; only `posRotateTerminalToken` reads it (the 7-day
 * rotate-only grace, RT-369, which is not gated by this flag).
 *
 * On (`DEVICE_TOKEN_EXPIRY_ENFORCED=true`): `DeviceRepository.findActiveBy*`
 * also requires `expires_at > now()` (database clock), so an expired device
 * is refused on every device route exactly as a revoked one is, and inside
 * its grace it can only rotate.
 *
 * Turning it on is an owner decision, after a POS release with the rotation
 * client (RT-373) is on every pilot till, and after the fleet expiry cluster
 * of migration 0040 is re-baselined
 * (`docs/operations/sql/device-expiry-rebaseline.sql`). Read per request (the
 * `isPosReturnsEnabled` convention); accepts "1", "true" or "yes",
 * case-insensitive, trimmed.
 */
export function isDeviceTokenExpiryEnforced(): boolean {
  const raw = (process.env["DEVICE_TOKEN_EXPIRY_ENFORCED"] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
