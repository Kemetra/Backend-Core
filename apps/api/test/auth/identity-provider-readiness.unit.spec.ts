/**
 * identity-provider-readiness.unit.spec.ts — 029 D3 (T9 provider-readiness).
 *
 * Proves G-5 / 028 OQ-7: a SECOND (stub) IdentityProviderPort adapter — a
 * hypothetical future provider — registers behind the port and drives the SAME
 * resolver with NO business-rule change, WITHOUT integrating a real second
 * provider (N-6). The resolver depends only on the port interface + the neutral
 * VerifiedSubject; swapping the adapter swaps the provider.
 *
 * This is the architecture-readiness assertion: the resolver code, the
 * external_identity_links join, and the membership/role/store eligibility logic
 * are untouched; only the `providerKey` discriminator + the verification source
 * differ. No Docker.
 */
import "reflect-metadata";

import type { Pool } from "pg";
import type { DeviceRow } from "@data-pulse-2/db/schema";

import { PgOperatorContextResolver } from "../../src/auth/operator-context-resolver";
import type {
  IdentityProviderPort,
  VerifiedSubject,
} from "../../src/auth/identity-provider.port";
import type { DeviceRepository } from "../../src/pos-operators/device.repository";

const KEYCLOAK_SUBJECT = "kc|abc-123";
const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID = "0a000000-0000-7000-8000-00000000aa02";
const STORE_ID = "0a000000-0000-7000-8000-00000000aa03";
const DEVICE_ID = "0a000000-0000-7000-8000-00000000aa04";

/**
 * A stub adapter for a hypothetical SECOND provider. It implements only the two
 * D3-wired operations (the lifecycle seams are optional to exercise here); it
 * returns a neutral subject with a DIFFERENT providerKey. No real provider SDK.
 */
class StubKeycloakAdapter implements IdentityProviderPort {
  async verifyIdentityToken(_raw: string): Promise<VerifiedSubject> {
    return {
      providerKey: "keycloak",
      issuer: "https://keycloak.example/realms/dp2",
      subject: KEYCLOAK_SUBJECT,
    };
  }
  async linkExternalIdentity(): Promise<{ id: string }> {
    return { id: "kc-link-1" };
  }
  async getIdentityProfile(): Promise<null> {
    return null;
  }
  async createIdentity(): Promise<{ subject: string }> {
    return { subject: KEYCLOAK_SUBJECT };
  }
  async inviteUser(): Promise<{ subject: string }> {
    return { subject: KEYCLOAK_SUBJECT };
  }
  async disableIdentity(): Promise<void> {}
  async enableIdentity(): Promise<void> {}
  async sendPasswordReset(): Promise<void> {}
}

function makeDevice(): DeviceRow {
  return {
    id: DEVICE_ID,
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    revokedAt: null,
  } as unknown as DeviceRow;
}

describe("IdentityProviderPort — provider-readiness (G-5 / OQ-7)", () => {
  it("a second (stub) adapter resolves an operator through the unchanged resolver", async () => {
    // The link join receives the NEW provider's (providerKey, subject) and finds
    // the user — exactly as for Clerk; the resolver code is identical.
    const queriedParams: unknown[][] = [];
    const query = jest.fn((sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (params) queriedParams.push(params);
      if (text.includes("FROM external_identity_links")) {
        return Promise.resolve({ rows: [{ id: USER_ID, deleted_at: null }] });
      }
      if (text.includes("FROM memberships")) {
        return Promise.resolve({
          rows: [{
            id: "m1",
            store_access_kind: "all",
            revoked_at: null,
            deleted_at: null,
            role_code: "store_manager",
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const pool = {
      query,
      connect: jest.fn().mockResolvedValue({ query, release: jest.fn() }),
    } as unknown as Pool;
    const deviceRepository = {
      findActiveByAttestation: jest.fn().mockResolvedValue(makeDevice()),
    } as unknown as DeviceRepository;

    const resolver = new PgOperatorContextResolver(
      pool,
      new StubKeycloakAdapter(),
      deviceRepository,
    );

    const result = await resolver.resolve("any-keycloak-token", "att");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.context.userId).toBe(USER_ID);
      expect(result.context.tenantId).toBe(TENANT_ID);
      expect(result.context.storeId).toBe(STORE_ID);
    }
    // The link join keyed on the NEW provider's discriminator — proving the
    // resolver carries no Clerk-specific business rule.
    const linkParams = queriedParams.find((p) => p[0] === "keycloak");
    expect(linkParams).toEqual(["keycloak", KEYCLOAK_SUBJECT]);
  });
});
