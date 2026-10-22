/**
 * RT-327 (AD-DEVICE-001 D-4, D-5): liveness derived at read from the heartbeat
 * clock only, and the labelled `lastSeenAt` over the heartbeat and activity
 * clocks.
 */
import {
  LIVENESS_ONLINE_MS,
  LIVENESS_STALE_MS,
  deriveLiveness,
  lastSeenOf,
  secondsSince,
} from "../../src/device-health/liveness";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("thresholds", () => {
  it("are 30 minutes and 24 hours", () => {
    expect(LIVENESS_ONLINE_MS).toBe(30 * MINUTE);
    expect(LIVENESS_STALE_MS).toBe(24 * HOUR);
  });
});

describe("deriveLiveness", () => {
  it("is unknown without a heartbeat", () => {
    expect(deriveLiveness(null, NOW)).toBe("unknown");
  });

  it("is online within 30 minutes, inclusive", () => {
    expect(deriveLiveness(ago(0), NOW)).toBe("online");
    expect(deriveLiveness(ago(30 * MINUTE), NOW)).toBe("online");
  });

  it("is stale beyond 30 minutes up to 24 hours, inclusive", () => {
    expect(deriveLiveness(ago(30 * MINUTE + 1), NOW)).toBe("stale");
    expect(deriveLiveness(ago(24 * HOUR), NOW)).toBe("stale");
  });

  it("is offline beyond 24 hours", () => {
    expect(deriveLiveness(ago(24 * HOUR + 1), NOW)).toBe("offline");
  });

  it("treats a beat stamped after now (clock step) as online, never negative", () => {
    expect(deriveLiveness(new Date(NOW.getTime() + 5_000), NOW)).toBe("online");
  });
});

describe("secondsSince", () => {
  it("is null without a heartbeat", () => {
    expect(secondsSince(null, NOW)).toBeNull();
  });

  it("floors to whole seconds and never goes below zero", () => {
    expect(secondsSince(ago(61_999), NOW)).toBe(61);
    expect(secondsSince(new Date(NOW.getTime() + 5_000), NOW)).toBe(0);
  });
});

describe("lastSeenOf (D-5)", () => {
  const hb = ago(10 * MINUTE);
  const act = ago(2 * MINUTE);

  it("is null with a null source when both clocks are null", () => {
    expect(lastSeenOf(null, null)).toEqual({ lastSeenAt: null, lastSeenSource: null });
  });

  it("labels a lone clock with its source", () => {
    expect(lastSeenOf(hb, null)).toEqual({ lastSeenAt: hb, lastSeenSource: "heartbeat" });
    expect(lastSeenOf(null, act)).toEqual({ lastSeenAt: act, lastSeenSource: "activity" });
  });

  it("takes the more recent clock", () => {
    expect(lastSeenOf(hb, act)).toEqual({ lastSeenAt: act, lastSeenSource: "activity" });
    expect(lastSeenOf(act, hb)).toEqual({ lastSeenAt: act, lastSeenSource: "heartbeat" });
  });

  it("prefers the heartbeat on a tie", () => {
    expect(lastSeenOf(hb, new Date(hb.getTime()))).toEqual({ lastSeenAt: hb, lastSeenSource: "heartbeat" });
  });
});
