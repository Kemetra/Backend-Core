#!/usr/bin/env bash
# OpenAPI breaking-change gate (RT-52).
#
# Compares every contract under packages/contracts/openapi/ at a base revision
# with the working tree, in oasdiff composed mode, and fails on WARN or higher.
#
# Usage: tools/oasdiff/check.sh <base-ref>
#   <base-ref>  the PR merge-base (CI passes `git merge-base origin/<base> HEAD`)
#
# Needs `oasdiff` on PATH (or OASDIFF=/path/to/oasdiff). CI installs a pinned,
# checksum-verified binary; see tools/oasdiff/README.md.
#
# Acknowledged breaks: only lines ADDED to breaking-ignore.txt by this change
# (relative to <base-ref>) are honoured. Lines already on the base are inherited
# acknowledgements for changes that have merged; they cannot match again and are
# dropped, so a suppression never outlives the PR that introduced it.
#
# Each added line is also checked by consumer-impact.mjs (RT-674, report mode).
set -euo pipefail

BASE_REF="${1:?usage: tools/oasdiff/check.sh <base-ref>}"
OASDIFF="${OASDIFF:-oasdiff}"

# ROOT is the Backend-Core project root, located from this script. It is the Git
# root in the standalone repo but services/backend-core/ in the monorepo (RT-801),
# so paths inside <base-ref>'s tree carry PREFIX ("" standalone).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PREFIX="$(git -C "$ROOT" rev-parse --show-prefix)"
CFG="$ROOT/tools/oasdiff"
CONTRACTS="packages/contracts/openapi"

has_yaml() { [[ -n "$(find "$1" -name '*.yaml' -print -quit 2>/dev/null)" ]]; }

# Fail closed: a bad ref or a missing head contract set must never read as
# "nothing to compare".
if ! git -C "$ROOT" rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null; then
  echo "::error::base ref '$BASE_REF' is not a commit in $ROOT" >&2
  exit 1
fi
if ! has_yaml "$ROOT/$CONTRACTS"; then
  echo "::error::no contracts at $ROOT/$CONTRACTS" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Git Bash on Windows: a native oasdiff.exe cannot resolve /tmp/... inside a glob.
if command -v cygpath >/dev/null 2>&1; then
  WORK="$(cygpath -m "$WORK")"
  ROOT="$(cygpath -m "$ROOT")"
  CFG="$ROOT/tools/oasdiff"
fi

mkdir -p "$WORK/base/$CONTRACTS"
if ! git -C "$ROOT" cat-file -e "$BASE_REF:$PREFIX$CONTRACTS" 2>/dev/null; then
  echo "No contracts at $BASE_REF ($PREFIX$CONTRACTS); nothing to compare."
  exit 0
fi
# From the Git root: run in a subdirectory, `git archive` keeps only that subdirectory.
git -C "$ROOT/$(git -C "$ROOT" rev-parse --show-cdup)" archive "$BASE_REF:$PREFIX$CONTRACTS" |
  tar -x -C "$WORK/base/$CONTRACTS"
if ! has_yaml "$WORK/base/$CONTRACTS"; then
  echo "::error::no contract files extracted from $BASE_REF:$PREFIX$CONTRACTS" >&2
  exit 1
fi

# Keep only real entries: drop comments and blank lines. A blank pattern would
# make the `grep -f` below match everything.
entries() { grep -vE '^[[:space:]]*(#|$)' || true; }

git -C "$ROOT" show "$BASE_REF:${PREFIX}tools/oasdiff/breaking-ignore.txt" 2>/dev/null \
  | entries >"$WORK/base-ignore.txt" || true
entries <"$CFG/breaking-ignore.txt" >"$WORK/head-ignore.txt"

if [[ -s "$WORK/base-ignore.txt" ]]; then
  grep -vxF -f "$WORK/base-ignore.txt" "$WORK/head-ignore.txt" >"$WORK/ignore.txt" || true
else
  cp "$WORK/head-ignore.txt" "$WORK/ignore.txt"
fi

if [[ -s "$WORK/ignore.txt" ]]; then
  echo "Acknowledged breaks added by this change:"
  sed 's/^/  /' "$WORK/ignore.txt"
fi
stale=$(grep -cxF -f "$WORK/base-ignore.txt" "$WORK/head-ignore.txt" 2>/dev/null || true)
if [[ "${stale:-0}" -gt 0 ]]; then
  echo "Note: $stale inherited entr(y/ies) in breaking-ignore.txt are no longer applied; remove them."
fi

# Consumer impact of the new acknowledgements (RT-674): each line must carry a
# `consumer:<NAME>` tag naming the consumers that pin the affected path.
# CONSUMER_IMPACT_MODE=report (default) only warns, and a crash of the script can
# never fail this gate; enforce (RT-680) propagates the exit code.
consumer_mode="${CONSUMER_IMPACT_MODE:-report}"
case "$consumer_mode" in
  enforce)
    node "$CFG/consumer-impact.mjs" <"$WORK/ignore.txt"
    ;;
  report)
    node "$CFG/consumer-impact.mjs" <"$WORK/ignore.txt" || echo "::warning::consumer-impact errored"
    ;;
  *)
    # A typo must not leave an intended enforce gate fail-open.
    echo "::error::unknown CONSUMER_IMPACT_MODE '$consumer_mode' (expected report or enforce)" >&2
    exit 1
    ;;
esac

format=text
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  format=githubactions
fi

run() {
  local out_format="$1"
  "$OASDIFF" breaking --composed \
    --fail-on WARN \
    --severity-levels "$CFG/severity-levels.txt" \
    --err-ignore "$WORK/ignore.txt" \
    --warn-ignore "$WORK/ignore.txt" \
    --format "$out_format" \
    "$WORK/base/$CONTRACTS/**/*.yaml" \
    "$ROOT/$CONTRACTS/**/*.yaml"
}

# Human-readable report first (never fails), then the gating run.
run text || true
if [[ "$format" != text ]]; then
  run "$format"
else
  run text >/dev/null
fi
echo "OpenAPI breaking-change gate: no unacknowledged WARN/ERR findings."
