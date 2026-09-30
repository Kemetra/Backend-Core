/**
 * RT-77 deployment gate for tender acceptance on `captureSale`.
 *
 * The posting-feed INVARIANT (RT-76, RT-77 comment 10414): a work item for a
 * tender-bearing sale must never be offered to a Connector that cannot settle
 * it — a pre-RT-78 Connector posts it UNPAID and acks `posted`, which is
 * terminal. So tenders are accepted only once the API runs with
 * `POS_SALE_TENDERS_ENABLED=true`, a deploy step AFTER RT-78 is deployed.
 * Until then the capture pipe validates with the pre-RT-77 strict schema and a
 * body carrying `tenders` is the same 400 it is today — nothing is recorded.
 * Read per request (the `isPosReturnsEnabled` convention); accepts "1",
 * "true" or "yes", case-insensitive, trimmed.
 */
export function isPosSaleTendersEnabled(): boolean {
  const raw = (process.env["POS_SALE_TENDERS_ENABLED"] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
