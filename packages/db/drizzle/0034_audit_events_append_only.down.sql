-- 0034_audit_events_append_only.down.sql
--
-- Rollback for 0034_audit_events_append_only.sql (RT-133). Removes the
-- append-only triggers and their function. audit_events rows are untouched;
-- after rollback, append-only is again enforced only at the application layer.

BEGIN;

DROP TRIGGER IF EXISTS audit_events_append_only_truncate ON audit_events;
DROP TRIGGER IF EXISTS audit_events_append_only_row ON audit_events;
DROP FUNCTION IF EXISTS audit_events_append_only();

COMMIT;
