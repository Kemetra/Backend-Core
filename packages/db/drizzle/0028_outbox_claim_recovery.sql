-- 0028_outbox_claim_recovery.sql
-- Adds a renewable lease timestamp for outbox claims. Existing claimed rows
-- inherit their last state-transition time so a crashed pre-deployment worker
-- becomes eligible for the bounded recovery sweep.
-- The index uses the same fallback as the sweep because rolling-deploy workers
-- may still create claimed rows with claimed_at NULL.
BEGIN;

ALTER TABLE outbox_events ADD COLUMN claimed_at TIMESTAMPTZ;
UPDATE outbox_events SET claimed_at = updated_at WHERE delivery_state = 'claimed';
CREATE INDEX outbox_events_stale_claim_idx ON outbox_events (COALESCE(claimed_at, updated_at))
  WHERE delivery_state = 'claimed';

COMMIT;
