/**
 * identity-provider.port.ts — 029 DP-2 Provider-Neutral Identity Link (Draft D3).
 *
 * The provider-NEUTRAL seam (028 §16 / DP-2 028 slice §13, named
 * `IdentityProviderPort`) that lifts provider verification + lifecycle one level
 * above the Clerk-concrete `OperatorTokenVerifier`. Operator identity resolution depends
 * on THIS port, never on a provider-typed claim, so a future provider switch
 * (Auth0 / Keycloak / OIDC) is a per-adapter change with no rewrite of the
 * resolver or any business rule (G-5 / 028 OQ-7).
 *
 * PORT RULE (target): provider-specific fields/types MUST NOT leak past the
 * adapter. Callers see only the provider-neutral verified subject
 * (`VerifiedSubject`) and the link. The `providerKey` discriminator lives in the
 * adapter selection + the link row, never in a business rule.
 *
 * v1 SCOPE: only `verifyIdentityToken` and `linkExternalIdentity` are wired live
 * (the resolution path + backfill/provisioning). The remaining operations are
 * DEFINED SEAMS the later lifecycle specs (Console D8 / DP-2 user-admin) consume
 * — defined here so those specs find a ready port (T5). They are intentionally
 * not exercised by D3's resolution path (N-2: no credential / authorization
 * change). The conditional trio (`unlinkExternalIdentity` / `validateWebhook` /
 * `rotateProviderCredential`, 028 §16 marks them conditional) is declared
 * OPTIONAL so an adapter that does not need them need not implement them.
 */

/**
 * The provider-NEUTRAL verified subject `verifyIdentityToken` returns. It is the
 * value the resolver joins on against `external_identity_links`. It carries NO
 * provider-typed claim — `providerKey` is the discriminator, `issuer`/`subject`
 * are the provider's `iss`/`sub` as plain strings.
 */
export interface VerifiedSubject {
  /** Which provider verified the token — 'clerk' in v1. */
  readonly providerKey: string;
  /** The provider's configured issuer (`iss`). */
  readonly issuer: string;
  /** The provider's stable subject (`sub`) — the value clerk_user_id holds today. */
  readonly subject: string;
}

/** A provider-neutral identity-profile read (lifecycle seam). */
export interface IdentityProfile {
  readonly providerKey: string;
  readonly subject: string;
  readonly email?: string;
  readonly displayName?: string;
}

/** Input to record/update an external-identity link to a local user. */
export interface LinkExternalIdentityInput {
  readonly providerKey: string;
  readonly issuer: string;
  readonly subject: string;
  readonly userId: string;
  readonly email?: string;
}

/** Input to create a provider identity (lifecycle seam, downstream). */
export interface CreateIdentityInput {
  readonly email: string;
  readonly displayName?: string;
}

/** Input to invite a user via the provider (lifecycle seam, downstream). */
export interface InviteUserInput {
  readonly email: string;
  readonly redirectUrl?: string;
}

/**
 * IdentityProviderPort — the 028 §16 operation set. The resolver and the
 * backfill/provisioning flows depend on this interface; production wires a
 * single v1 Clerk adapter (`ClerkIdentityProviderAdapter`); tests inject a fake.
 */
export interface IdentityProviderPort {
  // --- wired live in D3 ------------------------------------------------------

  /**
   * Verify a raw provider token at the trust boundary and return a
   * provider-NEUTRAL verified subject. MUST throw on any verification failure
   * (signature, audience, issuer, expiry, JWKS fetch error) — the resolver
   * collapses the throw to a generic refusal (no factor disclosure).
   */
  verifyIdentityToken(rawToken: string): Promise<VerifiedSubject>;

  /**
   * Record/update an `external_identity_links` row joining an external identity
   * to a local `userId`. Used by backfill + the Console-initiated create/invite
   * flow later (D8 / user-admin). Returns the linked row's id.
   */
  linkExternalIdentity(input: LinkExternalIdentityInput): Promise<{ id: string }>;

  // --- defined seams, consumed downstream (T5) -------------------------------

  /** Read-only provider profile fetch (lifecycle seam). */
  getIdentityProfile(subject: string): Promise<IdentityProfile | null>;

  /** Create a provider identity (Console user-admin, downstream). */
  createIdentity(input: CreateIdentityInput): Promise<{ subject: string }>;

  /** Invite a user via the provider (Console user-admin, downstream). */
  inviteUser(input: InviteUserInput): Promise<{ subject: string }>;

  /** Disable a link (flips status -> 'disabled', sets disabled_at). */
  disableIdentity(userId: string): Promise<void>;

  /** Re-enable a previously disabled link (flips status -> 'active'). */
  enableIdentity(userId: string): Promise<void>;

  /** Initiate a provider-driven password reset (Console / DP-2 reset). */
  sendPasswordReset(email: string): Promise<void>;

  // --- conditional (028 §16); OPTIONAL on the port ---------------------------

  /** Remove an external-identity link (conditional). */
  unlinkExternalIdentity?(input: {
    providerKey: string;
    issuer: string;
    subject: string;
  }): Promise<void>;

  /** Validate a provider webhook signature (conditional). */
  validateWebhook?(rawBody: string, signatureHeader: string): Promise<boolean>;

  /** Rotate the provider credential (conditional). */
  rotateProviderCredential?(): Promise<void>;
}

/** DI token for the port (mirrors OPERATOR_TOKEN_VERIFIER). */
export const IDENTITY_PROVIDER_PORT = "IDENTITY_PROVIDER_PORT";
