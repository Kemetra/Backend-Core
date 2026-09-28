#!/usr/bin/env bash
# Run Schemathesis against the stack from stack-up.sh (RT-59).
#
#   run.sh gate    not_a_server_error. Fails on any 5xx not in 5xx-baseline.json.
#   run.sh report  positive_data_acceptance. Report only: always exits 0 and
#                  writes the findings to $FUZZ_OUT/report.md (and the job summary).
#
# Covers every cookieAuth operation in packages/contracts/openapi except
# signOut and refreshSession. Raw NDJSON reports are never written: they would
# contain the session cookie.
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
cookie="$(cat "$FUZZ_OUT/cookie")"

st() {
  docker run --rm --network "${FUZZ_PROJECT}_default" \
    -v "$(host_path "$ROOT/packages/contracts/openapi"):/contracts:ro" \
    -v "$(host_path "$HERE"):/cfg:$CFG_MODE" \
    "$@"
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

ops="$(st --entrypoint python "$ST_IMAGE" /cfg/ops.py /contracts)"
echo "Schemathesis $MODE: $(echo "$ops" | wc -l) contract files, $(echo "$ops" | awk '{n += NF - 1} END {print n}') cookieAuth operations"

failed=0
summary="$FUZZ_OUT/$MODE.md"
: >"$summary"
while read -r file ids; do
  include=()
  for id in $ids; do include+=(--include-operation-id "$id"); done
  log="$FUZZ_OUT/$MODE-$(echo "$file" | tr '/.' '__').txt"
  set +e
  st "$ST_IMAGE" run "/contracts/$file" --url http://api:3000 "${include[@]}" \
    --header "Cookie: dp2_session=$cookie" --checks "$check" "${extra[@]}" \
    --seed "$SEED" --max-examples "$MAX_EXAMPLES" --phases examples,coverage,fuzzing \
    --workers 1 --generation-database none --no-color >"$log" 2>&1
  rc=$?
  set -e
  result=$(grep -E '^\s+[0-9]+ generated' "$log" | xargs || true)
  echo "$file: exit=$rc ${result}"
  if [ "$rc" -ne 0 ]; then
    failed=1
    {
      echo "### \`$file\`"
      echo '```'
      sed -n '/= FAILURES =/,/= SUMMARY =/p' "$log" | grep -E '^_{3,} |^- |^\[[0-9]{3}\]|curl -X' | cut -c1-300 || true
      echo '```'
    } >>"$summary"
  fi
  # The session must survive every file; a dead cookie would make the rest meaningless.
  alive=$(st --entrypoint python "$ST_IMAGE" -c "import urllib.request as u; r=u.Request('http://api:3000/api/v1/context/me', headers={'Cookie': 'dp2_session=$cookie'}); print(u.urlopen(r).status)" 2>/dev/null || echo dead)
  [ "$alive" = "200" ] || { echo "session was lost after $file" >&2; exit 1; }
done <<<"$ops"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    if [ "$MODE" = gate ]; then echo "## Schemathesis gate (not_a_server_error)"; else echo "## Schemathesis report only (positive_data_acceptance, non-gating)"; fi
    if [ "$failed" -eq 0 ]; then echo "No findings."; else cat "$summary"; fi
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$MODE" = report ]; then
  echo "Report only: findings are informational (see $summary)."
  exit 0
fi
exit "$failed"
