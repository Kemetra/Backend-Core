-- Domain-role grants for the AI entitlements runtime (RT-664, migration 0055).
-- See docs/operations/database-roles.md.
--
-- OWNER-GATED (owner decision 2026-10-20, RT-664 option B): running this on
-- any lab or live database needs the owner's approval for that environment.
-- It is NOT part of the routine deploy/README step 2.
--
-- Run ONCE per approved environment, AFTER `migrate up` has applied 0055, as
-- the migration owner (or any role allowed to grant on these tables). This file
-- holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/ai-entitlements-domain-grants.sql
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- The tables are NOT in DOMAIN_REQUIRED_GRANTS (apps/api/src/auth/
-- database-pools.ts), so the API boots without these grants: until they are
-- applied, every AI entitlement read and opt-out answers 503
-- `entitlement_unavailable` and every AI run fails closed with no provider
-- call. The tables are FORCE ROW LEVEL
-- SECURITY, so the grants give access only inside runWithTenantContext. The
-- worker shares this role: its reservation sweep (T17) needs the same ledger
-- and counter grants.
--
--   - ai_plan_catalog, ai_plan_catalog_features, ai_plan_catalog_meters:
--     SELECT only. The catalogue is code-owned: a new version is a
--     migration, never a runtime write.
--   - tenant_ai_entitlements: SELECT, INSERT (platform-admin revisions; 0055
--     RLS refuses a tenant self-grant).
--   - tenant_ai_feature_opt_outs: SELECT, INSERT (the owner's opt-out chain).
--   - ai_usage_ledger: SELECT, INSERT. Append-only: NEVER grant UPDATE. The
--     runtime serialises terminal writes on advisory locks, not row locks.
--   - ai_usage_counters: SELECT, INSERT, UPDATE (reserve, commit, release,
--     adjust move `used` / `reserved`; 0055 freezes the row identity).
-- Never grant DELETE or TRUNCATE on any of them: TRUNCATE is not subject to
-- row security, and every row is evidence. The auth lookup role needs no
-- privilege on any of them. Neither rule is checked at API boot (the tables
-- are not in DOMAIN_REQUIRED_GRANTS or AUTH_LOOKUP_FORBIDDEN_GRANTS, owner
-- decision 2026-10-20); the verification below refuses a domain role that
-- holds a forbidden privilege, and the 0055 triggers refuse UPDATE, DELETE
-- and TRUNCATE on the ledger for every role.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT ON ai_plan_catalog TO :"domain_role";
GRANT SELECT ON ai_plan_catalog_features TO :"domain_role";
GRANT SELECT ON ai_plan_catalog_meters TO :"domain_role";
GRANT SELECT, INSERT ON tenant_ai_entitlements TO :"domain_role";
GRANT SELECT, INSERT ON tenant_ai_feature_opt_outs TO :"domain_role";
GRANT SELECT, INSERT ON ai_usage_ledger TO :"domain_role";
GRANT SELECT, INSERT, UPDATE ON ai_usage_counters TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('ai_plan_catalog', 'SELECT'), ('ai_plan_catalog_features', 'SELECT'),
               ('ai_plan_catalog_meters', 'SELECT'),
               ('tenant_ai_entitlements', 'SELECT'), ('tenant_ai_entitlements', 'INSERT'),
               ('tenant_ai_feature_opt_outs', 'SELECT'), ('tenant_ai_feature_opt_outs', 'INSERT'),
               ('ai_usage_ledger', 'SELECT'), ('ai_usage_ledger', 'INSERT'),
               ('ai_usage_counters', 'SELECT'), ('ai_usage_counters', 'INSERT'),
               ('ai_usage_counters', 'UPDATE')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('ai_plan_catalog', 'SELECT'), ('ai_plan_catalog_features', 'SELECT'),
               ('ai_plan_catalog_meters', 'SELECT'),
               ('tenant_ai_entitlements', 'SELECT'), ('tenant_ai_entitlements', 'INSERT'),
               ('tenant_ai_feature_opt_outs', 'SELECT'), ('tenant_ai_feature_opt_outs', 'INSERT'),
               ('ai_usage_ledger', 'SELECT'), ('ai_usage_ledger', 'INSERT'),
               ('ai_usage_counters', 'SELECT'), ('ai_usage_counters', 'INSERT'),
               ('ai_usage_counters', 'UPDATE')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required AI entitlements grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'AI entitlements domain grants incomplete'; END $$;
\endif

-- Verify the domain role holds NO forbidden privilege (none may read `t`).
SELECT NOT bool_or(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS forbidden_ok
  FROM (VALUES ('ai_usage_ledger', 'UPDATE'), ('ai_usage_ledger', 'DELETE'), ('ai_usage_ledger', 'TRUNCATE'),
               ('ai_usage_counters', 'DELETE'), ('ai_usage_counters', 'TRUNCATE'),
               ('tenant_ai_entitlements', 'UPDATE'), ('tenant_ai_entitlements', 'DELETE'),
               ('tenant_ai_entitlements', 'TRUNCATE'),
               ('tenant_ai_feature_opt_outs', 'UPDATE'), ('tenant_ai_feature_opt_outs', 'DELETE'),
               ('tenant_ai_feature_opt_outs', 'TRUNCATE'),
               ('ai_plan_catalog', 'INSERT'), ('ai_plan_catalog_features', 'INSERT'),
               ('ai_plan_catalog_meters', 'INSERT')) AS t(tbl, priv) \gset

\if :forbidden_ok
  \echo 'OK: domain role holds no forbidden AI entitlements privilege.'
\else
  \echo 'FAILED: the domain role holds UPDATE/DELETE/TRUNCATE on an append-only AI table or a catalogue write.'
  DO $$ BEGIN RAISE EXCEPTION 'AI entitlements domain role over-privileged'; END $$;
\endif
