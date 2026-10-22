-- 0068_pos_device_health.down.sql
--
-- RT-327 — rollback for 0068_pos_device_health.sql.
--
-- Drops ONLY the two tables this migration created. DROP TABLE removes each
-- table together with its policies, indexes, CHECK constraints and the FKs it
-- owns (device_id -> devices, tenant_id -> tenants, updated_by_user_id ->
-- users). Nothing references either table, so no dependent-object pre-step is
-- needed, and `devices`, `tenants`, `users` and `audit_events` are untouched.
--
-- IT DISCARDS DATA: every stored heartbeat (device_health) and the per-channel
-- version policy (pos_version_policy). Audit rows `pos.release_policy.changed`
-- are append-only and stay in `audit_events`.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0068-pos-device-health.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

DROP TABLE IF EXISTS device_health;
DROP TABLE IF EXISTS pos_version_policy;

COMMIT;
