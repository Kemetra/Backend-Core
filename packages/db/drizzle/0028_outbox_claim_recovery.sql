-- 0028_outbox_claim_recovery.sql
-- Adds a renewable lease timestamp for outbox claims. Existing claimed rows
-- inherit their last state-transition time so a crashed pre-deployment worker
-- becomes eligible for the bounded recovery sweep.
-- The index uses the same fallback as the sweep because rolling-deploy workers
-- may still create claimed rows with claimed_at NULL.
BEGIN;

ALTER TABLE outbox_events ADD COLUMN claimed_at TIMESTAMPTZ;
UPDATE outbox_events SET claimed_at = updated_at WHERE delivery_state = 'claimed';
-- Legacy workers leave claimed_at untouched on terminal updates. Once a new
-- worker has reclaimed the row, its non-null lease must make those updates
-- fail instead of overwriting the new attempt.
ALTER TABLE outbox_events ADD CONSTRAINT outbox_claimed_at_state_check
  CHECK (delivery_state = 'claimed' OR claimed_at IS NULL);
CREATE INDEX outbox_events_stale_claim_idx ON outbox_events (COALESCE(claimed_at, updated_at))
  WHERE delivery_state = 'claimed';

COMMIT;
