/**
 * descope-identity-provider.adapter.ts — RT-791 (RT-790 approach A).
 *
 * The Descope implementation of `IdentityProviderPort`, selected with
 * `IDENTITY_PROVIDER=descope`. `verifyIdentityToken` delegates to the Descope
 * JWKS verifier (same `OperatorTokenVerifier` seam) and maps `{ sub }` to a
 * provider-neutral subject `{ providerKey: 'descope', issuer, subject }`; the
 * resolver joins it onto the ACTIVE `external_identity_links` row exactly as it
 * does for Clerk. `linkExternalIdentity` and the not-wired lifecycle seams come
 * from the shared base, so link semantics are identical across providers.
 *
 * Issuer recorded on links: the canonical `https://api.descope.com/v1/apps/<DESCOPE_PROJECT_ID>`
 * (the form real session JWTs carry), or `DESCOPE_JWT_ISSUER` when set. The
 * cutover CLI (`packages/db/src/cli/descope-cutover.ts`) derives the same value
 * when it writes the link row; a test pins the two in lockstep. Rows written by
 * the first #889 CLI build may carry the legacy `https://api.descope.com/<id>`.
 * The resolver keys on (provider_key, subject), so an issuer drift cannot
 * fail-close an operator.
 */
import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import {
  DESCOPE_PROVIDER_KEY,
  configuredDescopeIssuer,
  descopeVerifierFactory,
} from "../pos-operators/descope-verifier";
import type { VerifiedSubject } from "./identity-provider.port";
import type { OperatorTokenVerifier } from "./operator-token-verifier";
import { LinkingIdentityProviderAdapter } from "./linking-identity-provider.adapter";

export { DESCOPE_PROVIDER_KEY };

/** Placeholder issuer for a non-production boot without DESCOPE_PROJECT_ID (verifier fails closed). */
const UNCONFIGURED_DESCOPE_ISSUER = "https://api.descope.com/unconfigured";

@Injectable()
export class DescopeIdentityProviderAdapter extends LinkingIdentityProviderAdapter {
  constructor(
    private readonly verifier: OperatorTokenVerifier,
    pool: Pool,
    readonly issuer: string,
  ) {
    super(pool);
  }

  async verifyIdentityToken(rawToken: string): Promise<VerifiedSubject> {
    // The verifier throws on any failure; the resolver collapses it to a refusal.
    const claims = await this.verifier.verify(rawToken);
    return {
      providerKey: DESCOPE_PROVIDER_KEY,
      issuer: this.issuer,
      subject: claims.sub,
    };
  }
}

/**
 * Factory for `IDENTITY_PROVIDER=descope`. The wrapped verifier factory holds
 * the fail-closed posture (DESCOPE_PROJECT_ID required in production).
 */
export function descopeIdentityProviderFactory(pool: Pool): DescopeIdentityProviderAdapter {
  const verifier = descopeVerifierFactory();
  const projectId = (process.env["DESCOPE_PROJECT_ID"] ?? "").trim();
  const issuer = projectId === "" ? UNCONFIGURED_DESCOPE_ISSUER : configuredDescopeIssuer(projectId);
  return new DescopeIdentityProviderAdapter(verifier, pool, issuer);
}
