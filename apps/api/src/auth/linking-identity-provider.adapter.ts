/**
 * linking-identity-provider.adapter.ts — shared base for the identity adapters.
 *
 * The provider-independent half of `IdentityProviderPort`: the
 * `external_identity_links` upsert and the lifecycle seams that are not wired
 * yet. Each concrete adapter (Clerk, Descope — RT-791) only implements
 * `verifyIdentityToken`, so the link semantics stay identical across providers.
 */
import type { Pool } from "pg";

import type {
  CreateIdentityInput,
  IdentityProfile,
  IdentityProviderPort,
  InviteUserInput,
  LinkExternalIdentityInput,
  VerifiedSubject,
} from "./identity-provider.port";

export abstract class LinkingIdentityProviderAdapter implements IdentityProviderPort {
  protected constructor(protected readonly pool: Pool) {}

  abstract verifyIdentityToken(rawToken: string): Promise<VerifiedSubject>;

  async linkExternalIdentity(
    input: LinkExternalIdentityInput,
  ): Promise<{ id: string }> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO external_identity_links
         (provider_key, issuer, subject, user_id, email, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       ON CONFLICT (provider_key, issuer, subject) DO UPDATE
         SET email = EXCLUDED.email,
             last_verified_at = now(),
             -- RE-ACTIVATE on re-link: a previously disabled link must become
             -- usable again, else the method returns success while the resolver's
             -- active-link join still refuses the user (HIGH-2). status + disabled_at
             -- are flipped together to satisfy the disabled_at_consistent CHECK.
             status = 'active',
             disabled_at = NULL
       RETURNING id`,
      [
        input.providerKey,
        input.issuer,
        input.subject,
        input.userId,
        input.email ?? null,
      ],
    );
    const id = r.rows[0]?.id;
    if (!id) throw new Error("linkExternalIdentity: insert returned no id");
    return { id };
  }

  // --- defined seams, not wired live in D3 (T5) ------------------------------
  // These throw loudly so a premature D3 caller fails fast rather than no-op'ing
  // state. The downstream lifecycle specs (D8 / user-admin) implement them.

  getIdentityProfile(_subject: string): Promise<IdentityProfile | null> {
    return notWired("getIdentityProfile");
  }

  createIdentity(_input: CreateIdentityInput): Promise<{ subject: string }> {
    return notWired("createIdentity");
  }

  inviteUser(_input: InviteUserInput): Promise<{ subject: string }> {
    return notWired("inviteUser");
  }

  disableIdentity(_userId: string): Promise<void> {
    return notWired("disableIdentity");
  }

  enableIdentity(_userId: string): Promise<void> {
    return notWired("enableIdentity");
  }

  sendPasswordReset(_email: string): Promise<void> {
    return notWired("sendPasswordReset");
  }
}

/** A rejected promise (never a synchronous throw) naming the unwired seam. */
function notWired<T>(operation: string): Promise<T> {
  return Promise.reject(new Error(`${operation}: not wired in D3 (lifecycle seam)`));
}
