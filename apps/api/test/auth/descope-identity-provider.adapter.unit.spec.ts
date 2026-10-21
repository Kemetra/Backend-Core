/**
 * descope-identity-provider.adapter.unit.spec.ts — RT-791.
 *
 * Docker-free: the Descope adapter maps the verifier's `{ sub }` to a
 * provider-neutral subject keyed 'descope', lets verifier failures propagate,
 * writes links through the shared upsert, and keeps the lifecycle seams loud.
 */
import "reflect-metadata";

import type { Pool } from "pg";

import {
  DESCOPE_PROVIDER_KEY,
  DescopeIdentityProviderAdapter,
} from "../../src/auth/descope-identity-provider.adapter";
import type { ClerkVerifier } from "../../src/pos-operators/clerk-verifier";

const SUB = "U2descopeAdapter01";
const ISSUER = "https://api.descope.com/v1/apps/P2adapterTest";
const USER_ID = "0a000000-0000-7000-8000-00000000ab01";

function verifier(verify?: () => Promise<{ sub: string }>): ClerkVerifier {
  return { verify: verify ?? (async () => ({ sub: SUB })) };
}

describe("DescopeIdentityProviderAdapter", () => {
  it("maps the verified sub to a neutral 'descope' subject with the configured issuer", async () => {
    const verify = jest.fn(async () => ({ sub: SUB }));
    const adapter = new DescopeIdentityProviderAdapter(verifier(verify), {} as unknown as Pool, ISSUER);
    await expect(adapter.verifyIdentityToken("raw.jwt")).resolves.toEqual({
      providerKey: DESCOPE_PROVIDER_KEY,
      issuer: ISSUER,
      subject: SUB,
    });
    expect(verify).toHaveBeenCalledWith("raw.jwt");
  });

  it("propagates a verifier refusal", async () => {
    const adapter = new DescopeIdentityProviderAdapter(
      verifier(async () => {
        throw new Error("descope verifier: token rejected");
      }),
      {} as unknown as Pool,
      ISSUER,
    );
    await expect(adapter.verifyIdentityToken("raw")).rejects.toThrow("token rejected");
  });

  it("linkExternalIdentity upserts an active descope link and returns its id", async () => {
    const query = jest.fn(async () => ({ rows: [{ id: "link-1" }] }));
    const adapter = new DescopeIdentityProviderAdapter(
      verifier(),
      { query } as unknown as Pool,
      ISSUER,
    );
    await expect(
      adapter.linkExternalIdentity({
        providerKey: DESCOPE_PROVIDER_KEY,
        issuer: ISSUER,
        subject: SUB,
        userId: USER_ID,
      }),
    ).resolves.toEqual({ id: "link-1" });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO external_identity_links/);
    expect(sql).toMatch(/status = 'active'/);
    expect(params).toEqual([DESCOPE_PROVIDER_KEY, ISSUER, SUB, USER_ID, null]);
  });

  it.each([
    ["getIdentityProfile", (a: DescopeIdentityProviderAdapter) => a.getIdentityProfile(SUB)],
    ["createIdentity", (a: DescopeIdentityProviderAdapter) => a.createIdentity({ email: "a@b.c" })],
    ["inviteUser", (a: DescopeIdentityProviderAdapter) => a.inviteUser({ email: "a@b.c" })],
    ["disableIdentity", (a: DescopeIdentityProviderAdapter) => a.disableIdentity(USER_ID)],
    ["enableIdentity", (a: DescopeIdentityProviderAdapter) => a.enableIdentity(USER_ID)],
    ["sendPasswordReset", (a: DescopeIdentityProviderAdapter) => a.sendPasswordReset("a@b.c")],
  ])("%s throws not-wired", async (_name, call) => {
    const adapter = new DescopeIdentityProviderAdapter(verifier(), {} as unknown as Pool, ISSUER);
    await expect(call(adapter)).rejects.toThrow("not wired in D3");
  });
});
