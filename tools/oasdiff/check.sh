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
set -euo pipefail

BASE_REF="${1:?usage: tools/oasdiff/check.sh <base-ref>}"
OASDIFF="${OASDIFF:-oasdiff}"

ROOT="$(git rev-parse --show-toplevel)"
CFG="$ROOT/tools/oasdiff"
CONTRACTS="packages/contracts/openapi"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Git Bash on Windows: a native oasdiff.exe cannot resolve /tmp/... inside a glob.
if command -v cygpath >/dev/null 2>&1; then
  WORK="$(cygpath -m "$WORK")"
  ROOT="$(cygpath -m "$ROOT")"
  CFG="$ROOT/tools/oasdiff"
fi

mkdir -p "$WORK/base"
if ! git -C "$ROOT" cat-file -e "$BASE_REF:$CONTRACTS" 2>/dev/null; then
  echo "No contracts at $BASE_REF; nothing to compare."
  exit 0
fi
git -C "$ROOT" archive "$BASE_REF" -- "$CONTRACTS" | tar -x -C "$WORK/base"

# Keep only real entries: drop comments and blank lines. A blank pattern would
# make the `grep -f` below match everything.
entries() { grep -vE '^[[:space:]]*(#|$)' || true; }

git -C "$ROOT" show "$BASE_REF:tools/oasdiff/breaking-ignore.txt" 2>/dev/null \
  | entries >"$WORK/base-ignore.txt" || true
entries <"$CFG/breaking-ignore.txt" >"$WORK/head-ignore.txt"

if [ -s "$WORK/base-ignore.txt" ]; then
  grep -vxF -f "$WORK/base-ignore.txt" "$WORK/head-ignore.txt" >"$WORK/ignore.txt" || true
else
  cp "$WORK/head-ignore.txt" "$WORK/ignore.txt"
fi

if [ -s "$WORK/ignore.txt" ]; then
  echo "Acknowledged breaks added by this change:"
  sed 's/^/  /' "$WORK/ignore.txt"
fi
stale=$(grep -cxF -f "$WORK/base-ignore.txt" "$WORK/head-ignore.txt" 2>/dev/null || true)
if [ "${stale:-0}" -gt 0 ]; then
  echo "Note: $stale inherited entr(y/ies) in breaking-ignore.txt are no longer applied; remove them."
fi

format=text
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  format=githubactions
fi

run() {
  "$OASDIFF" breaking --composed \
    --fail-on WARN \
    --severity-levels "$CFG/severity-levels.txt" \
    --err-ignore "$WORK/ignore.txt" \
    --warn-ignore "$WORK/ignore.txt" \
    --format "$1" \
    "$WORK/base/$CONTRACTS/**/*.yaml" \
    "$ROOT/$CONTRACTS/**/*.yaml"
}

# Human-readable report first (never fails), then the gating run.
run text || true
if [ "$format" != text ]; then
  run "$format"
else
  run text >/dev/null
fi
echo "OpenAPI breaking-change gate: no unacknowledged WARN/ERR findings."
