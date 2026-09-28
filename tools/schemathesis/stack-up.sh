#!/usr/bin/env bash
# Bring up the ephemeral Backend-Core stack for the Schemathesis job (RT-59)
# and mint a throwaway owner session. See tools/schemathesis/README.md.
#
# Writes $FUZZ_OUT/cookie (the dp2_session value) for run.sh. Never prints it.
# Tear down with: docker compose -p "$FUZZ_PROJECT" -f tools/schemathesis/compose.yml down -v
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash only; no effect on Linux

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/tools/schemathesis"
export FUZZ_PROJECT="${FUZZ_PROJECT:-api-fuzz}"
export API_PORT="${API_PORT:-23000}"
export API_IMAGE="${API_IMAGE:-api-fuzz-api:local}"
MIGRATE_IMAGE="${MIGRATE_IMAGE:-api-fuzz-migrate:local}"
FUZZ_OUT="${FUZZ_OUT:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/api-fuzz}"
mkdir -p "$FUZZ_OUT"

secret() { openssl rand -hex 16; }
mask() { if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::add-mask::$1"; fi; }
# HTTP status of a request. The body goes to stdout and is dropped here;
# avoids `-o /dev/null`, which Git Bash's curl cannot open with MSYS_NO_PATHCONV.
http_status() { curl -s -o - -w '\n%{http_code}' "$@" | tail -n 1; }

export PG_OWNER_PASSWORD PG_APP_PASSWORD PG_AUTH_PASSWORD REDIS_PASSWORD
PG_OWNER_PASSWORD="$(secret)"
PG_APP_PASSWORD="$(secret)"
PG_AUTH_PASSWORD="$(secret)"
REDIS_PASSWORD="$(secret)"
ADMIN_PASSWORD="$(secret)"
for s in "$PG_OWNER_PASSWORD" "$PG_APP_PASSWORD" "$PG_AUTH_PASSWORD" "$REDIS_PASSWORD" "$ADMIN_PASSWORD"; do mask "$s"; done
# The teardown step needs the same compose variables.
printf 'PG_OWNER_PASSWORD=%s\nPG_APP_PASSWORD=%s\nPG_AUTH_PASSWORD=%s\nREDIS_PASSWORD=%s\n' \
  "$PG_OWNER_PASSWORD" "$PG_APP_PASSWORD" "$PG_AUTH_PASSWORD" "$REDIS_PASSWORD" >"$FUZZ_OUT/stack.env"

compose() { docker compose -p "$FUZZ_PROJECT" -f "$HERE/compose.yml" "$@"; }
psql_owner() { compose exec -T postgres psql -v ON_ERROR_STOP=1 -U fuzz_owner -d fuzz -qAt "$@"; }
owner_url="postgres://fuzz_owner:$PG_OWNER_PASSWORD@postgres:5432/fuzz"
net="${FUZZ_PROJECT}_default"

if [ -z "${SKIP_BUILD:-}" ]; then
  echo "Building images"
  docker build -q --target api -t "$API_IMAGE" "$ROOT" >/dev/null
  docker build -q --target migrate -t "$MIGRATE_IMAGE" "$ROOT" >/dev/null
fi

echo "Starting postgres and redis"
compose up -d --wait postgres redis

echo "Migrating"
docker run --rm --network "$net" -e NODE_ENV=production -e DATABASE_URL="$owner_url" "$MIGRATE_IMAGE" >/dev/null

echo "Granting the auth lookup role its documented table access"
psql_owner <<'SQL'
DO $$ DECLARE t text; g text; BEGIN
  FOR t, g IN SELECT * FROM (VALUES
    ('users', 'SELECT, UPDATE'), ('sessions', 'SELECT, INSERT, UPDATE'),
    ('auth_tokens', 'SELECT, INSERT, UPDATE'), ('devices', 'SELECT'), ('stores', 'SELECT'),
    ('external_identity_links', 'SELECT'), ('connector_registration', 'SELECT'),
    ('pairing_codes', 'SELECT')) v(t, g)
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN EXECUTE format('GRANT %s ON %I TO fuzz_auth', g, t); END IF;
  END LOOP;
END $$;
SQL

echo "Seeding tenant, roles and store"
tenant=$(docker run --rm --network "$net" -e NODE_ENV=production -e DATABASE_URL="$owner_url" \
  -e CLERK_OPERATOR_SUBJECT=user_fuzz_dummy_subject -e PILOT_TENANT_SLUG=fuzz \
  "$MIGRATE_IMAGE" node dist/cli/bootstrap-pilot.js | sed -n 's/.*"tenant_id": "\([^"]*\)".*/\1/p')
[ -n "$tenant" ] || { echo "bootstrap-pilot did not return a tenant id" >&2; exit 1; }

echo "Creating the owner user"
hash=$(docker run --rm -e PW="$ADMIN_PASSWORD" --entrypoint node "$API_IMAGE" -e \
  'require("/app/node_modules/@data-pulse-2/auth/dist/passwords.js").hashPassword(process.env.PW).then((h) => process.stdout.write(h))')
case "$hash" in '$argon2id$'*) ;; *) echo "unexpected password hash format" >&2; exit 1 ;; esac
psql_owner -v h="$hash" -v t="$tenant" >/dev/null <<'SQL'
BEGIN;
SELECT set_config('app.current_tenant', :'t', true);
SELECT set_config('app.is_platform_admin', 'true', true);
WITH u AS (
  INSERT INTO users (id, email, email_verified_at, password_hash, display_name)
  VALUES (gen_random_uuid(), 'fuzz-owner@example.invalid', now(), :'h', 'Fuzz Owner') RETURNING id)
INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
SELECT gen_random_uuid(), :'t', u.id, r.id, 'all' FROM u JOIN roles r ON r.tenant_id = :'t' AND r.code = 'owner';
COMMIT;
SQL

echo "Starting the API"
compose up -d api
base="http://127.0.0.1:$API_PORT"
code=000
for _ in $(seq 1 90); do
  code=$(http_status -X POST "$base/api/v1/auth/signin" -H 'content-type: application/json' -d '{}' || true)
  [ "$code" = "400" ] && break
  sleep 1
done
[ "$code" = "400" ] || { echo "API did not become ready" >&2; compose logs api | tail -50 >&2; exit 1; }

echo "Signing in"
signin=$(curl -s -D - -o - -X POST "$base/api/v1/auth/signin" -H 'content-type: application/json' \
  -d "{\"email\":\"fuzz-owner@example.invalid\",\"password\":\"$ADMIN_PASSWORD\"}" || true)
cookie=$(printf '%s\n' "$signin" | sed -n 's/^[Ss]et-[Cc]ookie: dp2_session=\([^;]*\).*/\1/p' | tr -d '\r\n')
[ -n "$cookie" ] || { echo "sign-in did not return a session cookie ($(printf '%s' "$signin" | head -n 1))" >&2; exit 1; }
mask "$cookie"
printf '%s' "$cookie" >"$FUZZ_OUT/cookie"

code=$(http_status -X POST "$base/api/v1/context/tenant" -H "Cookie: dp2_session=$cookie" \
  -H 'content-type: application/json' -d "{\"tenant_id\":\"$tenant\"}")
[ "$code" = "200" ] || { echo "switching to the seeded tenant failed ($code)" >&2; exit 1; }
echo "Stack ready: $base"
