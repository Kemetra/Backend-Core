-- 0034_audit_events_append_only.sql
--
-- RT-133 (RT-120 C-1) — enforce audit_events append-only at the database
-- boundary. [GATED] migration, authorized by Jira RT-133.
--
-- Background
-- ----------
-- Append-only was enforced only at the application layer (no update/delete
-- surface in AuditRepository / AuditService / AuditController). At the DB
-- layer, the domain role could UPDATE a same-tenant row, and a DELETE under the
-- platform-admin GUC removed every tenant's rows (RT-120 C-1, proven on PG16).
-- Runtime role grants are provisioned outside migrations
-- (docs/operations/database-roles.md), so a REVOKE here could not reliably
-- target the production domain role. A trigger holds for every role,
-- including the table owner.
--
-- What stays possible
-- -------------------
--   1. INSERT — the only way audit facts are written.
--   2. Retention marking (0004 / 0005): setting retention_marked_at once, from
--      NULL to a timestamp, with every other column unchanged. Who may do it is
--      still governed by the 0005 column grant. Retention never deletes rows.
--   3. The schema's own ON DELETE SET NULL on actor_user_id / store_id, when a
--      referenced user or store is hard-deleted. It is accepted only when it
--      runs inside the foreign key's referential action (trigger depth > 1)
--      and only nulls those two columns.
--
-- Everything else — any other UPDATE, any DELETE, TRUNCATE — is refused with
-- SQLSTATE 42501 (insufficient_privilege). Break-glass needs a deliberate DDL
-- step (dropping or disabling these triggers), which is itself auditable.
--
-- Reversal: 0034_audit_events_append_only.down.sql

BEGIN;

CREATE OR REPLACE FUNCTION audit_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- (2) Retention marking: once, and nothing else changes.
    IF OLD.retention_marked_at IS NULL
       AND NEW.retention_marked_at IS NOT NULL
       AND (to_jsonb(NEW) - 'retention_marked_at')
           = (to_jsonb(OLD) - 'retention_marked_at') THEN
      RETURN NEW;
    END IF;

    -- (3) The declared ON DELETE SET NULL, run by the FK's referential action.
    IF pg_trigger_depth() > 1
       AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id = OLD.actor_user_id)
       AND (NEW.store_id IS NULL OR NEW.store_id = OLD.store_id)
       AND (to_jsonb(NEW) - 'actor_user_id' - 'store_id')
           = (to_jsonb(OLD) - 'actor_user_id' - 'store_id') THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Audit facts can only be inserted (RT-133).';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only_row ON audit_events;
CREATE TRIGGER audit_events_append_only_row
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

DROP TRIGGER IF EXISTS audit_events_append_only_truncate ON audit_events;
CREATE TRIGGER audit_events_append_only_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

COMMIT;
