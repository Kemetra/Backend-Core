/**
 * identity-provider-selection.unit.spec.ts — RT-791 `IDENTITY_PROVIDER` switch.
 *
 * The two existing factories (`clerkVerifierFactory`, `clerkIdentityProviderFactory`)
 * are the single selection point every module uses, so switching the env var
 * switches sign-in, shifts, audit events, sales and settlement together.
 * Unset / empty selects Clerk (unchanged default); an unknown value fails at
 * boot in every environment; production refuses to boot when the selected
 * provider is not configured. Offline: building the remote JWKS makes no request.
 */
import "reflect-metadata";

import type { Pool } from "pg";

import {
  ClerkIdentityProviderAdapter,
  clerkIdentityProviderFactory,
} from "../../src/auth/clerk-identity-provider.adapter";
import {
  DESCOPE_PROVIDER_KEY,
  DescopeIdentityProviderAdapter,
} from "../../src/auth/descope-identity-provider.adapter";
import { identityProviderKind } from "../../src/auth/identity-provider-kind";
import { ClerkBackendVerifier, clerkVerifierFactory } from "../../src/pos-operators/clerk-verifier";
import { DescopeJwksVerifier } from "../../src/pos-operators/descope-verifier";

const ORIGINAL_ENV = { ...process.env };
const PROJECT_ID = "P2selectionTest01";
const pool = {} as unknown as Pool;

const KEYS = [
  "IDENTITY_PROVIDER",
  "NODE_ENV",
  "CLERK_SECRET_KEY",
  "DESCOPE_PROJECT_ID",
  "DESCOPE_JWT_ISSUER",
  "DESCOPE_JWT_AUDIENCE",
];

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  process.env["NODE_ENV"] = "test";
});

afterAll(() => {
  for (const k of KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

describe("identityProviderKind", () => {
  it.each<[string | undefined, string]>([
    [undefined, "clerk"],
    ["", "clerk"],
    ["  ", "clerk"],
    ["clerk", "clerk"],
    ["descope", "descope"],
    [" descope ", "descope"],
  ])("%p selects %s", (value, expected) => {
    if (value !== undefined) process.env["IDENTITY_PROVIDER"] = value;
    expect(identityProviderKind()).toBe(expected);
  });

  it.each(["auth0", "DESCOPE", "Clerk", "descope,clerk"])(
    "unknown value %p fails closed",
    (value) => {
      process.env["IDENTITY_PROVIDER"] = value;
      expect(() => identityProviderKind()).toThrow(/IDENTITY_PROVIDER/);
    },
  );

  it("an unknown value fails closed in production too", () => {
    process.env["NODE_ENV"] = "production";
    process.env["IDENTITY_PROVIDER"] = "okta";
    expect(() => clerkVerifierFactory()).toThrow(/IDENTITY_PROVIDER/);
    expect(() => clerkIdentityProviderFactory(pool)).toThrow(/IDENTITY_PROVIDER/);
  });
});

describe("clerkVerifierFactory — provider selection", () => {
  it("default stays Clerk", () => {
    process.env["CLERK_SECRET_KEY"] = "sk_test_x";
    expect(clerkVerifierFactory()).toBeInstanceOf(ClerkBackendVerifier);
  });

  it("descope + project id → the Descope JWKS verifier (no network at build time)", () => {
    process.env["IDENTITY_PROVIDER"] = "descope";
    process.env["DESCOPE_PROJECT_ID"] = PROJECT_ID;
    expect(clerkVerifierFactory()).toBeInstanceOf(DescopeJwksVerifier);
  });

  it("descope in production does not require CLERK_SECRET_KEY", () => {
    process.env["NODE_ENV"] = "production";
    process.env["IDENTITY_PROVIDER"] = "descope";
    process.env["DESCOPE_PROJECT_ID"] = PROJECT_ID;
    expect(() => clerkVerifierFactory()).not.toThrow();
  });

  it("descope in production without DESCOPE_PROJECT_ID fails at boot", () => {
    process.env["NODE_ENV"] = "production";
    process.env["IDENTITY_PROVIDER"] = "descope";
    process.env["CLERK_SECRET_KEY"] = "sk_live_x";
    expect(() => clerkVerifierFactory()).toThrow(/DESCOPE_PROJECT_ID is required in production/);
  });

  it("descope outside production without DESCOPE_PROJECT_ID boots but every verify fails closed", async () => {
    process.env["IDENTITY_PROVIDER"] = "descope";
    const verifier = clerkVerifierFactory();
    await expect(verifier.verify("any.jwt.token")).rejects.toThrow(/fail closed/);
  });

  it("a malformed DESCOPE_PROJECT_ID fails at boot", () => {
    process.env["IDENTITY_PROVIDER"] = "descope";
    process.env["DESCOPE_PROJECT_ID"] = "P2/../x";
    expect(() => clerkVerifierFactory()).toThrow(/DESCOPE_PROJECT_ID/);
  });
});

describe("clerkIdentityProviderFactory — provider selection", () => {
  it("default stays the Clerk adapter", () => {
    expect(clerkIdentityProviderFactory(pool)).toBeInstanceOf(ClerkIdentityProviderAdapter);
  });

  it("descope → the Descope adapter, keyed 'descope' with the derived issuer", async () => {
    process.env["IDENTITY_PROVIDER"] = "descope";
    process.env["DESCOPE_PROJECT_ID"] = PROJECT_ID;
    const adapter = clerkIdentityProviderFactory(pool);
    expect(adapter).toBeInstanceOf(DescopeIdentityProviderAdapter);
    expect(DESCOPE_PROVIDER_KEY).toBe("descope");
    expect((adapter as DescopeIdentityProviderAdapter).issuer).toBe(
      `https://api.descope.com/${PROJECT_ID}`,
    );
  });

  it("DESCOPE_JWT_ISSUER overrides the derived issuer", () => {
    process.env["IDENTITY_PROVIDER"] = "descope";
    process.env["DESCOPE_PROJECT_ID"] = PROJECT_ID;
    process.env["DESCOPE_JWT_ISSUER"] = PROJECT_ID;
    const adapter = clerkIdentityProviderFactory(pool) as DescopeIdentityProviderAdapter;
    expect(adapter.issuer).toBe(PROJECT_ID);
  });

  it("descope in production without DESCOPE_PROJECT_ID fails at boot", () => {
    process.env["NODE_ENV"] = "production";
    process.env["IDENTITY_PROVIDER"] = "descope";
    expect(() => clerkIdentityProviderFactory(pool)).toThrow(/DESCOPE_PROJECT_ID/);
  });
});
