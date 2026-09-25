-- 0030_session_membership_trigger.down.sql
BEGIN;

DROP TRIGGER IF EXISTS sessions_active_tenant_membership_check ON sessions;
DROP FUNCTION IF EXISTS sessions_check_active_tenant_membership();

COMMIT;
