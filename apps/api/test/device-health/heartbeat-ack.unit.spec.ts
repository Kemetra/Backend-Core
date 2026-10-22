/**
 * RT-327: the `HeartbeatAck` is computed from this request and the current
 * policy; no policy means `unknown`, never `ok`; the contract revision is the
 * code constant.
 */
import { buildHeartbeatAck, type ChannelPolicy } from "../../src/device-health/heartbeat-ack";
import { POS_CONTRACT_REVISION } from "../../src/device-health/pos-contract-revision";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const GRACE = new Date("2026-11-01T00:00:00.000Z");
const POLICY: ChannelPolicy = {
  channel: "stable",
  latestVersion: "1.5.0",
  recommendedVersion: "1.4.2",
  minSupportedVersion: "1.4.0",
  minSupportedGraceUntil: GRACE,
  revision: 3,
};

describe("POS_CONTRACT_REVISION", () => {
  it("is an integer inside the contract's bounds (never below 1)", () => {
    expect(Number.isInteger(POS_CONTRACT_REVISION)).toBe(true);
    expect(POS_CONTRACT_REVISION).toBeGreaterThanOrEqual(1);
    expect(POS_CONTRACT_REVISION).toBeLessThanOrEqual(2_147_483_647);
  });
});

describe("buildHeartbeatAck", () => {
  it("carries the policy, the revision, the grace instant and an ok verdict", () => {
    expect(buildHeartbeatAck({ now: NOW, appVersion: "1.4.1", updateChannel: "stable", policy: POLICY })).toEqual({
      acknowledged_at: "2026-10-22T12:00:00.000Z",
      pos_contract_revision: POS_CONTRACT_REVISION,
      policy: {
        channel: "stable",
        latest_version: "1.5.0",
        recommended_version: "1.4.2",
        min_supported_version: "1.4.0",
        policy_revision: 3,
      },
      min_supported_grace_until: "2026-11-01T00:00:00.000Z",
      compliance: "ok",
    });
  });

  it("is below_minimum under the minimum", () => {
    const ack = buildHeartbeatAck({ now: NOW, appVersion: "1.3.9", updateChannel: "stable", policy: POLICY });
    expect(ack.compliance).toBe("below_minimum");
    expect(ack.min_supported_grace_until).toBe("2026-11-01T00:00:00.000Z");
  });

  it("is unknown when the beat reported no version", () => {
    const ack = buildHeartbeatAck({ now: NOW, appVersion: null, updateChannel: "stable", policy: POLICY });
    expect(ack.compliance).toBe("unknown");
    expect(ack.policy).not.toBeNull();
  });

  it("has a null policy, a null grace and unknown compliance when no policy applies", () => {
    expect(buildHeartbeatAck({ now: NOW, appVersion: "1.4.0", updateChannel: "stable", policy: null })).toEqual({
      acknowledged_at: "2026-10-22T12:00:00.000Z",
      pos_contract_revision: POS_CONTRACT_REVISION,
      policy: null,
      min_supported_grace_until: null,
      compliance: "unknown",
    });
  });

  it("still answers a beat with no channel (no policy is read for it)", () => {
    const ack = buildHeartbeatAck({ now: NOW, appVersion: "1.4.0", updateChannel: null, policy: null });
    expect(ack.compliance).toBe("unknown");
    expect(ack.policy).toBeNull();
  });
});
