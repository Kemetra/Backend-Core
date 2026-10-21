/**
 * operator-token-verifier.ts — the provider-NEUTRAL operator-token seam
 * (RT-796, provider-neutral identity 1/5).
 *
 * Every POS operator route verifies a bearer identity token at the API edge.
 * The services depend on THIS seam, never on a provider SDK: a provider adapter
 * (see `identity-provider.factory.ts` for the one place that selects it)
 * implements `OperatorTokenVerifier` and names itself in `providerKey`, so
 * adding a provider is one adapter plus one switch case.
 *
 * The token is verified at the boundary and is NOT propagated past the
 * verifier — it is never logged, persisted, enqueued, or returned in any
 * response (ADR D3 + FR-POS-AUTH-10). The interface exists so tests can
 * substitute a deterministic fake without reaching a provider's JWKS endpoint.
 */

/**
 * The minimum surface the operator routes need from a verified token.
 *   - `providerKey` names the provider that verified it. It is the discriminator
 *     of the identity link the subject is looked up on.
 *   - `sub` is the provider's stable subject for the operator.
 */
export interface OperatorTokenClaims {
  readonly providerKey: string;
  readonly sub: string;
}

/**
 * Verifier seam. Implementations MUST throw on any verification failure
 * (signature, audience, issuer, expiry, JWKS fetch error). The thrown error is
 * caught at the controller boundary and rendered as the generic 401 envelope —
 * the cause is never returned to the client.
 */
export interface OperatorTokenVerifier {
  verify(rawJwt: string): Promise<OperatorTokenClaims>;
}

/** DI token for test override. */
export const OPERATOR_TOKEN_VERIFIER = "OPERATOR_TOKEN_VERIFIER";
