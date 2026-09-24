-- 0028_outbox_claim_recovery.sql
-- Adds a renewable lease timestamp for outbox claims. Existing claimed rows
-- inherit their last state-transition time so a crashed pre-deployment worker
-- becomes eligible for the bounded recovery sweep.
BEGIN;

ALTER TABLE outbox_events ADD COLUMN claimed_at TIMESTAMPTZ;
UPDATE outbox_events SET claimed_at = updated_at WHERE delivery_state = 'claimed';
CREATE INDEX outbox_events_stale_claim_idx ON outbox_events (claimed_at)
  WHERE delivery_state = 'claimed';

COMMIT;
