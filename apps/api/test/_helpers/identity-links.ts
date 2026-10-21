/**
 * Fixture helper: give every seeded user that carries a `clerk_user_id` the
 * ACTIVE `clerk` identity link migration 0025 would have backfilled.
 *
 * Operator lookups resolve through `external_identity_links` (RT-796), so a
 * fixture that seeds `users.clerk_user_id` alone describes a user production
 * cannot have after the backfill. Idempotent; call it after seeding users.
 * Fixtures that model another provider insert their own link instead.
 */
export interface QueryRunner {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export async function linkClerkUsers(db: QueryRunner): Promise<void> {
  await db.query(
    `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status)
     SELECT 'clerk', 'https://clerk.dp2.local', u.clerk_user_id, u.id, 'active'
       FROM users u
      WHERE u.clerk_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM external_identity_links l WHERE l.user_id = u.id AND l.status = 'active')
     ON CONFLICT (provider_key, issuer, subject) DO NOTHING`,
  );
}
