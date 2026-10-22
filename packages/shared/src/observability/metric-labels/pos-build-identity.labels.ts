/**
 * POS build identity report — RT-719. Increments once per build identity store
 * that took effect on a reporting operation: `outcome` is the closed set
 * {recorded, unknown, failed}. `recorded` stored a valid commit, `unknown`
 * cleared the identity (no valid commit), `failed` is a store that failed
 * (counted and swallowed). NEVER a commit, version, pin, device or tenant
 * label: those are on `devices` and a cardinality + §XIV hazard.
 */
export const METRIC_LABELS: Readonly<Record<string, readonly string[]>> = {
  pos_build_identity_report_total: ["outcome"],
};
