#!/usr/bin/env bash
# Run Schemathesis against the stack from stack-up.sh (RT-59).
#
#   run.sh gate    not_a_server_error. Fails on any 5xx not in 5xx-baseline.json.
#   run.sh report  positive_data_acceptance. Findings are informational: they
#                  are written to $FUZZ_OUT/report.md (and the job summary) and
#                  do not fail the step.
#
# In both modes, a run that could not execute (schema load, network or tool
# error) fails the step, so a broken check never looks green.
#
# Covers every cookieAuth operation in packages/contracts/openapi (see ops.py):
# owner-reachable operations with the owner session, @PlatformAdminOnly
# operations with the platform-admin session. Raw NDJSON reports are never
# written: they would contain the session cookie.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash only; no effect on Linux

MODE="${1:?usage: run.sh gate|report}"
ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/tools/schemathesis"
FUZZ_PROJECT="${FUZZ_PROJECT:-api-fuzz}"
FUZZ_OUT="${FUZZ_OUT:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/api-fuzz}"
ST_IMAGE="${ST_IMAGE:-schemathesis/schemathesis:4.28.0@sha256:0a71757c60ccdba270c154a859d9dd3d019625f782f23ab36ad604771e15f78b}"
SEED="${SEED:-38}"
MAX_EXAMPLES="${MAX_EXAMPLES:-200}"

# BASELINE_UPDATE=1 (maintainers only) records this run's gate failures into
# 5xx-baseline.json, so the config dir is mounted writable for that run only.
CFG_MODE=ro
if [ -n "${BASELINE_UPDATE:-}" ]; then CFG_MODE=rw; fi

host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

st() {
  docker run --rm --network "${FUZZ_PROJECT}_default" \
    -v "$(host_path "$ROOT/packages/contracts/openapi"):/contracts:ro" \
    -v "$(host_path "$HERE"):/cfg:$CFG_MODE" \
    "$@"
}

session_alive() {
  st --entrypoint python "$ST_IMAGE" -c "import urllib.request as u; r=u.Request('http://api:3000/api/v1/context/me', headers={'Cookie': 'dp2_session=$1'}); print(u.urlopen(r).status)" 2>/dev/null || echo dead
}

case "$MODE" in
  gate)
    check=not_a_server_error
    extra=(--baseline /cfg/5xx-baseline.json)
    if [ -n "${BASELINE_UPDATE:-}" ]; then extra+=(--baseline-update); fi
    ;;
  report) check=positive_data_acceptance; extra=() ;;
  *) echo "unknown mode: $MODE" >&2; exit 2 ;;
esac

failed=0
errored=0
summary="$FUZZ_OUT/$MODE.md"
: >"$summary"

for group in owner platform; do
  cookie="$(cat "$FUZZ_OUT/cookie-$group")"
  ops="$(st --entrypoint python "$ST_IMAGE" /cfg/ops.py /contracts "$group")"
  [ -n "$ops" ] || continue
  echo "Schemathesis $MODE ($group session): $(echo "$ops" | wc -l) contract files, $(echo "$ops" | awk '{n += NF - 1} END {print n}') operations"

  while read -r file ids; do
    include=()
    for id in $ids; do include+=(--include-operation-id "$id"); done
    log="$FUZZ_OUT/$MODE-$group-$(echo "$file" | tr '/.' '__').txt"
    set +e
    st "$ST_IMAGE" run "/contracts/$file" --url http://api:3000 "${include[@]}" \
      --header "Cookie: dp2_session=$cookie" --checks "$check" "${extra[@]}" \
      --seed "$SEED" --max-examples "$MAX_EXAMPLES" --phases examples,coverage,fuzzing \
      --workers 1 --generation-database none --no-color >"$log" 2>&1
    rc=$?
    set -e
    result=$(grep -E '^\s+[0-9]+ generated' "$log" | xargs || true)
    echo "$file ($group): exit=$rc ${result}"

    # A run that did not execute: Schemathesis errors, a crash, or no summary.
    if grep -qE '^=+ ERRORS =+$|Traceback \(most recent call last\)' "$log" || ! grep -q '^Test cases:' "$log"; then
      errored=1
      echo "::error::Schemathesis could not run $file ($group); see the step log"
      {
        echo "### \`$file\` ($group): run error"
        echo '```'
        sed -n '/= ERRORS =/,/= SUMMARY =/p' "$log" | head -40 || true
        tail -n 15 "$log" || true
        echo '```'
      } >>"$summary"
    elif [ "$rc" -ne 0 ]; then
      failed=1
      {
        echo "### \`$file\` ($group)"
        echo '```'
        sed -n '/= FAILURES =/,/= SUMMARY =/p' "$log" | grep -E '^_{3,} |^- |^\[[0-9]{3}\]|curl -X' | cut -c1-300 || true
        echo '```'
      } >>"$summary"
    fi

    # The session must survive every file; a dead cookie would make the rest meaningless.
    [ "$(session_alive "$cookie")" = "200" ] || { echo "$group session was lost after $file" >&2; exit 1; }
  done <<<"$ops"
done

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    if [ "$MODE" = gate ]; then echo "## Schemathesis gate (not_a_server_error)"; else echo "## Schemathesis report (positive_data_acceptance, findings are non-gating)"; fi
    if [ "$failed" -eq 0 ] && [ "$errored" -eq 0 ]; then echo "No findings."; else cat "$summary"; fi
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$errored" -ne 0 ]; then
  echo "Schemathesis could not run every contract file (see $summary)." >&2
  exit 1
fi
if [ "$MODE" = report ]; then
  echo "Report: findings are informational (see $summary)."
  exit 0
fi
exit "$failed"
