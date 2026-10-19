-- 0055_ai_entitlements_usage.down.sql
--
-- Rollback for 0055_ai_entitlements_usage.sql (RT-663). Drops, in FK order:
-- the usage ledger, the usage counters, the tenant opt-outs, the entitlement
-- revisions and the plan catalog (meters, features, versions), then the
-- trigger functions. Their triggers, policies and indexes go with the tables.
-- No older object is altered by 0055, so nothing else is restored.
--
-- DATA LOSS once RT-664 has written data: every entitlement revision, tenant
-- opt-out, usage counter and ledger row (with its AI run metadata) is LOST.
-- Roll back RT-664 first, and take a backup if the usage history matters.
--
-- Locks: as in the up migration, lock_timeout = 2s and the FK parents locked
-- up front. On a timeout the down rolls back with nothing changed; retry when
-- the blocking transaction has ended.

BEGIN;

SET LOCAL lock_timeout = '2s';

LOCK TABLE tenants, stores, users IN SHARE ROW EXCLUSIVE MODE;

DROP TABLE IF EXISTS ai_usage_ledger;
DROP FUNCTION IF EXISTS ai_usage_ledger_terminal_guard();

DROP TABLE IF EXISTS ai_usage_counters;
DROP FUNCTION IF EXISTS ai_usage_counters_guard();

DROP TABLE IF EXISTS tenant_ai_feature_opt_outs;
DROP TABLE IF EXISTS tenant_ai_entitlements;

DROP TABLE IF EXISTS ai_plan_catalog_meters;
DROP TABLE IF EXISTS ai_plan_catalog_features;
DROP TABLE IF EXISTS ai_plan_catalog;

DROP FUNCTION IF EXISTS ai_entitlements_append_only();

COMMIT;
