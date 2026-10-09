#!/usr/bin/env bash
# RT-336 — smoke test for the same-origin edge: Admin Console at /, API at /api/*.
#
# Usage: deploy/console-smoke.sh <base-url>
#   deploy/console-smoke.sh https://api.example.test
#
# Read-only GET requests, no credentials. Prints one line per check and exits
# non-zero if any check fails. Needs bash, curl, grep, sed and cmp.
#
# Every request is bounded, so a stalled origin fails its checks instead of
# hanging: SMOKE_CONNECT_TIMEOUT (default 5 s) and SMOKE_MAX_TIME (default 10 s).
set -uo pipefail

base="${1:?usage: deploy/console-smoke.sh <base-url>}"
base="${base%/}"
connect_timeout="${SMOKE_CONNECT_TIMEOUT:-5}"
max_time="${SMOKE_MAX_TIME:-10}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

# get <path> <name>: body -> $work/<name>.body, headers -> $work/<name>.hdr, status -> stdout
get() {
  curl -sS --connect-timeout "$connect_timeout" --max-time "$max_time" \
    -o "$work/$2.body" -D "$work/$2.hdr" -w '%{http_code}' "$base$1" || echo "000"
}

# header <name> <header>: value of the first matching response header
header() {
  grep -i "^$2:" "$work/$1.hdr" | head -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'
}

check() {
  local label="$1"
  shift
  if "$@"; then
    echo "ok    $label"
  else
    echo "FAIL  $label"
    failures=$((failures + 1))
  fi
}

is() { [ "$1" = "$2" ]; }
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
not_html() { ! has "$1" "text/html"; }

# Console shell
status="$(get / root)"
check "/ returns 200" is "$status" 200
check "/ is HTML" has "$(header root content-type)" "text/html"
check "/ is Cache-Control: no-cache" is "$(header root cache-control)" "no-cache"
check "/ sends CSP with frame-ancestors 'none'" has "$(header root content-security-policy)" "frame-ancestors 'none'"
check "/ sends X-Content-Type-Options: nosniff" is "$(header root x-content-type-options)" "nosniff"
check "/ sends Strict-Transport-Security" has "$(header root strict-transport-security)" "max-age="
check "/ sends Referrer-Policy" has "$(header root referrer-policy)" "strict-origin"

# SPA fallback for a client-side route
status="$(get /stores/console-smoke-deep-link deep)"
check "deep link returns 200" is "$status" 200
check "deep link serves the same index.html as /" cmp -s "$work/root.body" "$work/deep.body"

# Hashed asset referenced by index.html
asset="$(grep -o '/assets/[^"]*\.js' "$work/root.body" | head -n 1)"
check "index.html references a /assets/*.js bundle" has "$asset" "/assets/"
if [ -n "$asset" ]; then
  status="$(get "$asset" asset)"
  check "$asset returns 200" is "$status" 200
  check "$asset is immutable" has "$(header asset cache-control)" "immutable"
fi

# A missing asset must be a 404, never index.html
status="$(get /assets/console-smoke-missing.js missing)"
check "missing asset returns 404" is "$status" 404

# Release metadata
status="$(get /version.json version)"
check "/version.json returns 200" is "$status" 200
check "/version.json is JSON" has "$(header version content-type)" "json"
check "/version.json is Cache-Control: no-cache" is "$(header version cache-control)" "no-cache"

# API routing: same origin, never the SPA
status="$(get /api/v1/health/ready ready)"
check "/api/v1/health/ready reaches the API (200 or 503)" has " 200 503 " " $status "
check "/api/v1/health/ready is not HTML" not_html "$(header ready content-type)"

status="$(get /api/console-smoke-unknown unknown)"
check "unknown /api path returns the API's 404" is "$status" 404
check "unknown /api path is not index.html" not_html "$(header unknown content-type)"

status="$(get /api bare)"
check "/api is answered by the API, not the SPA" not_html "$(header bare content-type)"

if [ "$failures" -gt 0 ]; then
  echo "console-smoke: $failures check(s) failed against $base"
  exit 1
fi
echo "console-smoke: all checks passed against $base"
