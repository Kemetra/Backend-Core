/**
 * clerk-verifier.spec.ts — clerkVerifierFactory + ClerkBackendVerifier unit coverage.
 *
 * T304-B-api coverage lift.
 *
 * Strategy:
 * - clerkVerifierFactory() reads process.env at call time, not at module
 *   evaluation time, so jest.resetModules() is unnecessary. Each test sets
 *   the relevant env vars, calls the factory, then afterEach restores the
 *   original env.
 * - ClerkBackendVerifier.verify() is tested by constructing an instance
 *   directly with a fake secret key. verifyToken from @data-pulse-2/auth
 *   is fully mocked — no network, no JWKS fetch, no real Clerk credentials.
 *
 * Branches covered
 * ────────────────
 * F1  production + no CLERK_SECRET_KEY → throws at factory call time
 * F2  non-production + no CLERK_SECRET_KEY → fail-closed verifier (verify throws)
 * F3  secret present, no audience, no parties → ClerkBackendVerifier returned
 * F3a CLERK_JWT_AUDIENCE present → forwarded to verifyToken options
 * F3b CLERK_AUTHORIZED_PARTIES present → split/trim/filter before forwarding
 * F3c CLERK_AUTHORIZED_PARTIES absent → authorizedParties not forwarded
 * B1  verify: payload.sub is valid string → returns { sub }
 * B2  verify: payload.sub is empty string → throws "payload missing sub"
 * B3  verify: payload.sub is not a string (undefined) → throws "payload missing sub"
 * B4  verify: verifyToken rejects → error propagates unchanged
 */

// jest.mock must appear before any imports that reference the mocked module.
jest.mock("@data-pulse-2/auth", () => ({
  verifyToken: jest.fn(),
}));

import { verifyToken } from "@data-pulse-2/auth";
import {
  ClerkBackendVerifier,
  clerkVerifierFactory,
} from "../../src/pos-operators/clerk-verifier";

const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;

// Snapshot the process.env at module evaluation time so afterEach can restore
// exactly the keys that existed before the test suite ran.
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // Remove any keys the test may have added, then restore original values.
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// clerkVerifierFactory
// ---------------------------------------------------------------------------

describe("clerkVerifierFactory", () => {
  describe("F1 — production environment without CLERK_SECRET_KEY", () => {
    it("throws synchronously with the expected message", () => {
      process.env["NODE_ENV"] = "production";
      delete process.env["CLERK_SECRET_KEY"];

      expect(() => clerkVerifierFactory()).toThrow(
        "PosOperatorsModule: CLERK_SECRET_KEY is required in production",
      );
    });

    it("throws before returning any verifier", () => {
      process.env["NODE_ENV"] = "production";
      delete process.env["CLERK_SECRET_KEY"];

      let result: ReturnType<typeof clerkVerifierFactory> | undefined;
      try {
        result = clerkVerifierFactory();
      } catch {
        // expected
      }
      expect(result).toBeUndefined();
    });
  });

  describe("F2 — non-production environment without CLERK_SECRET_KEY", () => {
    it("returns a verifier without throwing", () => {
      process.env["NODE_ENV"] = "test";
      delete process.env["CLERK_SECRET_KEY"];

      expect(() => clerkVerifierFactory()).not.toThrow();
    });

    it("returned verifier's verify() throws fail-closed error", async () => {
      process.env["NODE_ENV"] = "test";
      delete process.env["CLERK_SECRET_KEY"];

      const verifier = clerkVerifierFactory();

      await expect(verifier.verify("any.jwt.token")).rejects.toThrow(
        "clerk verifier: CLERK_SECRET_KEY not configured (fail closed)",
      );
    });

    it("fail-closed verifier rejects regardless of token value", async () => {
      delete process.env["CLERK_SECRET_KEY"];
      process.env["NODE_ENV"] = "development";

      const verifier = clerkVerifierFactory();

      await expect(verifier.verify("")).rejects.toThrow("fail closed");
    });
  });

  describe("F3 — CLERK_SECRET_KEY present, minimal configuration", () => {
    beforeEach(() => {
      process.env["CLERK_SECRET_KEY"] = "sk_test_fake";
      delete process.env["CLERK_JWT_AUDIENCE"];
      delete process.env["CLERK_AUTHORIZED_PARTIES"];
    });

    it("returns a ClerkBackendVerifier instance", () => {
      const verifier = clerkVerifierFactory();

      expect(verifier).toBeInstanceOf(ClerkBackendVerifier);
    });

    it("calls verifyToken with the configured secret key when verify() is called", async () => {
      mockVerifyToken.mockResolvedValueOnce({ sub: "user_abc" } as Awaited<
        ReturnType<typeof verifyToken>
      >);

      const verifier = clerkVerifierFactory();
      await verifier.verify("test.jwt.token");

      expect(mockVerifyToken).toHaveBeenCalledWith(
        "test.jwt.token",
        expect.objectContaining({ secretKey: "sk_test_fake" }),
      );
    });

    it("F3c — does not forward audience when CLERK_JWT_AUDIENCE is absent", async () => {
      mockVerifyToken.mockResolvedValueOnce({ sub: "user_abc" } as Awaited<
        ReturnType<typeof verifyToken>
      >);

      const verifier = clerkVerifierFactory();
      await verifier.verify("test.jwt.token");

      const [, opts] = mockVerifyToken.mock.calls[0]!;
      expect(opts).not.toHaveProperty("audience");
    });

    it("F3c — does not forward authorizedParties when CLERK_AUTHORIZED_PARTIES is absent", async () => {
      mockVerifyToken.mockResolvedValueOnce({ sub: "user_abc" } as Awaited<
        ReturnType<typeof verifyToken>
      >);

      const verifier = clerkVerifierFactory();
      await verifier.verify("test.jwt.token");

      const [, opts] = mockVerifyToken.mock.calls[0]!;
      expect(opts).not.toHaveProperty("authorizedParties");
    });
  });

  describe("F3a — CLERK_JWT_AUDIENCE present", () => {
    it("forwards audience to verifyToken options", async () => {
      process.env["CLERK_SECRET_KEY"] = "sk_test_fake";
      process.env["CLERK_JWT_AUDIENCE"] = "https://api.example.com";
      delete process.env["CLERK_AUTHORIZED_PARTIES"];

      mockVerifyToken.mockResolvedValueOnce({ sub: "user_abc" } as Awaited<
        ReturnType<typeof verifyToken>
      >);

      const verifier = clerkVerifierFactory();
      await verifier.verify("test.jwt.token");

      expect(mockVerifyToken).toHaveBeenCalledWith(
        "test.jwt.token",
        expect.objectContaining({ audience: "https://api.example.com" }),
      );
    });
  });

  describe("F3b — CLERK_AUTHORIZED_PARTIES present", () => {
    it("splits, trims, and filters empty entries before forwarding", async () => {
      process.env["CLERK_SECRET_KEY"] = "sk_test_fake";
      delete process.env["CLERK_JWT_AUDIENCE"];
      process.env["CLERK_AUTHORIZED_PARTIES"] =
        "https://a.example.com, https://b.example.com, ";

      mockVerifyToken.mockResolvedValueOnce({ sub: "user_abc" } as Awaited<
        ReturnType<typeof verifyToken>
      >);

      const verifier = clerkVerifierFactory();
      await verifier.verify("test.jwt.token");

      expect(mockVerifyToken).toHaveBeenCalledWith(
        "test.jwt.token",
        expect.objectContaining({
          authorizedParties: ["https://a.example.com", "https://b.example.com"],
        }),
      );
    });

    it("filters out whitespace-only entries", async () => {
      process.env["CLERK_SECRET_KEY"] = "sk_test_fake";
      delete process.env["CLERK_JWT_AUDIENCE"];
      process.env["CLERK_AUTHORIZED_PARTIES"] = "https://a.example.com,  , https://c.example.com";

      mockVerifyToken.mockResolvedValueOnce({ sub: "user_abc" } as Awaited<
        ReturnType<typeof verifyToken>
      >);

      const verifier = clerkVerifierFactory();
      await verifier.verify("test.jwt.token");

      const [, opts] = mockVerifyToken.mock.calls[0]!;
      expect(opts).toHaveProperty("authorizedParties", [
        "https://a.example.com",
        "https://c.example.com",
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// ClerkBackendVerifier.verify
// ---------------------------------------------------------------------------

describe("ClerkBackendVerifier.verify", () => {
  let verifier: ClerkBackendVerifier;

  beforeEach(() => {
    verifier = new ClerkBackendVerifier("sk_test_fake");
  });

  it("B1 — returns { providerKey, sub } when verifyToken resolves with a valid string sub", async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: "user_clerk_123" } as Awaited<
      ReturnType<typeof verifyToken>
    >);

    const result = await verifier.verify("valid.jwt.token");

    expect(result).toEqual({ providerKey: "clerk", sub: "user_clerk_123" });
  });

  it("B1 — passes the raw JWT to verifyToken unchanged", async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: "user_clerk_123" } as Awaited<
      ReturnType<typeof verifyToken>
    >);

    await verifier.verify("header.payload.signature");

    expect(mockVerifyToken).toHaveBeenCalledWith(
      "header.payload.signature",
      expect.any(Object),
    );
  });

  it("B2 — throws when payload.sub is an empty string", async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: "" } as Awaited<
      ReturnType<typeof verifyToken>
    >);

    await expect(verifier.verify("test.jwt")).rejects.toThrow(
      "clerk verifier: payload missing sub",
    );
  });

  it("B3 — throws when payload.sub is not a string (undefined)", async () => {
    mockVerifyToken.mockResolvedValueOnce(
      { sub: undefined as unknown as string } as Awaited<ReturnType<typeof verifyToken>>,
    );

    await expect(verifier.verify("test.jwt")).rejects.toThrow(
      "clerk verifier: payload missing sub",
    );
  });

  it("B4 — propagates errors thrown by verifyToken unchanged", async () => {
    const authError = new Error("JWKS fetch failed: network error");
    mockVerifyToken.mockRejectedValueOnce(authError);

    await expect(verifier.verify("test.jwt")).rejects.toThrow(
      "JWKS fetch failed: network error",
    );
  });

  it("B4 — propagates the exact error instance thrown by verifyToken", async () => {
    const authError = new Error("token expired");
    mockVerifyToken.mockRejectedValueOnce(authError);

    await expect(verifier.verify("test.jwt")).rejects.toBe(authError);
  });

  describe("audience and authorizedParties forwarding", () => {
    it("forwards audience when constructed with one", async () => {
      const audienceVerifier = new ClerkBackendVerifier(
        "sk_test_fake",
        "https://api.example.com",
      );
      mockVerifyToken.mockResolvedValueOnce({ sub: "user_abc" } as Awaited<
        ReturnType<typeof verifyToken>
      >);

      await audienceVerifier.verify("test.jwt");

      expect(mockVerifyToken).toHaveBeenCalledWith(
        "test.jwt",
        expect.objectContaining({ audience: "https://api.example.com" }),
      );
    });

    it("forwards authorizedParties when constructed with them", async () => {
      const partiesVerifier = new ClerkBackendVerifier("sk_test_fake", undefined, [
        "https://a.example.com",
        "https://b.example.com",
      ]);
      mockVerifyToken.mockResolvedValueOnce({ sub: "user_abc" } as Awaited<
        ReturnType<typeof verifyToken>
      >);

      await partiesVerifier.verify("test.jwt");

      expect(mockVerifyToken).toHaveBeenCalledWith(
        "test.jwt",
        expect.objectContaining({
          authorizedParties: ["https://a.example.com", "https://b.example.com"],
        }),
      );
    });
  });
});
