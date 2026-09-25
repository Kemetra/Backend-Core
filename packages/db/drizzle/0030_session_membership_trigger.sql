-- 0030_session_membership_trigger.sql
--
-- #609 — sessions.active_tenant_id is tenant-referencing data and sits
-- upstream of every RLS policy. The application checks membership before
-- writing it; this trigger is the database backstop (§II).
--
-- Platform admins may hold a tenant context without a membership row.
-- Everyone else needs an active, non-deleted membership for
-- (user_id, active_tenant_id).
--
-- SECURITY DEFINER: session writes run before a tenant GUC is set, and
-- memberships is FORCE RLS. An invoker-rights lookup would see no rows
-- and reject every legitimate context switch.
BEGIN;

-- memberships is FORCE RLS. See the rows for this repair only.
SELECT set_config('app.is_platform_admin', 'true', true);

UPDATE sessions AS s
SET active_tenant_id = NULL,
    active_store_id = NULL
WHERE s.active_tenant_id IS NOT NULL
  AND NOT EXISTS (
        SELECT 1 FROM users AS u
        WHERE u.id = s.user_id AND u.is_platform_admin
      )
  AND NOT EXISTS (
        SELECT 1 FROM memberships AS m
        WHERE m.user_id = s.user_id
          AND m.tenant_id = s.active_tenant_id
          AND m.revoked_at IS NULL
          AND m.deleted_at IS NULL
      );

CREATE OR REPLACE FUNCTION sessions_check_active_tenant_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_admin text;
  allowed boolean;
BEGIN
  IF NEW.active_tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.users
    WHERE public.users.id = NEW.user_id
      AND public.users.is_platform_admin
  ) THEN
    RETURN NEW;
  END IF;

  -- FORCE RLS hides memberships unless a tenant or platform-admin GUC is set.
  -- The elevated read is restored before this trigger returns.
  previous_admin := current_setting('app.is_platform_admin', true);
  PERFORM set_config('app.is_platform_admin', 'true', true);
  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM public.memberships
      WHERE public.memberships.user_id = NEW.user_id
        AND public.memberships.tenant_id = NEW.active_tenant_id
        AND public.memberships.revoked_at IS NULL
        AND public.memberships.deleted_at IS NULL
    ) INTO allowed;
    PERFORM set_config('app.is_platform_admin', COALESCE(previous_admin, 'false'), true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.is_platform_admin', COALESCE(previous_admin, 'false'), true);
    RAISE;
  END;

  IF NOT allowed THEN
    RAISE EXCEPTION
      'active_tenant_id % has no active membership for user %',
      NEW.active_tenant_id, NEW.user_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sessions_active_tenant_membership_check ON sessions;

CREATE TRIGGER sessions_active_tenant_membership_check
  BEFORE INSERT OR UPDATE OF active_tenant_id ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION sessions_check_active_tenant_membership();

COMMIT;
