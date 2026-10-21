/**
 * clerk-identity-provider.adapter.ts — 029 DP-2 Provider-Neutral Identity Link.
 *
 * The default implementation of `IdentityProviderPort` (N-6; RT-791 adds the
 * Descope adapter behind the same port, selected by IDENTITY_PROVIDER). It is the seam
 * boundary: above it everything is provider-neutral; below it the Clerk-concrete
 * verification stays contained.
 *
 *   - `verifyIdentityToken` DELEGATES to the existing `OperatorTokenVerifier` (whose
 *     production impl calls `packages/auth`'s `verifyToken`, keeping the
 *     `@clerk/backend` dependency contained in `packages/auth` — E-3). It maps
 *     the Clerk `{ sub }` to a provider-NEUTRAL `VerifiedSubject`
 *     `{ providerKey:'clerk', issuer, subject:sub }`. NOTHING Clerk-typed leaks.
 *   - `linkExternalIdentity` writes/updates an `external_identity_links` row.
 *   - The remaining 028 §16 operations are defined seams (T5); the ones the D8 /
 *     user-admin specs will drive are stubbed here as NOT-YET-WIRED (they throw a
 *     clear "not implemented in D3" error rather than silently no-op), so a
 *     premature caller fails loudly instead of corrupting state. The conditional
 *     trio is omitted entirely (optional on the port).
 *
 * ISSUER provenance (the drift trap): the configured Clerk issuer is the SINGLE
 * source of truth shared with the 0025 backfill. `verifyIdentityToken` returns
 * THIS issuer; the backfill stamps the SAME literal. The resolver join keys on
 * (providerKey, subject) NOT issuer (v1 single-issuer), so even a future issuer
 * drift cannot fail-close an operator — issuer is stored + unique for
 * forward-compat (multi-issuer dual-link).
 *
 * The factory preserves the production fail-closed posture: in production a real
 * `CLERK_SECRET_KEY` is required (via the wrapped `clerkVerifierFactory`); there
 * is no allow-list shortcut.
 */
import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { CLERK_PROVIDER_KEY, clerkVerifierFactory } from "../pos-operators/clerk-verifier";
import type { IdentityProviderPort, VerifiedSubject } from "./identity-provider.port";
import { LinkingIdentityProviderAdapter } from "./linking-identity-provider.adapter";
import type { OperatorTokenVerifier } from "./operator-token-verifier";

export { CLERK_PROVIDER_KEY };

/**
 * The single configured Clerk issuer — the SOURCE OF TRUTH shared with the 0025
 * backfill literal. Read from CLERK_JWT_ISSUER when set; otherwise the stable
 * default the backfill also uses. Keep these two in lockstep.
 */
export const DEFAULT_CLERK_ISSUER = "https://clerk.dp2.local";

export function clerkIssuer(): string {
  const fromEnv = process.env["CLERK_JWT_ISSUER"];
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_CLERK_ISSUER;
}

@Injectable()
export class ClerkIdentityProviderAdapter extends LinkingIdentityProviderAdapter {
  constructor(
    private readonly verifier: OperatorTokenVerifier,
    pool: Pool,
    private readonly issuer: string = clerkIssuer(),
  ) {
    super(pool);
  }

  async verifyIdentityToken(rawToken: string): Promise<VerifiedSubject> {
    // Delegate verification to the contained Clerk seam (E-3). The verifier
    // throws on any failure; we let it propagate so the resolver collapses it.
    const claims = await this.verifier.verify(rawToken);
    // Map to a provider-NEUTRAL subject — no Clerk-typed claim leaks out.
    return {
      providerKey: CLERK_PROVIDER_KEY,
      issuer: this.issuer,
      subject: claims.sub,
    };
  }

  // linkExternalIdentity + the not-wired lifecycle seams live on the shared
  // LinkingIdentityProviderAdapter base (identical for every provider).
}

/** DI token re-export convenience (the canonical token is on the port file). */
export { IDENTITY_PROVIDER_PORT } from "./identity-provider.port";

/**
 * Production factory. Wraps the existing env-driven `clerkVerifierFactory` so the
 * fail-closed posture (CLERK_SECRET_KEY required in production; no allow-list
 * shortcut) is preserved verbatim — the adapter adds the neutral mapping + link
 * write on top, never a new credential path.
 *
 * The Clerk case of the provider switch in `identity-provider.factory.ts`.
 */
export function clerkIdentityProviderFactory(pool: Pool): IdentityProviderPort {
  const verifier: OperatorTokenVerifier = clerkVerifierFactory();
  return new ClerkIdentityProviderAdapter(verifier, pool, clerkIssuer());
}
