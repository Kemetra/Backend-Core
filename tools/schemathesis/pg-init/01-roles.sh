#!/bin/sh
# Runtime roles as in docs/operations/database-roles.md: the domain role is
# NOBYPASSRLS, the pre-tenant auth lookup role is BYPASSRLS. Table grants for
# the lookup role are applied by stack-up.sh after migrations.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v app_pw="$PG_APP_PASSWORD" -v auth_pw="$PG_AUTH_PASSWORD" <<'SQL'
CREATE ROLE fuzz_app  LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_pw';
CREATE ROLE fuzz_auth LOGIN NOSUPERUSER BYPASSRLS   NOCREATEDB NOCREATEROLE PASSWORD :'auth_pw';
GRANT CONNECT ON DATABASE fuzz TO fuzz_app, fuzz_auth;
GRANT USAGE ON SCHEMA public TO fuzz_app, fuzz_auth;
ALTER DEFAULT PRIVILEGES FOR ROLE fuzz_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fuzz_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fuzz_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO fuzz_app;
SQL
