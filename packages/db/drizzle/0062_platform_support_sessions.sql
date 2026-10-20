-- 0062_platform_support_sessions.sql
--
-- Platform support sessions (Jira RT-414, RT-391 P0-a, owner decision D2).
-- [GATED] migration, approved 2026-10-21 by the coordinating session under the
-- owner's delegation (additive, reversible, RT-142 RLS pinning unchanged).
-- Contract: packages/contracts/openapi/platform-support-sessions.openapi.yaml.
--
-- A platform admin enters a tenant they are not a member of only through a
-- support session: a mandatory purpose, an optional ticket reference, a
-- 60-minute server-side expiry renewable up to opened_at + 8 hours, bound to
-- ONE dashboard auth session, ONE user and ONE tenant. This table holds that
-- state. Audit rows cannot hold it: audit emission is asynchronous.
--
-- Changes, in order:
--   1. platform_support_sessions — one row per support session. Identity
--      (auth session, user, tenant, purpose, ticket_ref, opened_at,
--      renewal_cap_at) is frozen at insert. Only renewed_at / expires_at
--      (renewal) and ended_at / end_reason (end) move, and an ended row is
--      frozen for good. At most one live (not ended) row per auth session
--      (partial unique index). expires_at never passes renewal_cap_at, and
--      renewal_cap_at is exactly opened_at + 8 hours (RT-414 decision 2).
--   2. Guards: DELETE and TRUNCATE are refused for every role, the owner
--      included (42501, the 0034 precedent); UPDATE may touch only the four
--      moving columns, and never an ended row.
--
-- Isolation: RLS ENABLED + FORCED. The only policy admits the platform-admin
-- GUC (app.is_platform_admin = 'true', set by runWithTenantContext). Tenant
-- contexts never read this table: a tenant's owner and tenant_admin see
-- support sessions through their audit_events rows (listAuditEvents), not
-- here. RT-142 is unchanged: domain services still pin
-- isPlatformAdmin:false inside the selected tenant, so they cannot read it.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV)
-- ---------------------------------------------------------------------------
-- SECURITY / ACCESS-RECORD class: identifiers (support session, auth session,
-- user, tenant), timestamps, enum values (purpose, end_reason) and an optional
-- ticket reference constrained to ^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,63}$ (no
-- whitespace, no '@': it cannot hold an email address or free text). No email,
-- token, secret, credential or customer datum.
-- Retention: follows the audit retention rule (RT-34, 0004/0034). Rows are
-- never deleted by the application or by any sweep; this migration adds no
-- sweep. The durable record of each session is its audit_events rows.
--
-- Lock impact (one transaction; every lock is held until COMMIT): only a new
-- table is created. sessions, users and tenants get SHARE ROW EXCLUSIVE for
-- the new FKs, taken up front under lock_timeout = 2s (the 0047 / 0055
-- precedent): their writes (sign-in, context switch) wait until COMMIT, reads
-- continue. No existing table is altered or scanned. Expected well under a
-- second. On a lock timeout, `migrate up` exits non-zero with nothing applied;
-- retry when the blocking transaction has ended.
-- Grants: none here. Runtime grants are provisioned outside migrations:
-- docs/operations/sql/platform-support-sessions-domain-grants.sql (deploy
-- step 2), checked at boot by DOMAIN_REQUIRED_GRANTS.
--
-- Rollback: 0062_platform_support_sessions.down.sql drops the table and its
-- functions. It DISCARDS every support session row (their audit_events rows
-- stay). Roll back the RT-414 runtime first: without the table, a platform
-- admin cannot enter a non-member tenant at all (fails closed).
--
-- Numbering: the latest migration on main is 0061_posting_status_legacy_posted_idx;
-- this is 0062. If another migration lands first, renumber these files and
-- update EXPECTED_MIGRATIONS in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

LOCK TABLE sessions, users, tenants IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE platform_support_sessions (
  id              uuid PRIMARY KEY,
  auth_session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE RESTRICT,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  purpose         text NOT NULL
    CONSTRAINT platform_support_sessions_purpose_check
    CHECK (purpose IN ('customer_support', 'incident', 'onboarding')),
  ticket_ref      text
    CONSTRAINT platform_support_sessions_ticket_ref_check
    CHECK (ticket_ref IS NULL OR ticket_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,63}$'),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  renewed_at      timestamptz,
  expires_at      timestamptz NOT NULL,
  renewal_cap_at  timestamptz NOT NULL,
  ended_at        timestamptz,
  end_reason      text
    CONSTRAINT platform_support_sessions_end_reason_check
    CHECK (end_reason IS NULL OR end_reason IN ('operator', 'replaced', 'tenant_switched', 'signed_out')),
  CONSTRAINT platform_support_sessions_cap_check
    CHECK (renewal_cap_at = opened_at + interval '8 hours'),
  CONSTRAINT platform_support_sessions_expiry_check
    CHECK (expires_at > opened_at AND expires_at <= renewal_cap_at),
  CONSTRAINT platform_support_sessions_renewed_check
    CHECK (renewed_at IS NULL OR renewed_at >= opened_at),
  CONSTRAINT platform_support_sessions_ended_check
    CHECK ((ended_at IS NULL) = (end_reason IS NULL)
           AND (ended_at IS NULL OR ended_at >= opened_at))
);

-- One live support session per auth session (RT-414 contract).
CREATE UNIQUE INDEX platform_support_sessions_live_auth_session_idx
  ON platform_support_sessions (auth_session_id)
  WHERE ended_at IS NULL;

-- Platform-scope reads by tenant and time (future support review).
CREATE INDEX platform_support_sessions_tenant_opened_idx
  ON platform_support_sessions (tenant_id, opened_at DESC);

CREATE FUNCTION platform_support_sessions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'platform_support_sessions rows are never deleted: % is not permitted', TG_OP
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'End a support session (ended_at, end_reason); its row is kept (RT-414).';
  END IF;

  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'platform_support_sessions row % has ended and is frozen', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.auth_session_id IS DISTINCT FROM OLD.auth_session_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.ticket_ref IS DISTINCT FROM OLD.ticket_ref
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.renewal_cap_at IS DISTINCT FROM OLD.renewal_cap_at THEN
    RAISE EXCEPTION 'platform_support_sessions identity columns are frozen'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Only renewed_at, expires_at, ended_at and end_reason may change; open a new support session instead (RT-414).';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER platform_support_sessions_guard_row
  BEFORE UPDATE OR DELETE ON platform_support_sessions
  FOR EACH ROW EXECUTE FUNCTION platform_support_sessions_guard();

CREATE TRIGGER platform_support_sessions_guard_truncate
  BEFORE TRUNCATE ON platform_support_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION platform_support_sessions_guard();

ALTER TABLE platform_support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_support_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_support_sessions_platform_admin ON platform_support_sessions
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMIT;
