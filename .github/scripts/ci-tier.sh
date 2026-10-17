#!/usr/bin/env bash
# Changed-path risk tier for a Backend-Core PR (RT-582).
#
# Reads NUL-separated changed paths on stdin (git diff -z --no-renames
# --name-only, so a rename lists both its old and its new path) and prints
# GITHUB_OUTPUT-style lines:
#
#   tier=low|medium|high
#   run_fast=true|false
#   run_db=true|false
#   run_schemathesis=true|false
#
# The PR tier is the highest tier any path hits. Per path, the first match wins:
#
#   1. High   contracts / openapi, migrations, packages/auth, lockfiles and
#             package.json, .github, tools/schemathesis, tools/oasdiff,
#             Dockerfiles and compose files.
#   2. High   SQL under docs/ (DB role and grant scripts that tests apply),
#             and docs/specs/.specify files that code or tests name in a
#             string literal (see test_inputs below).
#   3. Low    *.md, docs/**, specs/**, .claude/**, image assets outside
#             apps/ and packages/.
#   4. Medium apps/** and packages/**, unless the path names an RLS, tenant,
#             posting, money, tax, pricing, outbox or sync area (then High).
#   5. High   anything else. An empty change set is also High.
#
# Jobs: fast + db-integration run for Medium and High. Schemathesis runs for
# High and for any Medium path outside apps/worker/ (packages/* feed the API
# build, so only a worker-only change counts as "Medium, no api").
#
# CI_TIER_TEST_INPUTS overrides the test-input list (one path or prefix per
# line) for the self-test in ci-tier.test.sh.
set -euo pipefail

# Would-be-Low files that code or tests name in a quoted string literal
# (readFileSync / path.join targets): anything under docs/, specs/, .specify/
# or .claude/, and any repo-relative *.md path (e.g. "deploy/README.md", which
# release-images.spec.ts parses). A docs-only edit to one of these can break a
# test, so it is not Low. Comment mentions and bare "README.md" fixture names
# are ignored.
test_inputs() {
  if [[ -n "${CI_TIER_TEST_INPUTS+x}" ]]; then
    printf '%s\n' "$CI_TIER_TEST_INPUTS"
    return
  fi
  {
    git grep -ohE "[\"'](docs|specs|\\.specify|\\.claude)/[A-Za-z0-9._/-]*" -- apps packages tools || true
    git grep -ohE "[\"'][A-Za-z0-9._-]+/[A-Za-z0-9._/-]*\\.md[\"']" -- apps packages tools || true
  } | sed "s/^[\"']//; s/[\"']\$//" | sort -u
}

mapfile -t INPUTS < <(test_inputs | sed '/^$/d')

is_test_input() {
  local p="$1" ref
  for ref in "${INPUTS[@]}"; do
    [[ "$p" == "$ref" || "$p" == "$ref"* ]] && return 0
  done
  return 1
}

classify() {
  local p="$1"
  case "$p" in
    packages/contracts/* | openapi/* | */openapi/* | packages/db/drizzle/* | packages/auth/* | \
      pnpm-lock.yaml | pnpm-workspace.yaml | package.json | */package.json | .github/* | \
      tools/schemathesis/* | tools/oasdiff/* | Dockerfile* | */Dockerfile* | .dockerignore | \
      *compose*.yml | *compose*.yaml | docs/*.sql)
      echo high
      return
      ;;
    *) ;; # not an explicit High path; keep classifying
  esac
  if is_test_input "$p"; then
    echo high
    return
  fi
  case "$p" in
    *.md | docs/* | specs/* | .claude/*)
      echo low
      return
      ;;
    *) ;; # not a docs path; keep classifying
  esac
  case "$p" in
    apps/* | packages/*)
      local lower="${p,,}"
      if [[ "$lower" =~ (rls|tenant|posting|money|tax|pricing|outbox|sync) ]]; then
        echo high
      else
        echo medium
      fi
      return
      ;;
    *.png | *.jpg | *.jpeg | *.gif | *.svg | *.webp | *.ico)
      echo low
      ;;
    *)
      echo high # unmatched paths are High
      ;;
  esac
}

rank() { case "$1" in low) echo 0 ;; medium) echo 1 ;; *) echo 2 ;; esac; }

tier=""
api_touched=false
count=0
while IFS= read -r -d '' path; do
  [[ -n "$path" ]] || continue
  count=$((count + 1))
  t="$(classify "$path")"
  printf '%-6s %s\n' "$t" "$path" >&2
  if [[ "$t" == medium && "$path" != apps/worker/* ]]; then
    api_touched=true
  fi
  if [[ -z "$tier" ]] || (($(rank "$t") > $(rank "$tier"))); then
    tier="$t"
  fi
done

if ((count == 0)); then
  echo "no changed paths: treating as high" >&2
  tier=high
fi

run_heavy=true
run_schemathesis=true
case "$tier" in
  low)
    run_heavy=false
    run_schemathesis=false
    ;;
  medium) run_schemathesis="$api_touched" ;;
  *) ;; # high: everything runs
esac

echo "tier=$tier"
echo "run_fast=$run_heavy"
echo "run_db=$run_heavy"
echo "run_schemathesis=$run_schemathesis"
