#!/usr/bin/env bash
# RT-812: apply every routine domain-role grant script (deploy/README.md, step 2).
#
# The routine scripts are the docs/operations/sql/*-domain-grants.sql files
# carrying the opt-in line `-- deploy: every-release`, applied in name order.
# Adding a grant script therefore needs no edit here or in the README: the new
# file opts itself in. A script without the marker (an owner-gated one, such
# as ai-entitlements-domain-grants.sql) is never applied by this script. A
# routine script that forgets the marker is not applied either, and the API
# then refuses to boot naming the missing grant (its grants fragment), so the
# opt-in fails closed.
#
#   deploy/apply-domain-grants.sh           apply them (needs DOMAIN_DB_ROLE)
#   deploy/apply-domain-grants.sh --list    print them, one path per line
#
# psql takes the migration-owner connection from the PG* variables (run it
# under `op run --env-file=deploy/grants.env`), never from a URL argument.
# Each script is idempotent and exits non-zero on failure; this stops at the
# first failure. release-bundle.sh ships exactly the `--list` set.
set -euo pipefail
export LC_ALL=C

MARKER='-- deploy: every-release'
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail() { echo "apply-domain-grants: $*" >&2; exit 1; }

routine_scripts() {
  local f
  for f in docs/operations/sql/*-domain-grants.sql; do
    [ -f "$f" ] || continue
    if tr -d '\r' < "$f" | grep -qxF -- "$MARKER"; then printf '%s\n' "$f"; fi
  done
}

SCRIPTS="$(routine_scripts)"
[ -n "$SCRIPTS" ] || fail "no routine grant scripts found under docs/operations/sql"

case "${1:-}" in
  --list)
    printf '%s\n' "$SCRIPTS"
    exit 0
    ;;
  "") ;;
  *) fail "unknown argument: $1 (expected no argument or --list)" ;;
esac
[ $# -le 1 ] || fail "too many arguments"

# The domain role must be named explicitly: guessing a default could grant to
# a role that DATABASE_URL does not use and still report success.
[ -n "${DOMAIN_DB_ROLE:-}" ] || fail "DOMAIN_DB_ROLE is not set (the DATABASE_URL role name)"

while IFS= read -r script; do
  echo "apply-domain-grants: $script"
  psql -X -v domain_role="$DOMAIN_DB_ROLE" -f "$script" || fail "failed: $script"
done <<< "$SCRIPTS"
echo "apply-domain-grants: done"
