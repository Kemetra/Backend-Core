/**
 * identity-link-lookup.ts — the ONE shared lookup of operators through
 * `external_identity_links` (RT-796, provider-neutral identity 1/5).
 *
 * Every POS operator lookup that used to read the `users` bridge column goes
 * through here, keyed by `{ providerKey, subject }` — the pair a verified token
 * yields (`OperatorTokenClaims`) — so no caller names a provider and a new
 * provider needs no change in any of them. Modelled on
 * `PgOperatorContextResolver.findUserByExternalIdentity` (029 D3 / PI-3).
 *
 * Two predicates, deliberately separate. Never swap them between call sites:
 *
 *   (a) ACTIVE link by `(provider_key, subject)` — who is signing in /
 *       whom does this wire id name. A disabled link must NOT resolve, and a pair
 *       that matches more than one active link fails closed.
 *       `findUserByActiveLink`, `activeLinkSubjects`.
 *   (b) ANY link (active or disabled) of a given user — audit alias. An audit
 *       event queued offline under a previous provider's id stays attributable
 *       after a cutover disabled that link. `userIdsLinkedToSubject`.
 *
 * The reads are keyed on `(provider_key, subject)` and not on `issuer`: v1 has
 * a single issuer per provider and keying on it would couple the runtime path
 * to the issuer-string contract of whichever tool wrote the link row.
 *
 * `external_identity_links` is tenant-agnostic (no RLS) and the AUTH LOOKUP role
 * is the one documented to read it (docs/operations/database-roles.md), so
 * callers pass their lookup pool, not a tenant-scoped client of the domain role.
 */
import type { QueryResult, QueryResultRow } from "pg";

/** The provider-neutral key of an external identity: what a verified token names. */
export interface IdentityRef {
  readonly providerKey: string;
  readonly subject: string;
}

/** Anything that runs a parameterized query: a `Pool` or a `PoolClient`. */
export interface LinkQueryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** A user resolved through their ACTIVE link. `operator_id` is that link's subject. */
export interface LinkedUserRow {
  id: string;
  email: string;
  display_name: string | null;
  deleted_at: Date | null;
  /** The subject of the user's active link — the wire id POS keys on. */
  operator_id: string;
}

/**
 * Predicate (a): the user whose ACTIVE link is `(providerKey, subject)`, or null
 * when there is none (the caller refuses `user_unmapped`). A soft-deleted user is
 * returned with `deleted_at` set so the caller can tell `user_disabled` apart.
 *
 * The lookup ignores `issuer`, and uniqueness is on `(provider_key, issuer,
 * subject)`: two active links of different users can share the pair when their
 * issuers differ (a link written by a tool with another issuer string, a bad
 * backfill). Ambiguity fails closed (null, so `user_unmapped`) rather than
 * authenticating whichever row the heap returns first.
 */
export async function findUserByActiveLink(
  db: LinkQueryable,
  ref: IdentityRef,
): Promise<LinkedUserRow | null> {
  const r = await db.query<LinkedUserRow>(
    `SELECT u.id, u.email, u.display_name, u.deleted_at, l.subject AS operator_id
       FROM external_identity_links l
       JOIN users u ON u.id = l.user_id
      WHERE l.provider_key = $1
        AND l.subject = $2
        AND l.status = 'active'
      LIMIT 2`,
    [ref.providerKey, ref.subject],
  );
  return r.rows.length === 1 ? (r.rows[0] ?? null) : null;
}

/**
 * Predicate (a), batched: the subject of each given user's ACTIVE link, by user
 * id. A user with no active link is absent from the map — rosters and
 * eligibility filter on "has an active link". One active link per user is a
 * schema invariant (`external_identity_links_one_active_per_user_uidx`).
 */
export async function activeLinkSubjects(
  db: LinkQueryable,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (userIds.length === 0) return new Map();
  const r = await db.query<{ user_id: string; subject: string }>(
    `SELECT user_id, subject
       FROM external_identity_links
      WHERE status = 'active'
        AND user_id = ANY($1::uuid[])`,
    [[...userIds]],
  );
  return new Map(r.rows.map((row) => [row.user_id, row.subject]));
}

/**
 * Predicate (b): which of `userIds` hold a link — ACTIVE OR DISABLED, any
 * provider — whose subject is `subject`. Audit alias only: the caller has
 * already bound the event to those users through a session, so a subject that
 * was never linked to one of them matches nothing.
 */
export async function userIdsLinkedToSubject(
  db: LinkQueryable,
  userIds: readonly string[],
  subject: string,
): Promise<readonly string[]> {
  if (userIds.length === 0) return [];
  const r = await db.query<{ user_id: string }>(
    `SELECT DISTINCT user_id
       FROM external_identity_links
      WHERE subject = $1
        AND user_id = ANY($2::uuid[])`,
    [subject, [...userIds]],
  );
  return r.rows.map((row) => row.user_id);
}
