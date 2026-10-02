-- Auth lookup role template (RT-143). See docs/operations/database-roles.md.
--
-- Run ONCE per environment, by a superuser (BYPASSRLS can only be granted by
-- a superuser), AFTER `migrate up` has created the tables. This file holds NO
-- credential: set the password from the secret manager in a separate, unlogged
-- step, e.g. psql's \password auth_lookup — never put it in this file, in shell
-- history, or in git.
--
-- The API checks these grants at boot in production and refuses to start when
-- a required grant is missing or a forbidden one is present
-- (AUTH_LOOKUP_REQUIRED_GRANTS / AUTH_LOOKUP_FORBIDDEN_GRANTS in
-- apps/api/src/auth/database-pools.ts). Keep this file and that list in step.

CREATE ROLE auth_lookup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;

GRANT USAGE ON SCHEMA public TO auth_lookup;

GRANT SELECT, UPDATE         ON users                   TO auth_lookup;
GRANT SELECT, INSERT, UPDATE ON sessions                TO auth_lookup;
GRANT SELECT, INSERT, UPDATE ON auth_tokens             TO auth_lookup;
GRANT SELECT                 ON devices                 TO auth_lookup;
GRANT SELECT                 ON stores                  TO auth_lookup;
GRANT SELECT                 ON external_identity_links TO auth_lookup;
GRANT SELECT                 ON connector_registration  TO auth_lookup;
GRANT SELECT                 ON pairing_codes           TO auth_lookup;

-- Verify (run as any role): every row must read `t`, and the role must not
-- inherit grants from another role (NOINHERIT above; check pg_auth_members).
SELECT t.tbl, t.priv, has_table_privilege('auth_lookup', t.tbl, t.priv) AS granted
  FROM (VALUES ('users', 'SELECT'), ('users', 'UPDATE'),
               ('sessions', 'SELECT'), ('sessions', 'INSERT'), ('sessions', 'UPDATE'),
               ('auth_tokens', 'SELECT'), ('auth_tokens', 'INSERT'), ('auth_tokens', 'UPDATE'),
               ('devices', 'SELECT'), ('stores', 'SELECT'),
               ('external_identity_links', 'SELECT'),
               ('connector_registration', 'SELECT'), ('pairing_codes', 'SELECT')) AS t(tbl, priv);
