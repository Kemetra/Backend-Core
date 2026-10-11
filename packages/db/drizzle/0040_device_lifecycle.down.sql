-- 0040_device_lifecycle.down.sql
--
-- Rollback for 0040_device_lifecycle.sql (RT-364). Drops the device lifecycle
-- columns and pairing_codes.replaces_device_id. Revoke reasons/notes, retire
-- records, expiry and last-seen values are LOST on rollback (revoked_at itself
-- is kept, so no revoked device becomes active); take a backup first.
--
-- Safe while no deployed API declares these columns (true until RT-365). Once
-- RT-365 code is live, its Drizzle `select()` names these columns: rolling this
-- back under it breaks every till's device lookup, so roll the API back first.

BEGIN;

DROP INDEX IF EXISTS pairing_codes_replaces_pending_idx;
ALTER TABLE pairing_codes DROP COLUMN IF EXISTS replaces_device_id;

DROP INDEX IF EXISTS devices_previous_token_hash_uk;

ALTER TABLE devices
  DROP CONSTRAINT IF EXISTS devices_revoke_reason_valid,
  DROP CONSTRAINT IF EXISTS devices_revoke_attribution_when_revoked,
  DROP CONSTRAINT IF EXISTS devices_revoke_note_shape,
  DROP CONSTRAINT IF EXISTS devices_revoke_other_requires_note,
  DROP CONSTRAINT IF EXISTS devices_previous_token_pair,
  DROP CONSTRAINT IF EXISTS devices_retired_implies_revoked,
  DROP CONSTRAINT IF EXISTS devices_retire_fields_when_retired,
  DROP CONSTRAINT IF EXISTS devices_retire_reason_shape;

ALTER TABLE devices
  DROP COLUMN IF EXISTS retire_reason,
  DROP COLUMN IF EXISTS retired_by,
  DROP COLUMN IF EXISTS retired_at,
  DROP COLUMN IF EXISTS previous_valid_until,
  DROP COLUMN IF EXISTS previous_token_hash,
  DROP COLUMN IF EXISTS revoke_note,
  DROP COLUMN IF EXISTS revoke_reason,
  DROP COLUMN IF EXISTS revoked_by,
  DROP COLUMN IF EXISTS last_seen_at,
  DROP COLUMN IF EXISTS expires_at;

COMMIT;
