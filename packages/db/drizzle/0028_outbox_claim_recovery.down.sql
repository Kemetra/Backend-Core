-- 0028_outbox_claim_recovery.down.sql
BEGIN;

DROP INDEX IF EXISTS outbox_events_stale_claim_idx;
ALTER TABLE outbox_events DROP COLUMN IF EXISTS claimed_at;

COMMIT;
