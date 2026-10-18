/**
 * RT-624 (RT-574 issue 5b) — TRUST_PROXY boot check. Unset in a deployed
 * environment warns (default) or refuses (explicit opt-in only); an explicit
 * value, including `false`, is silent. The resolved setting is unchanged.
 */
import {
  checkTrustProxyConfig,
  resolveTrustProxySetting,
  TRUST_PROXY_UNRECOGNIZED_WARNING,
  TRUST_PROXY_UNSET_WARNING,
} from "../../src/common/trust-proxy";

type Env = NodeJS.ProcessEnv;

describe("resolveTrustProxySetting (behavior-preserving)", () => {
  it.each([
    [undefined, false],
    ["false", false],
    ["true", true],
    ["1", 1],
    ["2", 2],
    ["loopback", false],
    ["", false],
  ])("TRUST_PROXY=%p -> %p", (raw, expected) => {
    const env: Env = raw === undefined ? {} : { TRUST_PROXY: raw };
    expect(resolveTrustProxySetting(env)).toBe(expected);
  });
});

describe("checkTrustProxyConfig", () => {
  const deployed: Array<[string, Env]> = [
    ["NODE_ENV=production", { NODE_ENV: "production" }],
    ["DEPLOYMENT_ENVIRONMENT=prod", { DEPLOYMENT_ENVIRONMENT: "prod" }],
    ["DEPLOYMENT_ENVIRONMENT=pilot", { DEPLOYMENT_ENVIRONMENT: "pilot" }],
    ["DEPLOYMENT_ENVIRONMENT=staging", { DEPLOYMENT_ENVIRONMENT: "staging" }],
  ];
  const notDeployed: Array<[string, Env]> = [
    ["empty env", {}],
    ["NODE_ENV=test", { NODE_ENV: "test" }],
    ["NODE_ENV=development", { NODE_ENV: "development" }],
    ["DEPLOYMENT_ENVIRONMENT=dev", { DEPLOYMENT_ENVIRONMENT: "dev" }],
  ];

  describe.each(deployed)("deployed (%s)", (_label, base) => {
    it.each([undefined, "", "  "])("unset/blank %p warns", (raw) => {
      const env: Env = raw === undefined ? { ...base } : { ...base, TRUST_PROXY: raw };
      expect(checkTrustProxyConfig(env)).toEqual({
        warn: true,
        message: TRUST_PROXY_UNSET_WARNING,
      });
    });

    it.each([" 1", "1 ", "yes", "TRUE", "loopback"])("unrecognized %p warns", (raw) => {
      expect(checkTrustProxyConfig({ ...base, TRUST_PROXY: raw })).toEqual({
        warn: true,
        message: TRUST_PROXY_UNRECOGNIZED_WARNING,
      });
    });

    it.each(["false", "1", "2", "true"])("explicit %p is silent", (raw) => {
      expect(checkTrustProxyConfig({ ...base, TRUST_PROXY: raw })).toEqual({ warn: false });
    });
  });

  describe.each(notDeployed)("not deployed (%s)", (_label, base) => {
    it("unset is silent", () => {
      expect(checkTrustProxyConfig({ ...base })).toEqual({ warn: false });
    });
    it("explicit is silent", () => {
      expect(checkTrustProxyConfig({ ...base, TRUST_PROXY: "1" })).toEqual({ warn: false });
    });
    it("fail-fast flag alone does not throw outside a deployed environment", () => {
      expect(() =>
        checkTrustProxyConfig({ ...base, TRUST_PROXY_REQUIRED: "true" }),
      ).not.toThrow();
    });
  });

  describe("fail-fast opt-in (TRUST_PROXY_REQUIRED=true)", () => {
    it("throws when deployed and TRUST_PROXY is unset", () => {
      expect(() =>
        checkTrustProxyConfig({ NODE_ENV: "production", TRUST_PROXY_REQUIRED: "true" }),
      ).toThrow(/TRUST_PROXY/);
    });
    it("throws on an unrecognized value", () => {
      expect(() =>
        checkTrustProxyConfig({
          NODE_ENV: "production",
          TRUST_PROXY: "yes",
          TRUST_PROXY_REQUIRED: "true",
        }),
      ).toThrow(/TRUST_PROXY/);
    });
    it("does not throw when TRUST_PROXY is explicit", () => {
      expect(
        checkTrustProxyConfig({
          NODE_ENV: "production",
          TRUST_PROXY: "false",
          TRUST_PROXY_REQUIRED: "true",
        }),
      ).toEqual({ warn: false });
    });
    it.each(["", "false", "0", "yes", "TRUE"])(
      "any value other than exactly 'true' (%p) keeps warn-only",
      (flag) => {
        expect(
          checkTrustProxyConfig({ NODE_ENV: "production", TRUST_PROXY_REQUIRED: flag }),
        ).toEqual({ warn: true, message: TRUST_PROXY_UNSET_WARNING });
      },
    );
  });
});
