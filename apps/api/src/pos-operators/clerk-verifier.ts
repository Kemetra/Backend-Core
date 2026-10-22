/**
 * Clerk JWT verifier — the Clerk adapter of the operator-token seam
 * (`OperatorTokenVerifier`), a narrow wrapper over `@clerk/backend`.
 *
 * Wave 1 verifies the Clerk JWT at the API edge against Clerk's JWKS
 * (signature, `iss`, `aud`, `exp`, `nbf`, `iat`). Fail closed on JWKS
 * fetch error or signature mismatch. The token is verified at the
 * boundary and is **not** propagated past the verifier — it is never
 * logged, persisted, enqueued, or returned in any response (ADR D3 +
 * FR-POS-AUTH-10).
 *
 * The interface exists so tests can substitute a deterministic fake
 * without reaching out to Clerk's JWKS endpoint over the network.
 */
import { Injectable } from "@nestjs/common";
import { verifyToken } from "@data-pulse-2/auth";

import type { OperatorTokenClaims, OperatorTokenVerifier } from "../auth/operator-token-verifier";

/** The provider discriminator Clerk-verified subjects carry. */
export const CLERK_PROVIDER_KEY = "clerk";

/**
 * Production implementation. Reads its configuration from the
 * environment so the AuthModule pattern (factory provider, env-driven)
 * is preserved.
 *
 *   - `CLERK_SECRET_KEY` — Clerk-issued backend secret (required).
 *   - `CLERK_JWT_AUDIENCE` — expected `aud` claim (optional; defaults to
 *     verifier's permissive behaviour when absent).
 *   - `CLERK_AUTHORIZED_PARTIES` — comma-separated `azp` allow-list
 *     (optional).
 */
@Injectable()
export class ClerkBackendVerifier implements OperatorTokenVerifier {
  constructor(
    private readonly secretKey: string,
    private readonly audience?: string,
    private readonly authorizedParties?: string[],
  ) {}

  async verify(rawJwt: string): Promise<OperatorTokenClaims> {
    const payload = await verifyToken(rawJwt, {
      secretKey: this.secretKey,
      ...(this.audience !== undefined ? { audience: this.audience } : {}),
      ...(this.authorizedParties !== undefined
        ? { authorizedParties: this.authorizedParties }
        : {}),
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("clerk verifier: payload missing sub");
    }
    return { providerKey: CLERK_PROVIDER_KEY, sub: payload.sub };
  }
}

/**
 * Clerk factory. `NODE_ENV=production` requires a real `CLERK_SECRET_KEY`;
 * non-production allows boot without one but verification will fail closed at
 * request time (no allow-list shortcut). Which provider's factory runs is
 * decided in one place: `auth/identity-provider.factory.ts`.
 */
export function clerkVerifierFactory(): OperatorTokenVerifier {
  const secret = process.env["CLERK_SECRET_KEY"];
  if (!secret) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "PosOperatorsModule: CLERK_SECRET_KEY is required in production",
      );
    }
    // Non-production fallback: a verifier that always fails closed. Keeps
    // the dev / CI machine bootable without a real Clerk secret while
    // ensuring no request can succeed without one.
    return {
      async verify(): Promise<OperatorTokenClaims> {
        throw new Error(
          "clerk verifier: CLERK_SECRET_KEY not configured (fail closed)",
        );
      },
    };
  }
  const audience = process.env["CLERK_JWT_AUDIENCE"];
  const partiesRaw = process.env["CLERK_AUTHORIZED_PARTIES"];
  const parties = partiesRaw
    ? partiesRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;
  return new ClerkBackendVerifier(secret, audience, parties);
}
