/**
 * POS device heartbeat — RT-327 (AD-DEVICE-001 D-1). Increments once per POS
 * heartbeat that reaches the store step: `outcome` is the closed set
 * {stored, throttled, refused}. `stored` wrote the device's row, `throttled`
 * fell inside the 60-second window and wrote nothing, `refused` is a store
 * that failed (counted and swallowed: the terminal still gets its 200). NEVER
 * a version, channel, device or tenant label: those are on `device_health` and
 * are a cardinality + §XIV hazard.
 */
export const METRIC_LABELS: Readonly<Record<string, readonly string[]>> = {
  pos_device_heartbeat_total: ["outcome"],
};
