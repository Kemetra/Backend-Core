/**
 * Liveness and the labelled last-seen of a terminal (RT-327, AD-DEVICE-001
 * D-4 and D-5). Pure: `now` is injected, nothing is stored.
 *
 * Liveness is derived at read from the heartbeat clock only (the Backend-Core
 * server clock at the last stored beat): `online` within 30 minutes (twice
 * the 15-minute cadence), `stale` within 24 hours, `offline` beyond, and
 * `unknown` when the device has no `device_health` row. The thresholds are
 * server configuration, not contract. `lastSeenAt` (the more recent of the
 * heartbeat and the RT-370 activity clock) is display only and never an
 * input here.
 */
export const LIVENESS_VALUES = ["online", "stale", "offline", "unknown"] as const;
export type Liveness = (typeof LIVENESS_VALUES)[number];

/** `online` while the last beat is at most this old: 2 x the 15-minute cadence. */
export const LIVENESS_ONLINE_MS = 30 * 60_000;
/** `stale` while the last beat is at most this old; older is `offline`. */
export const LIVENESS_STALE_MS = 24 * 60 * 60_000;

export function deriveLiveness(heartbeatAt: Date | null, now: Date): Liveness {
  if (heartbeatAt === null) return "unknown";
  const elapsedMs = now.getTime() - heartbeatAt.getTime();
  if (elapsedMs <= LIVENESS_ONLINE_MS) return "online";
  return elapsedMs <= LIVENESS_STALE_MS ? "stale" : "offline";
}

/** Whole seconds since the last beat (floored, never negative), null without one. */
export function secondsSince(heartbeatAt: Date | null, now: Date): number | null {
  if (heartbeatAt === null) return null;
  return Math.max(0, Math.floor((now.getTime() - heartbeatAt.getTime()) / 1000));
}

export type LastSeenSource = "heartbeat" | "activity";

export interface LastSeen {
  readonly lastSeenAt: Date | null;
  readonly lastSeenSource: LastSeenSource | null;
}

/** The more recent of the two clocks and which one it is; a tie is the heartbeat. */
export function lastSeenOf(heartbeatAt: Date | null, activityAt: Date | null): LastSeen {
  if (heartbeatAt === null && activityAt === null) return { lastSeenAt: null, lastSeenSource: null };
  if (activityAt === null) return { lastSeenAt: heartbeatAt, lastSeenSource: "heartbeat" };
  if (heartbeatAt === null) return { lastSeenAt: activityAt, lastSeenSource: "activity" };
  return activityAt.getTime() > heartbeatAt.getTime()
    ? { lastSeenAt: activityAt, lastSeenSource: "activity" }
    : { lastSeenAt: heartbeatAt, lastSeenSource: "heartbeat" };
}
