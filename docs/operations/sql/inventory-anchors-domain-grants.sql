-- Domain-role grants for the Inventory Anchors taken at sale-effects
-- activation (RT-427, migration 0063).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0063, as the
-- migration owner (or any role allowed to grant on these tables). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/inventory-anchors-domain-grants.sql
-- deploy/README.md runs this in step 2 of every release, after
-- platform-support-sessions-domain-grants.sql.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, activation and the anchor comparison fail with
-- permission denied. Both tables are FORCE ROW LEVEL SECURITY, so the grants
-- give access only inside a tenant context.
--
-- inventory_anchors, inventory_anchor_lines: SELECT and INSERT only. They have
-- no UPDATE or DELETE policy; an anchor is immutable (a re-baseline adds a
-- generation). Never grant UPDATE, DELETE or TRUNCATE: TRUNCATE is not subject
-- to row security. The activation flag lives on tenant_inventory_settings,
-- whose grants come from inventory-position-events-domain-grants.sql (0056).

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT ON inventory_anchors TO :"domain_role";
GRANT SELECT, INSERT ON inventory_anchor_lines TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('inventory_anchors', 'SELECT'),
               ('inventory_anchors', 'INSERT'),
               ('inventory_anchor_lines', 'SELECT'),
               ('inventory_anchor_lines', 'INSERT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('inventory_anchors', 'SELECT'),
               ('inventory_anchors', 'INSERT'),
               ('inventory_anchor_lines', 'SELECT'),
               ('inventory_anchor_lines', 'INSERT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required inventory anchor grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'inventory anchors domain grants incomplete'; END $$;
\endif
