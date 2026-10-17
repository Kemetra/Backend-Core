/**
 * RT-631 (OBS-1 §1): `version` is the release SHA12, and Sentry `release`
 * uses the same value. One resolver feeds both, so they cannot drift.
 */
import { resolveReleaseVersion } from "../../src/observability/release-version";
import { resolveSentryConfig } from "../../src/observability/sentry";

const SHA40 = "36bb0c7e1f2a3b4c5d6e7f8091a2b3c4d5e6f708";
const SHA12 = SHA40.slice(0, 12);
const VALID_DSN = "https://abc123@o1.ingest.de.sentry.io/42";

describe("resolveReleaseVersion", () => {
  it("returns a SHA12 as is", () => {
    expect(resolveReleaseVersion({ SENTRY_RELEASE: SHA12 })).toBe(SHA12);
  });

  it("truncates a full 40-char commit SHA to 12", () => {
    expect(resolveReleaseVersion({ SENTRY_RELEASE: SHA40 })).toBe(SHA12);
  });

  it("trims surrounding whitespace", () => {
    expect(resolveReleaseVersion({ SENTRY_RELEASE: `  ${SHA12}\n` })).toBe(SHA12);
  });

  it.each([
    ["unset", undefined],
    ["blank", "   "],
    ["a short SHA", "abc1234"],
    ["uppercase hex", SHA12.toUpperCase()],
    ["a release tag", `backend-core-${SHA12}`],
    ["13 hex chars", `${SHA12}a`],
    ["non-hex", "zzzzzzzzzzzz"],
  ])("returns undefined for %s", (_label, value) => {
    expect(resolveReleaseVersion({ SENTRY_RELEASE: value })).toBeUndefined();
  });

  it("feeds Sentry `release` with the same value", () => {
    const env = { SENTRY_DSN: VALID_DSN, SENTRY_RELEASE: SHA40 };
    expect(resolveSentryConfig(env)?.release).toBe(resolveReleaseVersion(env));
  });
});
