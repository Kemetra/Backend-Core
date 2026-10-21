#!/usr/bin/env bash
# One node of the sharded Schemathesis job (RT-806, lane only; not on main).
#
#   schemathesis-shard.sh inventory <out>      ops.py owner+platform at this SHA, "<group> <file> <ids...>"
#   schemathesis-shard.sh plan                 inventory, the shard plan, this node's units, and a
#                                              runtime copy of main's run.sh that runs only those units
#   schemathesis-shard.sh run gate|report <t>  the patched run.sh under `timeout <t>`; records the exit
#                                              code (the verdict step and the fan-in fail on it)
#   schemathesis-shard.sh collect              per-file manifest, findings, artifacts, secret guard
#   schemathesis-shard.sh verdict              fails unless gate and report both exited 0
#
# tools/schemathesis/run.sh is not edited: `plan` writes a copy beside it ($PATCHED) with one
# filter line inserted after its ops.py call, failing unless that anchor is found exactly once.
# Porting a file-subset input to main's run.sh is a later decision.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/tools/schemathesis"
SCRIPTS="$ROOT/.circleci/scripts"
FUZZ_OUT="${FUZZ_OUT:-${TMPDIR:-/tmp}/api-fuzz}"
NODE="${CIRCLE_NODE_INDEX:-0}"
TOTAL="${CIRCLE_NODE_TOTAL:-1}"
WS="${SHARD_WS:-/tmp/ws/st}/node-$NODE"
ARTIFACTS="/tmp/st-artifacts/node-$NODE"
# Beside run.sh, untracked, in the CI clone only: run.sh finds the project root from its own directory (RT-801).
PATCHED="$HERE/.run-shard.sh"

inventory() {
  local image group
  image="$(sed -n 's/^ST_IMAGE="\${ST_IMAGE:-\(.*\)}"$/\1/p' "$HERE/run.sh")"
  [[ -n "$image" ]] || { echo "could not read ST_IMAGE from run.sh" >&2; exit 1; }
  for group in owner platform; do
    docker run --rm -v "$ROOT/packages/contracts/openapi:/contracts:ro" -v "$HERE:/cfg:ro" \
      --entrypoint python "$image" /cfg/ops.py /contracts "$group" | sed "s/^/$group /"
  done
}

plan() {
  [[ -z "${BASELINE_UPDATE:-}" ]] || { echo "BASELINE_UPDATE is not allowed in sharded mode" >&2; exit 1; }
  mkdir -p "$WS" "$FUZZ_OUT"
  inventory >"$WS/inventory.txt"
  python3 "$SCRIPTS/schemathesis-shards.py" plan "$WS/inventory.txt" "$TOTAL" "$SCRIPTS/schemathesis-timings.json" >"$WS/plan.txt"
  awk -v n="$NODE" '$1 == n { print $2, $3 }' "$WS/plan.txt" >"$FUZZ_OUT/shard-units"
  echo "node $NODE of $TOTAL runs:"; cat "$FUZZ_OUT/shard-units"
  test -s "$FUZZ_OUT/shard-units"

  local anchor filter
  anchor='/cfg/ops.py /contracts "$group")"'
  filter='  ops="$(awk -v g="$group" '\''NR == FNR { if ($1 == g) want[$2] = 1; next } $1 in want'\'' "$FUZZ_OUT/shard-units" - <<<"$ops")" # RT-806 lane: this shard only'
  awk -v a="$anchor" -v f="$filter" '{ print } index($0, a) { print f; n++ } END { exit n != 1 }' "$HERE/run.sh" >"$PATCHED" ||
    { echo "run.sh anchor not found exactly once; the lane patch needs updating" >&2; exit 1; }
  diff "$HERE/run.sh" "$PATCHED" || true
}

run_mode() {
  local mode="$1" limit="$2" rc
  mkdir -p "$WS"
  set +e
  timeout "$limit" bash "$PATCHED" "$mode" 2>&1 | tee "$FUZZ_OUT/$mode.out"
  rc=${PIPESTATUS[0]}
  set -e
  echo "$rc" >"$WS/$mode.rc"
  echo "$mode exit=$rc (recorded for the verdict step and the fan-in)"
}

# "<mode> <group> <file> <exit> <errored> <generated>" per file run.sh reported.
manifest_lines() {
  local mode="$1" line file group rc rest generated log errored
  [[ -f "$FUZZ_OUT/$mode.out" ]] || return 0
  while IFS= read -r line; do
    [[ "$line" =~ ^([^\ ]+)\ \((owner|platform)\):\ exit=([0-9]+)(.*)$ ]] || continue
    file="${BASH_REMATCH[1]}" group="${BASH_REMATCH[2]}" rc="${BASH_REMATCH[3]}" rest="${BASH_REMATCH[4]}"
    generated=-1
    if [[ "$rest" =~ ([0-9]+)\ generated ]]; then generated="${BASH_REMATCH[1]}"; fi
    log="$FUZZ_OUT/$mode-$group-$(echo "$file" | tr '/.' '__').txt"
    errored=0
    if grep -qE '^=+ ERRORS =+$|Traceback \(most recent call last\)' "$log" || ! grep -q '^Test cases:' "$log"; then errored=1; fi
    echo "$mode $group $file $rc $errored $generated"
  done <"$FUZZ_OUT/$mode.out"
}

collect() {
  local mode secrets
  mkdir -p "$WS" "$ARTIFACTS"
  : >"$WS/manifest.txt"
  for mode in gate report; do
    manifest_lines "$mode" >>"$WS/manifest.txt"
    if [[ -f "$FUZZ_OUT/$mode.md" ]]; then cp "$FUZZ_OUT/$mode.md" "$WS/"; fi
  done
  cp "$WS"/*.txt "$WS"/*.md "$ARTIFACTS/" 2>/dev/null || true
  cp "$FUZZ_OUT"/gate-*.txt "$FUZZ_OUT"/report-*.txt "$ARTIFACTS/" 2>/dev/null || true

  # The repo is public: never publish a session cookie, the envelope or a DB password.
  secrets="$FUZZ_OUT/.secret-patterns"
  {
    for f in cookie-owner cookie-platform envelope-operator; do
      if [[ -s "$FUZZ_OUT/$f" ]]; then cat "$FUZZ_OUT/$f"; echo; fi
    done
    if [[ -f "$FUZZ_OUT/stack.env" ]]; then cut -d= -f2- "$FUZZ_OUT/stack.env"; fi
  } | grep -v '^$' >"$secrets" || true
  if [[ -s "$secrets" ]] && grep -rlFf "$secrets" "$ARTIFACTS" "$WS"; then
    rm -rf "$ARTIFACTS" "$WS"/*.md "$WS"/*.txt
    echo "a credential appeared in a file to publish; artifacts withheld" >&2
    exit 1
  fi
  cat "$WS/manifest.txt"
}

verdict() {
  local mode rc ok=0
  for mode in gate report; do
    rc="$(cat "$WS/$mode.rc" 2>/dev/null || echo missing)"
    echo "node $NODE $mode exit=$rc"
    [[ "$rc" == 0 ]] || ok=1
  done
  exit "$ok"
}

case "${1:-}" in
  inventory) inventory >"${2:?usage: inventory <out>}" ;;
  plan) plan ;;
  run) run_mode "${2:?gate|report}" "${3:?timeout}" ;;
  collect) collect ;;
  verdict) verdict ;;
  *) echo "usage: $0 inventory|plan|run|collect|verdict" >&2; exit 2 ;;
esac
