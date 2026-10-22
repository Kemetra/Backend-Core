-- 0073_device_build_identity.down.sql
--
-- RT-719 — rollback for 0073_device_build_identity.sql.
--
-- Drops ONLY the four columns this migration added to `devices` and their four
-- CHECK constraints. IT DISCARDS DATA: every reported build identity. No other
-- column, policy, constraint or table is touched, and no row is removed.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0073-device-build-identity.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

ALTER TABLE devices
  DROP CONSTRAINT IF EXISTS devices_build_identity_consistent,
  DROP CONSTRAINT IF EXISTS devices_reported_app_version_shape,
  DROP CONSTRAINT IF EXISTS devices_reported_contract_pin_shape,
  DROP CONSTRAINT IF EXISTS devices_reported_build_commit_shape;

ALTER TABLE devices
  DROP COLUMN IF EXISTS build_reported_at,
  DROP COLUMN IF EXISTS reported_contract_pin,
  DROP COLUMN IF EXISTS reported_app_version,
  DROP COLUMN IF EXISTS reported_build_commit;

COMMIT;
