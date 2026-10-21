#!/usr/bin/env bash
# One shard of the sharded Schemathesis PR job, and its fan-in (RT-809).
#
#   shard.sh plan        inventory (run.sh inventory) -> plan -> this shard's units
#   shard.sh run <mode>  run.sh gate|report over this shard's units only; records the exit
#                        code in $WS/<mode>.rc and fails with it
#   shard.sh collect     assemble the artifact: SHA, plan, exit codes, manifests, findings;
#                        withheld, and the step failed, if a credential appears in it
#   shard.sh fanin       regenerate the inventory at this SHA and check the downloaded
#                        artifacts (shards.py check); writes the merged report
#
# Needs SHARD_TOTAL (N) for every command and SHARD_INDEX (0..N-1) for all but fanin.
# `fanin` also needs SHARDS_RESULT (the shard jobs' result: anything but "success" fails) and
# reads the artifacts from $SHARD_ARTIFACTS (default $WS/downloaded).
# run.sh is not copied or patched: it takes SHARD_UNITS and writes the per-file manifest.
# Only plan, manifest, exit codes, SHA and findings summaries are published: the raw
# per-file logs can hold a session cookie in their curl reproductions, and the repo is public.
set -euo pipefail
# No MSYS_NO_PATHCONV here: Git Bash must convert the paths it hands to the native python.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
TMP_BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
FUZZ_OUT="${FUZZ_OUT:-$TMP_BASE/api-fuzz}"
WS="${SHARD_WS:-$TMP_BASE/st-shard}"
ARTIFACT="$WS/artifact"
PY="$(command -v python3 || command -v python)"
TOTAL="${SHARD_TOTAL:-}"
INDEX="${SHARD_INDEX:-}"

fail() { echo "::error::$*" >&2; exit 1; }

[[ "$TOTAL" =~ ^[1-9][0-9]*$ ]] || fail "SHARD_TOTAL must be a positive integer (got '$TOTAL')"
if [[ "${1:-}" != "fanin" ]]; then
  [[ "$INDEX" =~ ^[0-9]+$ && "$INDEX" -lt "$TOTAL" ]] || fail "SHARD_INDEX must be in 0..$((TOTAL - 1)) (got '$INDEX')"
fi

plan() {
  [[ -z "${BASELINE_UPDATE:-}" ]] || fail "BASELINE_UPDATE is not allowed in sharded mode"
  rm -rf "$WS"
  mkdir -p "$WS" "$FUZZ_OUT"
  bash "$HERE/run.sh" inventory >"$WS/inventory.txt"
  "$PY" "$HERE/shards.py" plan "$WS/inventory.txt" "$TOTAL" "$HERE/shard-timings.json" >"$WS/plan.txt"
  "$PY" "$HERE/shards.py" select "$WS/plan.txt" "$INDEX" >"$WS/units.txt"
  echo "shard $INDEX of $TOTAL runs:"
  cat "$WS/units.txt"
}

run_mode() {
  local mode="${1:?usage: run gate|report}" rc
  [[ "$mode" == gate || "$mode" == report ]] || fail "unknown mode: $mode"
  [[ -s "$WS/units.txt" ]] || fail "no units for this shard (did plan run?)"
  set +e
  SHARD_UNITS="$WS/units.txt" bash "$HERE/run.sh" "$mode"
  rc=$?
  set -e
  echo "$rc" >"$WS/$mode.rc"
  echo "$mode exit=$rc (recorded for the fan-in)"
  return "$rc"
}

collect() {
  local f patterns="$WS/.secret-patterns"
  rm -rf "$ARTIFACT"
  mkdir -p "$ARTIFACT"
  git -C "$ROOT" rev-parse HEAD >"$ARTIFACT/sha.txt"
  for f in "$WS/plan.txt" "$WS/gate.rc" "$WS/report.rc" "$FUZZ_OUT/manifest-gate.txt" "$FUZZ_OUT/manifest-report.txt" \
    "$FUZZ_OUT/gate.md" "$FUZZ_OUT/report.md"; do
    if [[ -f "$f" ]]; then cp "$f" "$ARTIFACT/"; fi
  done

  # The repo is public: never publish a session cookie, the envelope or a DB/Redis password.
  {
    for f in cookie-owner cookie-platform envelope-operator; do
      if [[ -s "$FUZZ_OUT/$f" ]]; then cat "$FUZZ_OUT/$f"; echo; fi
    done
    if [[ -f "$FUZZ_OUT/stack.env" ]]; then cut -d= -f2- "$FUZZ_OUT/stack.env"; fi
  } | grep -v '^$' >"$patterns" || true
  if [[ -s "$patterns" ]] && grep -rlFf "$patterns" "$ARTIFACT" >&2; then
    rm -rf "$ARTIFACT" "$patterns"
    fail "a credential appeared in a file to publish; artifact withheld"
  fi
  rm -f "$patterns"
  ls "$ARTIFACT"
}

fanin() {
  local job_result="${SHARDS_RESULT:-}" downloaded="${SHARD_ARTIFACTS:-$WS/downloaded}" rc
  [[ -n "$job_result" ]] || fail "SHARDS_RESULT is not set"
  rm -rf "$WS/merged"
  mkdir -p "$WS/merged"
  bash "$HERE/run.sh" inventory >"$WS/merged/inventory.txt"
  set +e
  "$PY" "$HERE/shards.py" check --inventory "$WS/merged/inventory.txt" --shards "$TOTAL" \
    --timings "$HERE/shard-timings.json" --ws "$downloaded" --sha "$(git -C "$ROOT" rev-parse HEAD)" \
    --job-result "$job_result" --out "$WS/merged/schemathesis-merged.md"
  rc=$?
  set -e
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" && -f "$WS/merged/schemathesis-merged.md" ]]; then
    cat "$WS/merged/schemathesis-merged.md" >>"$GITHUB_STEP_SUMMARY"
  fi
  return "$rc"
}

case "${1:-}" in
  plan) plan ;;
  run) run_mode "${2:-}" ;;
  collect) collect ;;
  fanin) fanin ;;
  *) echo "usage: $0 plan|run gate|run report|collect|fanin" >&2; exit 2 ;;
esac
