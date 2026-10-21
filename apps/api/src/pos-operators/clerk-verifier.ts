/**
 * Clerk JWT verifier — narrow seam over `@clerk/backend`.
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

import { identityProviderKind } from "../auth/identity-provider-kind";
import { descopeVerifierFactory } from "./descope-verifier";

/**
 * Minimum surface POS-Pulse needs from a verified Clerk JWT.
 *   - `sub` is the stable Clerk subject (matches `users.clerk_user_id`).
 */
export interface ClerkVerifiedClaims {
  sub: string;
}

/**
 * Verifier seam. Implementations MUST throw on any verification failure
 * (signature, audience, issuer, expiry, JWKS fetch error). The thrown
 * error is caught at the controller boundary and rendered as the
 * generic 401 envelope — the cause is never returned to the client.
 */
export interface ClerkVerifier {
  verify(rawJwt: string): Promise<ClerkVerifiedClaims>;
}

/** DI token for test override. */
export const CLERK_VERIFIER = "CLERK_VERIFIER";

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
export class ClerkBackendVerifier implements ClerkVerifier {
  constructor(
    private readonly secretKey: string,
    private readonly audience?: string,
    private readonly authorizedParties?: string[],
  ) {}

  async verify(rawJwt: string): Promise<ClerkVerifiedClaims> {
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
    return { sub: payload.sub };
  }
}

/**
 * Factory used by the module wiring. `NODE_ENV=production` requires a
 * real `CLERK_SECRET_KEY`; non-production allows boot without one but
 * verification will fail closed at request time (no allow-list shortcut).
 *
 * RT-791: `IDENTITY_PROVIDER=descope` returns the Descope JWKS verifier instead
 * (same seam; `DESCOPE_PROJECT_ID` required in production, CLERK_SECRET_KEY
 * not). Unset keeps Clerk; an unknown value throws at boot.
 */
export function clerkVerifierFactory(): ClerkVerifier {
  if (identityProviderKind() === "descope") return descopeVerifierFactory();
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
      async verify(): Promise<ClerkVerifiedClaims> {
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
