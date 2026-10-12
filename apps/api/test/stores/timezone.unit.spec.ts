/**
 * Spec 038 / RT-401 — store time zone shape (stage 1) and the request
 * schemas that carry it. No database: stage 2 (`pg_timezone_names`) is
 * covered by `stores.timezone.http.integration.spec.ts`.
 */
import {
  StoreCreateSchema,
  StoreUpdateSchema,
  TimezonePreviewQuerySchema,
} from "../../src/stores/dto";
import { loadOpenApiContracts } from "../../src/openapi/loader";
import {
  IANA_TIMEZONE_PATTERN,
  isIanaTimezoneShape,
} from "../../src/stores/timezone";

describe("IanaTimezone contract pattern", () => {
  it("is the same pattern the runtime shape check uses", () => {
    const stores = loadOpenApiContracts().find((c) => c.id === "stores.openapi");
    const schemas = (stores?.document as {
      components: { schemas: Record<string, { pattern?: string }> };
    }).components.schemas;
    expect(schemas["IanaTimezone"]?.pattern).toBe(IANA_TIMEZONE_PATTERN);
  });
});

describe("isIanaTimezoneShape", () => {
  it.each([
    "UTC",
    "Africa/Cairo",
    "Asia/Riyadh",
    "America/Argentina/Buenos_Aires",
    "America/Port-au-Prince",
    "America/North_Dakota/New_Salem",
    "Antarctica/McMurdo",
    "Indian/Maldives",
  ])("accepts %s", (zone) => {
    expect(isIanaTimezoneShape(zone)).toBe(true);
  });

  it.each([
    ["an abbreviation", "EET"],
    ["a POSIX offset string", "UTC+2"],
    ["an ISO offset", "+02:00"],
    ["a lower-case name", "africa/cairo"],
    ["Etc/GMT with an inverted sign", "Etc/GMT-2"],
    ["Etc/GMT", "Etc/GMT"],
    ["the posix/ tree", "posix/Africa/Cairo"],
    ["the right/ tree", "right/Africa/Cairo"],
    ["a bare area", "Africa"],
    ["a trailing slash", "Africa/"],
    ["too many segments", "America/Argentina/Buenos_Aires/X"],
    ["the empty string", ""],
    ["lower-case utc", "utc"],
    ["a legacy US alias", "US/Eastern"],
    ["a legacy Canada alias", "Canada/Pacific"],
    ["a legacy country alias", "Egypt"],
    ["Etc/UTC", "Etc/UTC"],
    ["a non-canonical area", "Mars/Olympus_Mons"],
  ])("rejects %s (%s)", (_label, zone) => {
    expect(isIanaTimezoneShape(zone)).toBe(false);
  });
});

describe("StoreCreateSchema timezone", () => {
  it("accepts a body without timezone (UTC draft default)", () => {
    expect(StoreCreateSchema.safeParse({ code: "BR-1", name: "Branch" }).success).toBe(true);
  });

  it("accepts a valid timezone", () => {
    const parsed = StoreCreateSchema.parse({
      code: "BR-1",
      name: "Branch",
      timezone: "Africa/Cairo",
    });
    expect(parsed.timezone).toBe("Africa/Cairo");
  });

  it("rejects a malformed timezone", () => {
    expect(
      StoreCreateSchema.safeParse({ code: "BR-1", name: "Branch", timezone: "EET" }).success,
    ).toBe(false);
  });
});

describe("StoreUpdateSchema timezone change", () => {
  const change = {
    timezone: "Africa/Cairo",
    expected_current_timezone: "UTC",
    timezone_impact_reviewed: true,
  };

  it("accepts the three change fields together", () => {
    expect(StoreUpdateSchema.safeParse(change).success).toBe(true);
  });

  it("accepts a change alongside name and is_active", () => {
    expect(
      StoreUpdateSchema.safeParse({ ...change, name: "New", is_active: false }).success,
    ).toBe(true);
  });

  it.each([
    ["timezone without expected_current_timezone", { timezone: "Africa/Cairo", timezone_impact_reviewed: true }],
    ["timezone without timezone_impact_reviewed", { timezone: "Africa/Cairo", expected_current_timezone: "UTC" }],
    ["expected_current_timezone alone", { name: "X", expected_current_timezone: "UTC" }],
    ["timezone_impact_reviewed alone", { name: "X", timezone_impact_reviewed: true }],
    ["timezone_impact_reviewed false", { ...change, timezone_impact_reviewed: false }],
    ["a malformed timezone", { ...change, timezone: "UTC+2" }],
    ["a malformed expected_current_timezone", { ...change, expected_current_timezone: "utc" }],
  ])("rejects %s", (_label, body) => {
    expect(StoreUpdateSchema.safeParse(body).success).toBe(false);
  });

  it("still rejects an empty body", () => {
    expect(StoreUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("still accepts name or is_active alone", () => {
    expect(StoreUpdateSchema.safeParse({ name: "X" }).success).toBe(true);
    expect(StoreUpdateSchema.safeParse({ is_active: false }).success).toBe(true);
  });
});

describe("TimezonePreviewQuerySchema", () => {
  it("accepts a valid timezone", () => {
    expect(TimezonePreviewQuerySchema.safeParse({ timezone: "Africa/Cairo" }).success).toBe(true);
  });

  it("rejects a missing, malformed or extra key", () => {
    expect(TimezonePreviewQuerySchema.safeParse({}).success).toBe(false);
    expect(TimezonePreviewQuerySchema.safeParse({ timezone: "EET" }).success).toBe(false);
    expect(
      TimezonePreviewQuerySchema.safeParse({ timezone: "UTC", other: "x" }).success,
    ).toBe(false);
  });
});
