/**
 * RT-418 deployment gate for responsibility-bearing work items on the posting
 * feed (`erpnext-connector/posting-feed.yaml` 1.8.0-draft, RT-417 ROLLOUT
 * ORDER, Connector first).
 *
 * A Connector that predates RT-419 would post a credit sale against the
 * STORE's Customer (or unpaid) and ack `posted`, which is terminal and the
 * wrong debtor. So a `sale_post` of a sale with responsibilities is held (not
 * offered) until the API runs with `ERPNEXT_FEED_RESPONSIBILITIES_ENABLED=true`,
 * a deploy step AFTER the Connector supports RT-419. Capture accepts
 * responsibilities regardless; only the feed waits.
 *
 * Lifting the hold: a held row keeps its feed `sequence`, and a Connector
 * whose cursor already moved past it would never see it. Turning the gate on
 * must therefore re-head the held rows (`UPDATE erpnext_posting_status SET
 * sequence = DEFAULT` for the pending responsibility-bearing sale_post rows,
 * under the tenant's feed sequence lock), in the same release step.
 *
 * Read per request; accepts "1", "true" or "yes", case-insensitive, trimmed
 * (the `isPosSaleTendersEnabled` convention).
 */
export function isFeedResponsibilitiesEnabled(): boolean {
  const raw = (process.env["ERPNEXT_FEED_RESPONSIBILITIES_ENABLED"] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
