/**
 * RT-327 (AD-DEVICE-001 D-2): semantic-version precedence and the server's
 * compliance verdict. `ok` / `below_minimum` / `unknown`; never `ok` on
 * missing data. A pre-release is lower than its release.
 */
import { deriveCompliance } from "../../src/device-health/compliance";
import { compareVersions, isPolicyOrderValid, parseAppVersion } from "../../src/device-health/semver";

function cmp(a: string, b: string): number {
  const left = parseAppVersion(a);
  const right = parseAppVersion(b);
  if (left === null || right === null) throw new Error(`unparsable fixture: ${a} / ${b}`);
  return compareVersions(left, right);
}

describe("parseAppVersion", () => {
  it.each(["1.4.0", "0.0.0", "10.20.30", "1.4.0-rc.1", "1.4.0-alpha", "1.4.0-0.3.7", "1.4.0-x-y-z.--", "1.0.0-0a", "1.0.0-a01", "1.0.0-0"])(
    "accepts %s",
    (value) => {
      expect(parseAppVersion(value)).not.toBeNull();
    },
  );

  it.each([
    "",
    "1.4",
    "1a4a0",
    "1.4.0.1",
    "01.4.0",
    "1.04.0",
    "1.4.00",
    "v1.4.0",
    "1.4.0+build.5",
    "1.4.0-",
    "1.4.0-rc..1",
    "1.0.0-01",
    "1.0.0-rc.01",
    "1.4.0 ",
    "1.4.0-é",
    `1.4.0-${"a".repeat(30)}`,
  ])("refuses %j", (value) => {
    expect(parseAppVersion(value)).toBeNull();
  });
});

describe("compareVersions (semver precedence)", () => {
  it("orders numerically, not lexically", () => {
    expect(cmp("1.10.0", "1.9.0")).toBe(1);
    expect(cmp("2.0.0", "10.0.0")).toBe(-1);
    expect(cmp("1.4.10", "1.4.9")).toBe(1);
  });

  it("compares numbers wider than a safe integer exactly", () => {
    expect(cmp("1.0.99999999999999999999", "1.0.100000000000000000000")).toBe(-1);
  });

  it("is equal for the same version", () => {
    expect(cmp("1.4.0", "1.4.0")).toBe(0);
    expect(cmp("1.4.0-rc.1", "1.4.0-rc.1")).toBe(0);
  });

  it("puts a pre-release below its release", () => {
    expect(cmp("1.4.0-rc.1", "1.4.0")).toBe(-1);
    expect(cmp("1.4.0", "1.4.0-rc.1")).toBe(1);
  });

  it("follows the semver 2.0 pre-release ladder", () => {
    const ladder = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 0; i < ladder.length - 1; i += 1) {
      expect(cmp(ladder[i] as string, ladder[i + 1] as string)).toBe(-1);
      expect(cmp(ladder[i + 1] as string, ladder[i] as string)).toBe(1);
    }
  });

  it("ranks numeric identifiers below alphanumeric ones", () => {
    expect(cmp("1.0.0-1", "1.0.0-a")).toBe(-1);
  });
});

describe("isPolicyOrderValid (min <= recommended <= latest)", () => {
  const p = (v: string) => {
    const parsed = parseAppVersion(v);
    if (parsed === null) throw new Error(v);
    return parsed;
  };

  it("accepts equal and ascending values", () => {
    expect(isPolicyOrderValid({ min: p("1.4.0"), recommended: p("1.4.0"), latest: p("1.4.0") })).toBe(true);
    expect(isPolicyOrderValid({ min: p("1.3.0"), recommended: p("1.4.2"), latest: p("1.5.0") })).toBe(true);
  });

  it("refuses a minimum above the recommended, or a recommended above the latest", () => {
    expect(isPolicyOrderValid({ min: p("1.5.0"), recommended: p("1.4.0"), latest: p("1.6.0") })).toBe(false);
    expect(isPolicyOrderValid({ min: p("1.3.0"), recommended: p("1.7.0"), latest: p("1.6.0") })).toBe(false);
  });

  it("orders pre-releases below their release", () => {
    expect(isPolicyOrderValid({ min: p("1.4.0"), recommended: p("1.4.0-rc.1"), latest: p("1.4.0") })).toBe(false);
  });
});

describe("deriveCompliance", () => {
  const base = { appVersion: "1.4.0", updateChannel: "stable", minSupportedVersion: "1.4.0" } as const;

  it("is ok at and above the minimum", () => {
    expect(deriveCompliance(base)).toBe("ok");
    expect(deriveCompliance({ ...base, appVersion: "1.4.1" })).toBe("ok");
    expect(deriveCompliance({ ...base, appVersion: "2.0.0" })).toBe("ok");
  });

  it("is below_minimum under the minimum, a pre-release of the minimum included", () => {
    expect(deriveCompliance({ ...base, appVersion: "1.3.9" })).toBe("below_minimum");
    expect(deriveCompliance({ ...base, appVersion: "1.4.0-rc.1" })).toBe("below_minimum");
  });

  it("is unknown, never ok, on missing data", () => {
    expect(deriveCompliance({ ...base, appVersion: null })).toBe("unknown");
    expect(deriveCompliance({ ...base, updateChannel: null })).toBe("unknown");
    expect(deriveCompliance({ ...base, minSupportedVersion: null })).toBe("unknown");
  });

  it("is unknown for a version that is not a valid semantic version", () => {
    expect(deriveCompliance({ ...base, appVersion: "banana" })).toBe("unknown");
    expect(deriveCompliance({ ...base, appVersion: "1.4.0+build.5" })).toBe("unknown");
    expect(deriveCompliance({ ...base, minSupportedVersion: "garbage" })).toBe("unknown");
    // SemVer forbids leading zeros in a numeric pre-release identifier.
    expect(deriveCompliance({ ...base, appVersion: "1.4.1-01" })).toBe("unknown");
  });
});
