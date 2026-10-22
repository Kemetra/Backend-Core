/**
 * RT-327: the closed heartbeat body (AD-DEVICE-001 D-1) and the policy change
 * body / channel path. Mirrors `pos-device-health.openapi.yaml`.
 */
import {
  ChannelParamSchema,
  HeartbeatReportSchema,
  PosVersionPolicyChangeSchema,
} from "../../src/device-health/dto";

const FULL = {
  app_version: "1.4.0",
  update_channel: "stable",
  update_state: "idle",
  pending_version: "1.4.1",
  schema_head: "0042_local_outbox",
  source_clock_at: "2026-10-21T10:00:00.000Z",
};

describe("HeartbeatReportSchema", () => {
  it("accepts a full beat and an empty one", () => {
    expect(HeartbeatReportSchema.safeParse(FULL).success).toBe(true);
    expect(HeartbeatReportSchema.safeParse({}).success).toBe(true);
  });

  it("accepts null where the contract allows it, as the same as omitting", () => {
    const nulls = {
      app_version: null,
      update_channel: null,
      update_state: null,
      pending_version: null,
      schema_head: null,
      source_clock_at: null,
    };
    expect(HeartbeatReportSchema.safeParse(nulls).success).toBe(true);
  });

  it.each(["device_id", "tenant_id", "store_id", "last_seen_at", "hostname", "anything"])(
    "refuses the unknown or identity key %s",
    (key) => {
      expect(HeartbeatReportSchema.safeParse({ ...FULL, [key]: "x" }).success).toBe(false);
    },
  );

  it.each([
    ["app_version", "1.4"],
    ["app_version", "1.4.0+build.5"],
    ["app_version", `1.4.0-${"a".repeat(30)}`],
    ["app_version", 14],
    ["update_channel", "beta"],
    ["update_state", "sleeping"],
    ["pending_version", "latest"],
    ["schema_head", "../etc/passwd"],
    ["schema_head", "x".repeat(65)],
    ["schema_head", ""],
    ["source_clock_at", "yesterday"],
    ["source_clock_at", 1_700_000_000],
  ])("refuses %s = %j", (key, value) => {
    expect(HeartbeatReportSchema.safeParse({ ...FULL, [key]: value }).success).toBe(false);
  });

  it("refuses a body that is not an object", () => {
    expect(HeartbeatReportSchema.safeParse([]).success).toBe(false);
    expect(HeartbeatReportSchema.safeParse("beat").success).toBe(false);
    expect(HeartbeatReportSchema.safeParse(null).success).toBe(false);
  });
});

describe("ChannelParamSchema", () => {
  it("accepts the three channels and nothing else", () => {
    for (const channel of ["lab", "canary", "stable"]) expect(ChannelParamSchema.safeParse(channel).success).toBe(true);
    for (const channel of ["beta", "Stable", "", "stable "]) expect(ChannelParamSchema.safeParse(channel).success).toBe(false);
  });
});

describe("PosVersionPolicyChangeSchema", () => {
  const BODY = {
    latestVersion: "1.5.0",
    recommendedVersion: "1.4.2",
    minSupportedVersion: "1.4.0",
    minSupportedGraceUntil: "2026-11-01T00:00:00.000Z",
    expectedRevision: null,
  };

  it("accepts a full change with a null or positive expectedRevision", () => {
    expect(PosVersionPolicyChangeSchema.safeParse(BODY).success).toBe(true);
    expect(PosVersionPolicyChangeSchema.safeParse({ ...BODY, expectedRevision: 3 }).success).toBe(true);
  });

  it.each(["latestVersion", "recommendedVersion", "minSupportedVersion", "minSupportedGraceUntil", "expectedRevision"])(
    "refuses a body missing %s",
    (key) => {
      const { [key as keyof typeof BODY]: _omitted, ...rest } = BODY;
      expect(PosVersionPolicyChangeSchema.safeParse(rest).success).toBe(false);
    },
  );

  it("refuses unknown keys, bad versions, a bad instant and a non-positive revision", () => {
    expect(PosVersionPolicyChangeSchema.safeParse({ ...BODY, note: "why" }).success).toBe(false);
    expect(PosVersionPolicyChangeSchema.safeParse({ ...BODY, latestVersion: "1.5" }).success).toBe(false);
    expect(PosVersionPolicyChangeSchema.safeParse({ ...BODY, minSupportedGraceUntil: "soon" }).success).toBe(false);
    expect(PosVersionPolicyChangeSchema.safeParse({ ...BODY, expectedRevision: 0 }).success).toBe(false);
    expect(PosVersionPolicyChangeSchema.safeParse({ ...BODY, expectedRevision: 1.5 }).success).toBe(false);
  });
});
