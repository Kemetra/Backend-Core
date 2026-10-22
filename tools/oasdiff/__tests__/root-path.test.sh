#!/usr/bin/env bash
# RT-801: check.sh in both layouts — the standalone repo and the monorepo import
# under services/backend-core/. Each case builds a throwaway Git repo, so the
# project root and the Git root differ exactly as they do after the import.
#
# Usage: bash tools/oasdiff/__tests__/root-path.test.sh
# Needs oasdiff on PATH (or OASDIFF=...) and node. Not wired into CI.
# SCRIPT_SRC=<dir holding tools/oasdiff> tests another copy of the scripts.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_SRC="${SCRIPT_SRC:-$(cd "$HERE/../../.." && pwd -P)}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Fixtures must never resolve to an enclosing repository.
export GIT_CEILING_DIRECTORIES="$TMP"
export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
fails=0

contract() {
  cat <<'YAML'
openapi: 3.0.3
info: { title: fixture, version: "1" }
paths:
  /a:
    get:
      operationId: getA
      responses: { "200": { description: ok } }
  /b:
    get:
      operationId: getB
      responses: { "200": { description: ok } }
YAML
}

# fixture <layout> -> echoes the project dir; Git root is $TMP/<layout>.
fixture() {
  local layout="$1" repo="$TMP/$1" project
  project="$repo"
  [[ "$layout" == nested ]] && project="$repo/services/backend-core"
  mkdir -p "$project/tools" "$project/packages/contracts/openapi"
  cp -R "$SCRIPT_SRC/tools/oasdiff" "$project/tools/"
  rm -rf "$project/tools/oasdiff/__tests__"
  echo "RT-801 fixture: inherited acknowledgement" >>"$project/tools/oasdiff/breaking-ignore.txt"
  contract >"$project/packages/contracts/openapi/api.yaml"
  git -C "$repo" init -q
  git -C "$repo" add -A
  git -C "$repo" commit -qm base
  [[ "$(cd "$(git -C "$project" rev-parse --show-toplevel)" && pwd -P)" == "$(cd "$repo" && pwd -P)" ]] ||
    { echo "fixture $layout escaped to an enclosing repo" >&2; exit 1; }
  echo "$project"
}

# expect <want-exit: 0|nonzero> <grep pattern> <name> -- <command...>
expect() {
  local want="$1" pattern="$2" name="$3" out rc
  shift 4
  set +e
  out="$("$@" 2>&1)"
  rc=$?
  set -e
  if { [[ "$want" == 0 && "$rc" -eq 0 ]] || [[ "$want" != 0 && "$rc" -ne 0 ]]; } &&
    grep -qE "$pattern" <<<"$out"; then
    echo "ok    $name (exit $rc)"
  else
    echo "FAIL  $name: want exit $want and /$pattern/, got exit $rc"
    sed 's/^/      | /' <<<"$out" | tail -n 15
    fails=$((fails + 1))
  fi
}

for layout in standalone nested; do
  p="$(fixture "$layout")"
  # As CI calls it: from the project directory (the monorepo job's working-directory).
  check=(bash -c 'cd "$1" && shift && "$@"' _ "$p" bash tools/oasdiff/check.sh)
  base="$(git -C "$p" rev-parse HEAD)"

  expect 0 'no unacknowledged' "$layout: unchanged contract passes" -- "${check[@]}" "$base"
  expect 0 'inherited entr' "$layout: inherited acknowledgement is read from the base" -- "${check[@]}" "$base"
  # Run from an unrelated directory: the script must not depend on the caller's cwd.
  expect 0 'no unacknowledged' "$layout: cwd-independent" -- \
    bash -c 'cd "$1" && shift && "$@"' _ "$TMP" bash "$p/tools/oasdiff/check.sh" "$base"

  # Breaking change: drop /b from the head contract.
  sed -i '/^  \/b:/,$d' "$p/packages/contracts/openapi/api.yaml"
  expect 1 'api-path-removed|removed' "$layout: removed path fails the gate" -- "${check[@]}" "$base"
  git -C "$p" checkout -q -- packages/contracts/openapi/api.yaml

  expect 1 'is not a commit' "$layout: unknown base ref fails closed" -- "${check[@]}" no-such-ref
  mv "$p/packages/contracts/openapi" "$p/packages/contracts/openapi.off"
  expect 1 'no contracts at' "$layout: missing head contracts fail closed" -- "${check[@]}" "$base"
  mv "$p/packages/contracts/openapi.off" "$p/packages/contracts/openapi"

  # A genuine base without contracts keeps today's behaviour (RT-801 scope).
  orphan="$(git -C "$p" commit-tree "$(git -C "$p" mktree </dev/null)" -m empty)"
  expect 0 'nothing to compare' "$layout: base without contracts still exits 0 (unchanged rule)" -- \
    "${check[@]}" "$orphan"
done

if [[ "$fails" -gt 0 ]]; then
  echo "$fails root-path case(s) failed"
  exit 1
fi
echo "all root-path cases passed"
