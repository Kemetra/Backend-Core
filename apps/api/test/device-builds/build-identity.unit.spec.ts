/**
 * RT-719 (RT-709 decision O-8): reading the three optional build identity
 * headers (`pos-terminal-pairing.openapi.yaml`, "Build identity report").
 *
 * A valid `X-POS-Build-Commit` (40 lower-case hex) is the identity anchor.
 * `X-POS-App-Version` and `X-POS-Contract-Pin` are kept when valid and are
 * otherwise null. Without a valid commit the identity is unknown (null) and the
 * other two are ignored. A value that is longer, has another character, does not
 * match its form or is repeated is treated as missing: never truncated,
 * normalised or repaired, and never an error.
 */
import type { IncomingHttpHeaders } from "node:http";

import { parseBuildIdentityHeaders } from "../../src/pos-operators/build-identity";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PIN = "fedcba9876543210fedcba9876543210fedcba98";

const h = (over: IncomingHttpHeaders): IncomingHttpHeaders => over;

describe("parseBuildIdentityHeaders", () => {
  it("reads a full report", () => {
    expect(
      parseBuildIdentityHeaders(h({ "x-pos-build-commit": COMMIT, "x-pos-app-version": "1.4.0-rc.1", "x-pos-contract-pin": PIN })),
    ).toEqual({ commit: COMMIT, appVersion: "1.4.0-rc.1", contractPin: PIN });
  });

  it("keeps a commit alone, with the other two null", () => {
    expect(parseBuildIdentityHeaders(h({ "x-pos-build-commit": COMMIT }))).toEqual({ commit: COMMIT, appVersion: null, contractPin: null });
  });

  it("is unknown (null) without any header, as an older build sends", () => {
    expect(parseBuildIdentityHeaders(h({}))).toBeNull();
    expect(parseBuildIdentityHeaders(h({ authorization: "Bearer x" }))).toBeNull();
  });

  it("ignores the version and the pin without a valid commit", () => {
    expect(parseBuildIdentityHeaders(h({ "x-pos-app-version": "1.4.0", "x-pos-contract-pin": PIN }))).toBeNull();
    expect(parseBuildIdentityHeaders(h({ "x-pos-build-commit": "nope", "x-pos-app-version": "1.4.0", "x-pos-contract-pin": PIN }))).toBeNull();
  });

  it.each([
    ["too short", COMMIT.slice(0, 39)],
    ["too long", `${COMMIT}0`],
    ["upper case", COMMIT.toUpperCase()],
    ["a non-hex character", `${COMMIT.slice(0, 39)}g`],
    ["abbreviated", COMMIT.slice(0, 7)],
    ["padded with a space", ` ${COMMIT}`],
    ["repeated (the server joins the values)", `${COMMIT}, ${PIN}`],
    ["empty", ""],
  ])("treats a commit that is %s as missing, never repairing it", (_why, value) => {
    expect(parseBuildIdentityHeaders(h({ "x-pos-build-commit": value, "x-pos-app-version": "1.4.0" }))).toBeNull();
  });

  it("treats an array value (a repeated header) as missing", () => {
    expect(parseBuildIdentityHeaders(h({ "x-pos-build-commit": [COMMIT, COMMIT] }))).toBeNull();
    expect(parseBuildIdentityHeaders(h({ "x-pos-build-commit": COMMIT, "x-pos-app-version": ["1.4.0", "1.4.1"] }))).toEqual({
      commit: COMMIT,
      appVersion: null,
      contractPin: null,
    });
  });

  it.each(["1.4", "v1.4.0", "1.4.0+build.5", "01.4.0", "1.4.0-", `1.4.0-${"a".repeat(30)}`, "1.4.0 ", "1.4.0\u00e9", ""])(
    "records a version of %j as null and keeps the commit",
    (version) => {
      expect(parseBuildIdentityHeaders(h({ "x-pos-build-commit": COMMIT, "x-pos-app-version": version }))).toEqual({
        commit: COMMIT,
        appVersion: null,
        contractPin: null,
      });
    },
  );

  it.each([PIN.slice(0, 39), PIN.toUpperCase(), `${PIN}0`, "zz", ""])("records a pin of %j as null and keeps the commit", (pin) => {
    expect(parseBuildIdentityHeaders(h({ "x-pos-build-commit": COMMIT, "x-pos-contract-pin": pin }))).toEqual({
      commit: COMMIT,
      appVersion: null,
      contractPin: null,
    });
  });

  it("accepts a 32-character version and refuses a 33-character one", () => {
    const at32 = `1.0.0-${"a".repeat(26)}`;
    expect(at32).toHaveLength(32);
    expect(parseBuildIdentityHeaders(h({ "x-pos-build-commit": COMMIT, "x-pos-app-version": at32 }))?.appVersion).toBe(at32);
    expect(parseBuildIdentityHeaders(h({ "x-pos-build-commit": COMMIT, "x-pos-app-version": `${at32}a` }))?.appVersion).toBeNull();
  });
});
