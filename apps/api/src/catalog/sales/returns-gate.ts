/**
 * RT-73 AC4 deployment gate for `recordReturn`.
 *
 * The Connector rejects an unknown `reversalKind` as an unparseable work-item
 * (acked `permanently_rejected`), so a return recorded before the Connector
 * supports `return` (RT-16) would be dead-lettered, and one recorded before the
 * Connector supports settlement (RT-78) would post as an outstanding credit
 * note although cash was paid out (RT-76 feed INVARIANT). Turn the gate on
 * only after BOTH have shipped. The route therefore stays
 * off — 404 `not_found`, nothing recorded — until the API runs with
 * `POS_RETURNS_ENABLED=true`. Read per request (the `isOutboxAuditEnabled`
 * convention); accepts "1", "true" or "yes", case-insensitive, trimmed.
 */
export function isPosReturnsEnabled(): boolean {
  const raw = (process.env["POS_RETURNS_ENABLED"] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
