/**
 * clerk-identity-provider.adapter.unit.spec.ts — 029 D3 (T4 / T9).
 *
 * Docker-free unit coverage for the ONLY v1 IdentityProviderPort implementation.
 * Proves:
 *   - verifyIdentityToken DELEGATES to the OperatorTokenVerifier and maps Clerk { sub }
 *     to a provider-NEUTRAL VerifiedSubject (providerKey/issuer/subject) — no
 *     Clerk-typed claim leaks;
 *   - a verifier throw propagates (the resolver collapses it to a refusal);
 *   - linkExternalIdentity writes a row and returns its id;
 *   - the defined-but-not-wired lifecycle seams throw loudly (fail fast, never
 *     a silent no-op);
 *   - the issuer is the single configured source of truth.
 */
import "reflect-metadata";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Pool } from "pg";

import {
  ClerkIdentityProviderAdapter,
  CLERK_PROVIDER_KEY,
  DEFAULT_CLERK_ISSUER,
  clerkIssuer,
} from "../../src/auth/clerk-identity-provider.adapter";
import type { OperatorTokenVerifier } from "../../src/auth/operator-token-verifier";

const SUB = "user_clerk_sub_abc";
const USER_ID = "0a000000-0000-7000-8000-00000000aa01";

function fakeVerifier(verify?: () => Promise<{ providerKey: string; sub: string }>): OperatorTokenVerifier {
  return { verify: verify ?? (async () => ({ providerKey: "clerk", sub: SUB })) };
}

describe("ClerkIdentityProviderAdapter — verifyIdentityToken (neutral mapping)", () => {
  it("delegates to the verifier and returns a provider-neutral subject", async () => {
    const verify = jest.fn(async () => ({ providerKey: "clerk", sub: SUB }));
    const adapter = new ClerkIdentityProviderAdapter(
      fakeVerifier(verify),
      {} as unknown as Pool,
      "https://issuer.example",
    );
    const result = await adapter.verifyIdentityToken("raw.jwt.token");
    expect(verify).toHaveBeenCalledWith("raw.jwt.token");
    expect(result).toEqual({
      providerKey: CLERK_PROVIDER_KEY,
      issuer: "https://issuer.example",
      subject: SUB,
    });
  });

  it("returns NO Clerk-typed claim — only the three neutral fields", async () => {
    const adapter = new ClerkIdentityProviderAdapter(
      fakeVerifier(),
      {} as unknown as Pool,
      "https://issuer.example",
    );
    const result = await adapter.verifyIdentityToken("raw");
    expect(Object.keys(result).sort()).toEqual(["issuer", "providerKey", "subject"]);
  });

  it("propagates a verification failure (resolver collapses it)", async () => {
    const adapter = new ClerkIdentityProviderAdapter(
      fakeVerifier(async () => {
        throw new Error("bad jwt");
      }),
      {} as unknown as Pool,
      "https://issuer.example",
    );
    await expect(adapter.verifyIdentityToken("raw")).rejects.toThrow("bad jwt");
  });

  it("uses the configured issuer; default is the backfill-shared literal", () => {
    expect(DEFAULT_CLERK_ISSUER).toBe("https://clerk.dp2.local");
    const prev = process.env["CLERK_JWT_ISSUER"];
    delete process.env["CLERK_JWT_ISSUER"];
    expect(clerkIssuer()).toBe(DEFAULT_CLERK_ISSUER);
    process.env["CLERK_JWT_ISSUER"] = "https://custom.issuer";
    expect(clerkIssuer()).toBe("https://custom.issuer");
    if (prev === undefined) delete process.env["CLERK_JWT_ISSUER"];
    else process.env["CLERK_JWT_ISSUER"] = prev;
  });
});

describe("ClerkIdentityProviderAdapter — linkExternalIdentity", () => {
  it("inserts a link row and returns its id", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: "link-id-1" }] });
    const adapter = new ClerkIdentityProviderAdapter(
      fakeVerifier(),
      { query } as unknown as Pool,
      "https://issuer.example",
    );
    const r = await adapter.linkExternalIdentity({
      providerKey: "clerk",
      issuer: "https://issuer.example",
      subject: SUB,
      userId: USER_ID,
      email: "u@example.com",
    });
    expect(r).toEqual({ id: "link-id-1" });
    expect(query).toHaveBeenCalledTimes(1);
    const params = query.mock.calls[0][1] as unknown[];
    expect(params).toEqual([
      "clerk",
      "https://issuer.example",
      SUB,
      USER_ID,
      "u@example.com",
    ]);
  });

  it("passes null email when omitted", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: "x" }] });
    const adapter = new ClerkIdentityProviderAdapter(
      fakeVerifier(),
      { query } as unknown as Pool,
      "i",
    );
    await adapter.linkExternalIdentity({
      providerKey: "clerk",
      issuer: "i",
      subject: SUB,
      userId: USER_ID,
    });
    const params = query.mock.calls[0][1] as unknown[];
    expect(params[4]).toBeNull();
  });

  it("throws if the insert returns no row", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const adapter = new ClerkIdentityProviderAdapter(
      fakeVerifier(),
      { query } as unknown as Pool,
      "i",
    );
    await expect(
      adapter.linkExternalIdentity({
        providerKey: "clerk",
        issuer: "i",
        subject: SUB,
        userId: USER_ID,
      }),
    ).rejects.toThrow("returned no id");
  });
});

describe("DEFAULT_CLERK_ISSUER — source-of-truth lockstep with the 0025 backfill (MEDIUM-3)", () => {
  // The adapter's DEFAULT_CLERK_ISSUER is the single source of truth for the
  // configured Clerk issuer. The 0025 backfill stamps the SAME literal on every
  // backfilled row. SQL cannot import TS, so this test is the compile-/test-time
  // guard that the two strings stay in lockstep: if either side drifts, this
  // fails. (The runtime resolver join keys on (provider_key, subject) NOT issuer,
  // so a drift can't fail-close an operator today — but D8 lifecycle ops may key
  // on issuer, and the stored value being a different string than the adapter
  // writes would be a latent inconsistency. Guard it here.)
  const MIGRATION_SQL_PATH = resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "db",
    "drizzle",
    "0025_external_identity_links.sql",
  );

  it("the 0025 backfill issuer literal equals the adapter's DEFAULT_CLERK_ISSUER", () => {
    const sql = readFileSync(MIGRATION_SQL_PATH, "utf8");
    // The backfill row stamps `'<issuer>' AS issuer`. Assert that literal IS the
    // adapter constant — not merely that the string appears somewhere.
    expect(sql).toContain(`'${DEFAULT_CLERK_ISSUER}' AS issuer`);
  });
});

describe("ClerkIdentityProviderAdapter — lifecycle seams (T5, not wired in D3)", () => {
  const adapter = new ClerkIdentityProviderAdapter(
    fakeVerifier(),
    {} as unknown as Pool,
    "i",
  );

  it("getIdentityProfile throws not-wired", async () => {
    await expect(adapter.getIdentityProfile(SUB)).rejects.toThrow("not wired in D3");
  });
  it("createIdentity throws not-wired", async () => {
    await expect(adapter.createIdentity({ email: "a@b.c" })).rejects.toThrow("not wired in D3");
  });
  it("inviteUser throws not-wired", async () => {
    await expect(adapter.inviteUser({ email: "a@b.c" })).rejects.toThrow("not wired in D3");
  });
  it("disableIdentity throws not-wired", async () => {
    await expect(adapter.disableIdentity(USER_ID)).rejects.toThrow("not wired in D3");
  });
  it("enableIdentity throws not-wired", async () => {
    await expect(adapter.enableIdentity(USER_ID)).rejects.toThrow("not wired in D3");
  });
  it("sendPasswordReset throws not-wired", async () => {
    await expect(adapter.sendPasswordReset("a@b.c")).rejects.toThrow("not wired in D3");
  });
});
