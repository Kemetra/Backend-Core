/**
 * identity-provider.factory.ts — the ONE place that maps `IDENTITY_PROVIDER` to
 * an adapter (RT-796, provider-neutral identity 1/5).
 *
 * Every module that builds an operator-token verifier or an identity adapter
 * calls these two factories, so they switch together. Adding a provider is one
 * adapter file, one entry in `identity-provider-kind.ts` and one case here;
 * nothing else in the codebase names a provider.
 *
 *   - unset / empty → the unchanged default adapter;
 *   - an unknown value throws at boot (`identityProviderKind`, fail closed).
 */
import type { Pool } from "pg";

import { clerkVerifierFactory } from "../pos-operators/clerk-verifier";
import { descopeVerifierFactory } from "../pos-operators/descope-verifier";
import { clerkIdentityProviderFactory } from "./clerk-identity-provider.adapter";
import { descopeIdentityProviderFactory } from "./descope-identity-provider.adapter";
import { identityProviderKind } from "./identity-provider-kind";
import type { IdentityProviderPort } from "./identity-provider.port";
import type { OperatorTokenVerifier } from "./operator-token-verifier";

/** The verifier of the configured provider (`DI`: `OPERATOR_TOKEN_VERIFIER`). */
export function operatorTokenVerifierFactory(): OperatorTokenVerifier {
  const kind = identityProviderKind();
  switch (kind) {
    case "clerk":
      return clerkVerifierFactory();
    case "descope":
      return descopeVerifierFactory();
    default:
      return unsupportedKind(kind);
  }
}

/** The identity adapter of the configured provider (`DI`: `IDENTITY_PROVIDER_PORT`). */
export function identityProviderFactory(pool: Pool): IdentityProviderPort {
  const kind = identityProviderKind();
  switch (kind) {
    case "clerk":
      return clerkIdentityProviderFactory(pool);
    case "descope":
      return descopeIdentityProviderFactory(pool);
    default:
      return unsupportedKind(kind);
  }
}

/** Compile-time exhaustiveness: a kind added to `IdentityProviderKind` without a case here fails the build. */
function unsupportedKind(kind: never): never {
  throw new Error(`Unsupported identity provider: ${String(kind)}`);
}
