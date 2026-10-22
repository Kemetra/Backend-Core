-- Domain-role grants for the POS device heartbeat, the Console device health
-- reads and the platform POS version policy (RT-327, migration 0068).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0068 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/pos-device-health-domain-grants.sql
-- deploy/README.md runs this in step 2 of every release, after
-- inventory-anchors-domain-grants.sql.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, every POS heartbeat store fails (counted `refused`,
-- swallowed) and the Console device health reads and the platform policy
-- routes fail with permission denied. Both tables are FORCE ROW LEVEL
-- SECURITY: device_health by tenant, pos_version_policy readable by every
-- context and writable only in the platform-admin context, so the grants give
-- access only inside runWithTenantContext.
--
-- device_health: SELECT, INSERT, UPDATE. The heartbeat is a last-write-wins
-- upsert (INSERT ... ON CONFLICT DO UPDATE) and the console reads it.
-- pos_version_policy: SELECT, INSERT, UPDATE. The heartbeat and the console
-- read it; the platform change creates a channel's policy and replaces it.
-- Never grant DELETE or TRUNCATE on either: neither has a DELETE policy, and
-- TRUNCATE is not subject to row security.
--
-- The auth lookup role must hold NO privilege on either table
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's rows.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON device_health TO :"domain_role";
GRANT SELECT, INSERT, UPDATE ON pos_version_policy TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('device_health', 'SELECT'),
               ('device_health', 'INSERT'),
               ('device_health', 'UPDATE'),
               ('pos_version_policy', 'SELECT'),
               ('pos_version_policy', 'INSERT'),
               ('pos_version_policy', 'UPDATE')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('device_health', 'SELECT'),
               ('device_health', 'INSERT'),
               ('device_health', 'UPDATE'),
               ('pos_version_policy', 'SELECT'),
               ('pos_version_policy', 'INSERT'),
               ('pos_version_policy', 'UPDATE')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required POS device health grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'POS device health domain grants incomplete'; END $$;
\endif
