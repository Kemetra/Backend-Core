/**
 * Pure predicate for whether module-load instrumentation should call startOtel.
 * Does not import instrumentation.ts (that module starts the SDK as a side effect).
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { shouldStartOtel } from "../../src/observability/should-start-otel";

describe("shouldStartOtel", () => {
  it("starts when the disable env vars are unset", () => {
    expect(shouldStartOtel({})).toBe(true);
  });

  it("skips when DP2_OTEL_DISABLED is 1", () => {
    expect(shouldStartOtel({ DP2_OTEL_DISABLED: "1" })).toBe(false);
  });

  it("skips when DP2_OTEL_DISABLED is true", () => {
    expect(shouldStartOtel({ DP2_OTEL_DISABLED: "true" })).toBe(false);
  });

  it("skips when OTEL_SDK_DISABLED is true", () => {
    expect(shouldStartOtel({ OTEL_SDK_DISABLED: "true" })).toBe(false);
  });

  it("starts when the flags are set to non-disabling values", () => {
    expect(shouldStartOtel({ DP2_OTEL_DISABLED: "0" })).toBe(true);
    expect(shouldStartOtel({ DP2_OTEL_DISABLED: "false" })).toBe(true);
    expect(shouldStartOtel({ OTEL_SDK_DISABLED: "false" })).toBe(true);
    expect(shouldStartOtel({ OTEL_SDK_DISABLED: "1" })).toBe(true);
    expect(
      shouldStartOtel({ DP2_OTEL_DISABLED: "", OTEL_SDK_DISABLED: "" }),
    ).toBe(true);
  });

  it("skips when either flag disables startup", () => {
    expect(
      shouldStartOtel({
        DP2_OTEL_DISABLED: "1",
        OTEL_SDK_DISABLED: "false",
      }),
    ).toBe(false);
    expect(
      shouldStartOtel({
        DP2_OTEL_DISABLED: "false",
        OTEL_SDK_DISABLED: "true",
      }),
    ).toBe(false);
  });

  it("treats trimmed, case-insensitive true like the OTel SDK boolean parser", () => {
    expect(shouldStartOtel({ OTEL_SDK_DISABLED: " TRUE " })).toBe(false);
    expect(shouldStartOtel({ DP2_OTEL_DISABLED: "True" })).toBe(false);
    expect(shouldStartOtel({ DP2_OTEL_DISABLED: " 1 " })).toBe(false);
  });
});

describe("instrumentation call sites", () => {
  const repoRoot = resolve(__dirname, "../../../..");

  it.each([
    "apps/api/src/instrumentation.ts",
    "apps/worker/src/instrumentation.ts",
  ])("%s calls shouldStartOtel before startOtel", (rel) => {
    const text = readFileSync(resolve(repoRoot, rel), "utf8");
    expect(text).toMatch(
      /if\s*\(\s*shouldStartOtel\(process\.env\)\)\s*\{\s*startOtel\(/,
    );
  });
});
