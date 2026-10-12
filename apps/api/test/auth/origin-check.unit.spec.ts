/**
 * origin-check.unit.spec.ts — RT-430.
 *
 * Docker-free coverage for the Origin check that guards cookie-authenticated
 * unsafe requests (and sign-in) against cross-site and same-site-sibling
 * request forgery. The decision rules are pinned here; the AuthGuard and
 * AuthController wiring is pinned in their own specs.
 */
import { ForbiddenException } from "@nestjs/common";

import {
  ORIGIN_REJECTED,
  assertTrustedOrigin,
  checkRequestOrigin,
  isUnsafeMethod,
  sessionCookieSecure,
} from "../../src/auth/origin-check";

function req(headers: Record<string, string>, protocol = "http") {
  return { headers, protocol };
}

const envBackup = { ...process.env };
afterEach(() => {
  process.env = { ...envBackup };
});

describe("isUnsafeMethod", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "post", "delete"])("%s is unsafe", (m) => {
    expect(isUnsafeMethod(m)).toBe(true);
  });

  it.each(["GET", "HEAD", "OPTIONS", undefined])("%s is safe", (m) => {
    expect(isUnsafeMethod(m)).toBe(false);
  });
});

describe("sessionCookieSecure", () => {
  it.each([
    ["production", true],
    ["staging", true],
    [undefined, true],
    ["test", false],
    ["development", false],
  ])("NODE_ENV=%s → %s", (env, secure) => {
    if (env === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = env;
    expect(sessionCookieSecure()).toBe(secure);
  });
});

describe("checkRequestOrigin — own origin from Host", () => {
  beforeEach(() => {
    process.env["NODE_ENV"] = "test";
    delete process.env["ALLOWED_ORIGINS"];
  });

  it("an Origin equal to the request's own origin is trusted", () => {
    expect(checkRequestOrigin(req({ host: "api.test", origin: "http://api.test" }))).toBe("trusted");
  });

  it("matches host and port, case-insensitively", () => {
    expect(
      checkRequestOrigin(req({ host: "API.test:8080", origin: "http://api.TEST:8080" })),
    ).toBe("trusted");
  });

  it("a default port on either side is normalized away", () => {
    expect(checkRequestOrigin(req({ host: "api.test:80", origin: "http://api.test" }))).toBe("trusted");
  });

  it("a same-site sibling subdomain is foreign", () => {
    expect(
      checkRequestOrigin(req({ host: "api.example.test", origin: "https://evil.example.test" })),
    ).toBe("foreign");
  });

  it("a different port is foreign", () => {
    expect(checkRequestOrigin(req({ host: "api.test", origin: "http://api.test:8443" }))).toBe("foreign");
  });

  it("the opaque `null` origin is foreign", () => {
    expect(checkRequestOrigin(req({ host: "api.test", origin: "null" }))).toBe("foreign");
  });

  it("an unparsable or non-http Origin is foreign", () => {
    expect(checkRequestOrigin(req({ host: "api.test", origin: "not a url" }))).toBe("foreign");
    expect(checkRequestOrigin(req({ host: "api.test", origin: "file://api.test" }))).toBe("foreign");
  });

  it("an absent or blank Origin is missing", () => {
    expect(checkRequestOrigin(req({ host: "api.test" }))).toBe("missing");
    expect(checkRequestOrigin(req({ host: "api.test", origin: "  " }))).toBe("missing");
  });

  it("with no Host, only ALLOWED_ORIGINS can trust a request", () => {
    expect(checkRequestOrigin(req({ origin: "http://api.test" }))).toBe("foreign");
  });

  it("uses the request scheme outside Secure-cookie environments", () => {
    expect(
      checkRequestOrigin(req({ host: "api.test", origin: "https://api.test" }, "https")),
    ).toBe("trusted");
    expect(
      checkRequestOrigin(req({ host: "api.test", origin: "https://api.test" }, "http")),
    ).toBe("foreign");
  });
});

describe("checkRequestOrigin — Secure-cookie environments", () => {
  beforeEach(() => {
    process.env["NODE_ENV"] = "production";
    delete process.env["ALLOWED_ORIGINS"];
  });

  it("the own origin is https even when the proxy hop is plain http", () => {
    expect(
      checkRequestOrigin(req({ host: "api.example.test", origin: "https://api.example.test" }, "http")),
    ).toBe("trusted");
  });

  it("an http Origin for the same host is foreign", () => {
    expect(
      checkRequestOrigin(req({ host: "api.example.test", origin: "http://api.example.test" }, "http")),
    ).toBe("foreign");
  });
});

describe("checkRequestOrigin — ALLOWED_ORIGINS", () => {
  beforeEach(() => {
    process.env["NODE_ENV"] = "production";
    process.env["ALLOWED_ORIGINS"] = " https://console.example.test/ , ,not a url,http://localhost:5173";
  });

  it("an Origin listed in ALLOWED_ORIGINS is trusted (entries are normalized)", () => {
    expect(
      checkRequestOrigin(req({ host: "api.example.test", origin: "https://console.example.test" })),
    ).toBe("trusted");
    expect(
      checkRequestOrigin(req({ host: "api.example.test", origin: "http://localhost:5173" })),
    ).toBe("trusted");
  });

  it("an Origin not listed is still foreign", () => {
    expect(
      checkRequestOrigin(req({ host: "api.example.test", origin: "https://other.example.test" })),
    ).toBe("foreign");
  });
});

describe("assertTrustedOrigin", () => {
  beforeEach(() => {
    process.env["NODE_ENV"] = "test";
    delete process.env["ALLOWED_ORIGINS"];
  });

  function refusal(fn: () => void): ForbiddenException {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      return err as ForbiddenException;
    }
    throw new Error("expected a refusal");
  }

  it("passes a trusted Origin", () => {
    expect(() => assertTrustedOrigin(req({ host: "api.test", origin: "http://api.test" }))).not.toThrow();
  });

  it("refuses a foreign Origin with 403 origin_rejected", () => {
    const err = refusal(() =>
      assertTrustedOrigin(req({ host: "api.test", origin: "http://evil.test" })),
    );
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({ code: ORIGIN_REJECTED });
  });

  it("refuses a missing Origin by default", () => {
    const err = refusal(() => assertTrustedOrigin(req({ host: "api.test" })));
    expect(err.getResponse()).toMatchObject({ code: ORIGIN_REJECTED });
  });

  it("admits a missing Origin with allowMissing, but still refuses a foreign one", () => {
    expect(() => assertTrustedOrigin(req({ host: "api.test" }), { allowMissing: true })).not.toThrow();
    refusal(() =>
      assertTrustedOrigin(req({ host: "api.test", origin: "http://evil.test" }), { allowMissing: true }),
    );
  });
});
