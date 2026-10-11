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
  return isEnvFlagOn("POS_SALE_TENDERS_ENABLED");
}

/**
 * RT-360 deployment gate for same-method split tenders (contract RT-359).
 *
 * The posting feed MUST NOT offer a sale carrying two tenders of one method
 * until the Connector has shown it settles such a sale exactly in ERPNext
 * (RT-361). So capture accepts them only once the API runs with
 * `POS_SALE_TENDERS_SAME_METHOD_ENABLED=true`, a deploy step AFTER RT-361, and
 * only while `POS_SALE_TENDERS_ENABLED` is on too. Until then at most one
 * tender per method is accepted, as before. Same parsing as above.
 */
export function isPosSaleTendersSameMethodEnabled(): boolean {
  return isEnvFlagOn("POS_SALE_TENDERS_SAME_METHOD_ENABLED");
}

function isEnvFlagOn(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
