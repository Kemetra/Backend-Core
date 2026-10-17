-- Re-baseline device credential expiry (RT-370, RT-138 L2; input from RT-369).
--
-- WHY. Migration 0040 gave every device that existed when it was applied the
-- same `expires_at` (its apply time + 90 days). Those devices therefore
-- expire together and their 7-day rotate-only grace ends together, 97 days
-- after 0040. The grace is NOT gated by DEVICE_TOKEN_EXPIRY_ENFORCED
-- (pos-terminal-pairing.openapi.yaml, "Expiry and the rotate-only grace"):
-- past it a till can never rotate and can only re-pair, even while the flag
-- is off and every other route still accepts its token. And with the flag on,
-- the whole cluster would be refused at once. So run this before 0040 + 97
-- days unless every pilot till runs the RT-373 rotation client by then, and
-- before turning DEVICE_TOKEN_EXPIRY_ENFORCED on.
--
-- WHAT. For every device that is not revoked (a retired device is always
-- revoked) and can still rotate (`now() < expires_at + 168 hours`), the new
-- expiry is
--     today (00:00, database time zone) + min_days + a per-device offset in
--     [0, spread_days)
-- The offset is a hash of the device id, so the cluster becomes a spread of
-- one expiry per device over `spread_days` days, and the tills' rotations
-- (at expires_at - 15 days) spread with it. Deterministic: a re-run with the
-- same parameters on the same day plans the same instants and changes
-- nothing.
-- It only EXTENDS: a device whose expiry is already later keeps it
-- (GREATEST), so a device that rotated is never shortened, and a rotation
-- committed while this runs wins (the UPDATE re-checks on the newest row).
-- It never sets an expiry beyond 90 days from now (a freshly paired or
-- rotated credential's life). Revoked and retired devices are never touched,
-- and neither is a LAPSED device (past its 7-day rotate grace): it can
-- already only re-pair, and extending it would revive a dead credential (an
-- abandoned till nobody revoked). The dry run counts lapsed devices
-- separately so the owner can decide on them (revoke, or re-pair the till).
--
-- This is an owner-run DATA operation, not a migration, and not run by any
-- deploy step. Running it, and turning DEVICE_TOKEN_EXPIRY_ENFORCED on, are
-- owner decisions [GATED]. It writes no audit row: record the dry-run and
-- apply output on the Jira issue. The `devices_set_updated_at` trigger moves
-- `updated_at` on every row it changes.
--
-- HOW. Run as the migration owner (or any role with UPDATE on devices). This
-- file holds NO credential: give psql the connection through libpq
-- environment variables (PGHOST/PGUSER/PGPASSWORD/...), never as a URL
-- argument.
--   1. Dry run (the default): prints the plan, changes nothing.
--        psql -X -f docs/operations/sql/device-expiry-rebaseline.sql
--   2. Apply, with the same parameters:
--        psql -X -v apply=1 -f docs/operations/sql/device-expiry-rebaseline.sql
--   Optional: -v min_days=<n> (default 30), -v spread_days=<n> (default 60);
--   min_days >= 1, spread_days >= 1, min_days + spread_days <= 90.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP).

\set ON_ERROR_STOP on

\if :{?min_days}
\else
  \set min_days 30
\endif
\if :{?spread_days}
\else
  \set spread_days 60
\endif
\if :{?apply}
\else
  \set apply 0
\endif

SELECT (:min_days::int >= 1 AND :spread_days::int >= 1 AND :min_days::int + :spread_days::int <= 90) AS params_ok \gset
\if :params_ok
\else
  \echo 'FAILED: need min_days >= 1, spread_days >= 1 and min_days + spread_days <= 90.'
  DO $$ BEGIN RAISE EXCEPTION 'device expiry rebaseline: invalid parameters'; END $$;
\endif

-- devices is FORCE ROW LEVEL SECURITY: this session acts across tenants.
SELECT set_config('app.is_platform_admin', 'true', false) AS platform_admin \gset

-- The plan: every unrevoked device that can still rotate (inside the 7-day
-- grace of RT-369, ROTATION_GRACE_MS: 168 hours, not '7 days', so a DST
-- change in the session time zone cannot move it), its current and its new
-- expiry.
CREATE TEMP VIEW device_expiry_rebaseline_plan AS
  SELECT d.id,
         d.tenant_id,
         d.expires_at AS current_expires_at,
         GREATEST(
           d.expires_at,
           date_trunc('day', now()) + make_interval(days => :min_days)
                 + make_interval(secs => (
                     ((hashtextextended(d.id::text, 0) % (:spread_days::bigint * 86400))
                       + (:spread_days::bigint * 86400)) % (:spread_days::bigint * 86400)
                   )::double precision)
         ) AS new_expires_at
    FROM devices d
   WHERE d.revoked_at IS NULL
     AND d.expires_at + interval '168 hours' > now();

\echo 'Lapsed (unrevoked, past the 7-day rotate grace): NOT re-baselined; revoke or re-pair them:'
SELECT count(*) AS lapsed_devices, min(expires_at) AS lapsed_min, max(expires_at) AS lapsed_max
  FROM devices
 WHERE revoked_at IS NULL
   AND expires_at + interval '168 hours' <= now();

\echo 'Plan (unrevoked devices that can still rotate):'
SELECT count(*)                                                  AS planned_devices,
       count(*) FILTER (WHERE new_expires_at > current_expires_at) AS would_extend,
       min(current_expires_at)                                   AS current_min,
       max(current_expires_at)                                   AS current_max,
       min(new_expires_at)                                       AS new_min,
       max(new_expires_at)                                       AS new_max
  FROM device_expiry_rebaseline_plan;

\echo 'New expiry per week (after the run):'
SELECT date_trunc('week', new_expires_at) AS week, count(*) AS devices
  FROM device_expiry_rebaseline_plan
 GROUP BY 1
 ORDER BY 1;

\if :apply
  BEGIN;
  UPDATE devices d
     SET expires_at = p.new_expires_at
    FROM device_expiry_rebaseline_plan p
   WHERE d.id = p.id
     AND d.revoked_at IS NULL
     AND d.expires_at + interval '168 hours' > now()
     AND p.new_expires_at > d.expires_at;
  COMMIT;
  \echo 'APPLIED: device expiry re-baselined (see the UPDATE count above).'
\else
  \echo 'DRY RUN: nothing changed. Re-run with -v apply=1 to apply this plan.'
\endif
