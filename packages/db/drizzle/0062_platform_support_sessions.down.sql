-- 0062_platform_support_sessions.down.sql
--
-- Rollback for 0062_platform_support_sessions.sql (RT-414). Drops the table
-- (its triggers, policy and indexes go with it), then its guard function. No
-- older object is altered by 0062, so nothing else is restored.
--
-- DATA LOSS: every support session row is LOST. Their audit_events rows
-- (platform.support_session.* and platform.cross_tenant.accessed) are kept.
-- Roll back the RT-414 runtime first.
--
-- Lock impact: DROP TABLE takes ACCESS EXCLUSIVE on the dropped table and on
-- the tables its FKs reference (sessions, users, tenants), so auth lookups
-- wait for this short transaction. The locks are taken up front, so none is
-- upgraded mid-transaction; lock_timeout bounds each wait at 2s. On a
-- timeout the down rolls back with nothing changed; retry later.

BEGIN;

SET LOCAL lock_timeout = '2s';

LOCK TABLE sessions, users, tenants IN ACCESS EXCLUSIVE MODE;

DROP TABLE IF EXISTS platform_support_sessions;
DROP FUNCTION IF EXISTS platform_support_sessions_guard();

COMMIT;
