#!/usr/bin/env bash
# Run Schemathesis against the stack from stack-up.sh (RT-59).
#
#   run.sh gate    not_a_server_error. Fails on any 5xx not in 5xx-baseline.json.
#   run.sh operator  RT-612 phase 1: not_a_server_error on the operatorAuthorization
#                  (POS envelope) operations with a minted operator envelope.
#                  NON-GATING: 5xx findings not in operator-5xx-baseline.json
#                  are written to $FUZZ_OUT/operator.md (and the job summary) but
#                  do not fail the step. A run that could not execute still fails.
#   run.sh report  positive_data_acceptance. Findings not in report-baseline.json
#                  are informational: they are written to $FUZZ_OUT/report.md
#                  (and the job summary) and do not fail the step.
#
#   run.sh inventory  RT-809: print "<group> <file> <operationIds...>" for the owner and
#                  platform groups (ops.py, same image and mounts as a run) and run nothing.
#                  The shard plan is computed from this, never from a hardcoded list.
#
# SHARD_UNITS=<file> (RT-809, gate and report only): run only the contract files listed
# there, one "<group> <file>" per line, and write a line per file run to
# $FUZZ_OUT/manifest-<mode>.txt for the fan-in (tools/schemathesis/shards.py). Without it
# nothing below changes. With it, BASELINE_UPDATE and operator mode are rejected, and so
# are an empty or malformed file and a unit that ops.py does not list.
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

MODE="${1:?usage: run.sh gate|report|operator|inventory}"
# The Backend-Core project root, located from this script: the Git root when
# standalone, services/backend-core/ in the monorepo (RT-801).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
FUZZ_PROJECT="${FUZZ_PROJECT:-api-fuzz}"
FUZZ_OUT="${FUZZ_OUT:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/api-fuzz}"
ST_IMAGE="${ST_IMAGE:-schemathesis/schemathesis:4.28.0@sha256:0a71757c60ccdba270c154a859d9dd3d019625f782f23ab36ad604771e15f78b}"
SEED="${SEED:-38}"
MAX_EXAMPLES="${MAX_EXAMPLES:-200}"
SHARD_UNITS="${SHARD_UNITS:-}"

# BASELINE_UPDATE=1 (maintainers only) records this run's failures into the
# mode's baseline file (5xx-baseline.json or report-baseline.json), so the config
# dir is mounted writable for that run only.
CFG_MODE=ro
if [[ -n "${BASELINE_UPDATE:-}" ]]; then CFG_MODE=rw; fi

host_path() {
  local path="$1"
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$path"; else printf '%s' "$path"; fi
}

st() {
  # `inventory` (RT-809) runs before any stack exists and needs no network.
  local network="${FUZZ_PROJECT}_default"
  if [[ "$MODE" == "inventory" ]]; then network=none; fi
  docker run --rm --network "$network" \
    -v "$(host_path "$ROOT/packages/contracts/openapi"):/contracts:ro" \
    -v "$(host_path "$HERE"):/cfg:$CFG_MODE" \
    "$@"
}

# The envelope is a bearer token, not a session: it is alive while the API does
# not answer 401 (an unknown sale answers 404 once the envelope is accepted).
envelope_alive() {
  local envelope="$1"
  st --entrypoint python "$ST_IMAGE" -c "import urllib.request as u, urllib.error as e
r = u.Request('http://api:3000/api/pos/v1/sales/00000000-0000-4000-8000-000000000000', headers={'Authorization': 'Bearer $envelope'})
try:
    print(u.urlopen(r).status)
except e.HTTPError as x:
    print(x.code)" 2>/dev/null || echo dead
}

session_alive() {
  local session_cookie="$1"
  st --entrypoint python "$ST_IMAGE" -c "import urllib.request as u; r=u.Request('http://api:3000/api/v1/context/me', headers={'Cookie': 'dp2_session=$session_cookie'}); print(u.urlopen(r).status)" 2>/dev/null || echo dead
}

# RT-809: this group's lines of the ops.py output that SHARD_UNITS lists, in ops.py order.
# A listed unit that ops.py does not report means the plan came from another inventory.
select_units() {
  local group="$1" ops="$2" missing
  missing="$(awk -v g="$group" 'NR == FNR { if ($1 == g) want[$2] = 1; next } { seen[$1] = 1 }
    END { for (f in want) if (!(f in seen)) print f }' "$SHARD_UNITS" - <<<"$ops")"
  if [[ -n "$missing" ]]; then
    echo "::error::SHARD_UNITS lists $group files that ops.py does not report: $(echo "$missing" | tr '\n' ' ')" >&2
    return 1
  fi
  awk -v g="$group" 'NR == FNR { if ($1 == g) want[$2] = 1; next } $1 in want' "$SHARD_UNITS" - <<<"$ops"
}

case "$MODE" in
  gate|inventory)
    check=not_a_server_error
    baseline=5xx-baseline.json
    ;;
  report)
    check=positive_data_acceptance
    baseline=report-baseline.json
    ;;
  operator)
    check=not_a_server_error
    baseline=operator-5xx-baseline.json
    ;;
  *) echo "unknown mode: $MODE" >&2; exit 2 ;;
esac
if [[ -n "$SHARD_UNITS" ]]; then
  if [[ "$MODE" == "operator" || "$MODE" == "inventory" || -n "${BASELINE_UPDATE:-}" ]]; then
    echo "::error::SHARD_UNITS is only for gate and report runs without BASELINE_UPDATE" >&2
    exit 1
  fi
  if [[ ! -s "$SHARD_UNITS" ]]; then
    echo "::error::SHARD_UNITS $SHARD_UNITS is missing or empty" >&2
    exit 1
  fi
  if ! awk 'NF != 2 || ($1 != "owner" && $1 != "platform") { bad = 1 } END { exit bad }' "$SHARD_UNITS" ||
    [[ -n "$(sort "$SHARD_UNITS" | uniq -d)" ]]; then
    echo "::error::SHARD_UNITS $SHARD_UNITS has a malformed or duplicate line" >&2
    exit 1
  fi
fi
extra=(--baseline "/cfg/$baseline")
if [[ -n "${BASELINE_UPDATE:-}" ]]; then extra+=(--baseline-update); fi

# Docker bind-mounts a missing source as an empty directory, so a wrong root
# would select zero operations and pass. Check the mounted inputs on the host.
if [[ -z "$(find "$ROOT/packages/contracts/openapi" -name '*.yaml' -print -quit 2>/dev/null)" ]]; then
  echo "::error::no contracts at $ROOT/packages/contracts/openapi" >&2
  exit 1
fi
for f in "$HERE/ops.py" "$HERE/$baseline"; do
  [[ -f "$f" ]] || { echo "::error::missing $f" >&2; exit 1; }
done

if [[ "$MODE" == "inventory" ]]; then
  inventory=""
  for group in owner platform; do
    ops="$(st --entrypoint python "$ST_IMAGE" /cfg/ops.py /contracts "$group")"
    if [[ -n "$ops" ]]; then inventory+="$(sed "s/^/$group /" <<<"$ops")"$'\n'; fi
  done
  [[ -n "$inventory" ]] || { echo "::error::no operations in $ROOT/packages/contracts/openapi" >&2; exit 1; }
  printf '%s' "$inventory"
  exit 0
fi

failed=0
errored=0
total_ops=0
summary="$FUZZ_OUT/$MODE.md"
: >"$summary"
manifest="$FUZZ_OUT/manifest-$MODE.txt"
if [[ -n "$SHARD_UNITS" ]]; then : >"$manifest"; fi

groups=(owner platform)
if [[ "$MODE" == "operator" ]]; then groups=(operator); fi

for group in "${groups[@]}"; do
  if [[ "$group" == "operator" ]]; then
    credential="$(cat "$FUZZ_OUT/envelope-operator")"
    auth_header="Authorization: Bearer $credential"
  else
    credential="$(cat "$FUZZ_OUT/cookie-$group")"
    auth_header="Cookie: dp2_session=$credential"
  fi
  ops="$(st --entrypoint python "$ST_IMAGE" /cfg/ops.py /contracts "$group")"
  if [[ -n "$SHARD_UNITS" ]]; then ops="$(select_units "$group" "$ops")"; fi
  [[ -n "$ops" ]] || continue
  n_ops="$(echo "$ops" | awk '{n += NF - 1} END {print n + 0}')"
  total_ops=$((total_ops + n_ops))
  echo "Schemathesis $MODE ($group credential): $(echo "$ops" | wc -l) contract files, $n_ops operations"

  while read -r file ids; do
    include=()
    for id in $ids; do include+=(--include-operation-id "$id"); done
    log="$FUZZ_OUT/$MODE-$group-$(echo "$file" | tr '/.' '__').txt"
    set +e
    # RT-430: unsafe cookie requests need a trusted Origin, or every write stops
    # at 403 origin_rejected before its handler. NODE_ENV=production in the
    # stack, so the API's own origin for Host api:3000 is https://api:3000.
    st "$ST_IMAGE" run "/contracts/$file" --url http://api:3000 "${include[@]}" \
      --header "$auth_header" --header "Origin: https://api:3000" \
      --checks "$check" "${extra[@]}" \
      --seed "$SEED" --max-examples "$MAX_EXAMPLES" --phases examples,coverage,fuzzing \
      --workers 1 --generation-database none --no-color >"$log" 2>&1
    rc=$?
    set -e
    result=$(grep -E '^\s+[0-9]+ generated' "$log" | xargs || true)
    echo "$file ($group): exit=$rc ${result}"

    # A run that did not execute: Schemathesis errors, a crash, or no summary.
    file_errored=0
    if grep -qE '^=+ ERRORS =+$|Traceback \(most recent call last\)' "$log" || ! grep -q '^Test cases:' "$log"; then
      errored=1
      file_errored=1
      echo "::error::Schemathesis could not run $file ($group); see the step log" >&2
      {
        echo "### \`$file\` ($group): run error"
        echo '```'
        sed -n '/= ERRORS =/,/= SUMMARY =/p' "$log" | head -40 || true
        tail -n 15 "$log" || true
        echo '```'
      } >>"$summary"
    elif [[ "$rc" -ne 0 ]]; then
      failed=1
      {
        echo "### \`$file\` ($group)"
        echo '```'
        sed -n '/= FAILURES =/,/= SUMMARY =/p' "$log" | grep -E '^_{3,} |^- |^\[[0-9]{3}\]|curl -X' | cut -c1-300 || true
        echo '```'
      } >>"$summary"
    fi

    if [[ -n "$SHARD_UNITS" ]]; then
      # "<mode> <group> <file> <exit> <errored> <generated> <ids,...>"; -1 = no count in the log.
      generated="$(sed -n -E 's/^[[:space:]]+([0-9]+) generated.*/\1/p' "$log" | head -n 1)"
      echo "$MODE $group $file $rc $file_errored ${generated:--1} ${ids// /,}" >>"$manifest"
    fi

    # The session must survive every file; a dead cookie would make the rest meaningless.
    if [[ "$group" == "operator" ]]; then
      probe="$(envelope_alive "$credential")"
      # An answer other than 401 means the envelope is accepted; "dead" (no HTTP answer) is a failure too.
      [[ "$probe" =~ ^[0-9]{3}$ && "$probe" != "401" ]] || { echo "operator envelope was rejected or the API did not answer ($probe) after $file" >&2; exit 1; }
    else
      [[ "$(session_alive "$credential")" == "200" ]] || { echo "$group session was lost after $file" >&2; exit 1; }
    fi
  done <<<"$ops"
done

# A run over zero operations proves nothing; never let it pass.
if [[ "$total_ops" -eq 0 ]]; then
  echo "::error::Schemathesis $MODE selected no operations from $ROOT/packages/contracts/openapi" >&2
  exit 1
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    if [[ "$MODE" == "gate" ]]; then echo "## Schemathesis gate (not_a_server_error)"; elif [[ "$MODE" == "operator" ]]; then echo "## Schemathesis operator-envelope run (not_a_server_error, phase 1: findings are non-gating)"; else echo "## Schemathesis report (positive_data_acceptance, findings are non-gating)"; fi
    if [[ "$failed" -eq 0 ]] && [[ "$errored" -eq 0 ]]; then echo "No findings."; else cat "$summary"; fi
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [[ "$errored" -ne 0 ]]; then
  echo "Schemathesis could not run every contract file (see $summary)." >&2
  exit 1
fi
if [[ "$MODE" == "report" || "$MODE" == "operator" ]]; then
  echo "$MODE: findings are informational (see $summary)."
  exit 0
fi
exit "$failed"
