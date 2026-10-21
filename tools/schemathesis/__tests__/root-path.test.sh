#!/usr/bin/env bash
# RT-801: Docker-free checks that stack-up.sh and run.sh use the Backend-Core
# project root in both layouts — the standalone repo and the monorepo import
# under services/backend-core/ — and never pass over zero operations.
#
# A fake `docker` on PATH records every call. It runs ops.py on the host against
# the bind-mount source, and, like Docker, mounts a missing source as an empty
# directory, so a wrong root shows up as zero selected operations.
#
# Usage: bash tools/schemathesis/__tests__/root-path.test.sh
# Needs python3 with PyYAML. Not wired into CI. The real stack is not started.
# SCRIPT_SRC=<dir holding tools/schemathesis> tests another copy of the scripts.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SRC="$(cd "$HERE/../../.." && pwd -P)"
SCRIPT_SRC="${SCRIPT_SRC:-$SRC}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_CEILING_DIRECTORIES="$TMP"
export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PY="$(command -v python3 || command -v python)"
fails=0

mkdir -p "$TMP/bin"
cat >"$TMP/bin/docker" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$1" in
  build) exit 0 ;;
  compose) exit 97 ;; # stop stack-up once the build and compose paths are recorded
esac
contracts="" cfg=""
shift # `docker run`: the second `run` below is the Schemathesis command
while [[ $# -gt 0 ]]; do
  case "$1" in
    -v) case "$2" in
          *:/contracts:*) contracts="${2%:/contracts:*}" ;;
          *:/cfg:*) cfg="${2%:/cfg:*}" ;;
        esac; shift 2 ;;
    /cfg/ops.py)
      [[ -d "$contracts" ]] || contracts="$(mktemp -d)" # Docker creates a missing source
      exec "$FAKE_PY" "$cfg/ops.py" "$contracts" "$3" ;;
    -c) echo 200; exit 0 ;; # session probe
    run) [[ -n "${FAKE_ST_CRASH:-}" ]] && { echo 'Traceback (most recent call last):'; exit 1; }
         printf 'Test cases:\n    3 generated, 3 passed\n'; exit 0 ;;
    *) shift ;;
  esac
done
exit 0
FAKE
chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH" FAKE_PY="$PY"

fixture() {
  local layout="$1" repo="$TMP/$1" project
  project="$repo"
  [[ "$layout" == nested ]] && project="$repo/services/backend-core"
  mkdir -p "$project/tools" "$project/packages/contracts"
  cp -R "$SCRIPT_SRC/tools/schemathesis" "$project/tools/"
  rm -rf "$project/tools/schemathesis/__tests__"
  cp -R "$SRC/packages/contracts/openapi" "$project/packages/contracts/"
  echo "FROM scratch" >"$project/Dockerfile"
  git -C "$repo" init -q
  echo "$project"
}

# expect <want-exit: 0|nonzero> <grep pattern> <name> -- <command...>
expect() {
  local want="$1" pattern="$2" name="$3" out rc
  shift 4
  : >"$FAKE_DOCKER_LOG"
  set +e
  out="$("$@" 2>&1)"
  rc=$?
  set -e
  if { [[ "$want" == 0 && "$rc" -eq 0 ]] || [[ "$want" != 0 && "$rc" -ne 0 ]]; } &&
    grep -qE -- "$pattern" <<<"$out"$'\n'"$(cat "$FAKE_DOCKER_LOG")"; then
    echo "ok    $name (exit $rc)"
  else
    echo "FAIL  $name: want exit $want and /$pattern/, got exit $rc"
    { tail -n 6 <<<"$out"; head -n 4 "$FAKE_DOCKER_LOG"; } | sed 's/^/      | /'
    fails=$((fails + 1))
  fi
}

host() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
re() { sed 's/[][\.*^$+?(){}|/]/\\&/g' <<<"$1"; }

for layout in standalone nested; do
  p="$(fixture "$layout")"
  hp="$(re "$(host "$(cd "$p" && pwd -P)")")"
  export FAKE_DOCKER_LOG="$TMP/$layout.log" FUZZ_OUT="$TMP/$layout-out"
  mkdir -p "$FUZZ_OUT"
  printf x >"$FUZZ_OUT/cookie-owner"
  printf x >"$FUZZ_OUT/cookie-platform"
  # As CI calls them: from the project directory (the monorepo job's working-directory).
  in_project=(bash -c 'cd "$1" && shift && "$@"' _ "$p")
  up=("${in_project[@]}" bash tools/schemathesis/stack-up.sh)
  gate=("${in_project[@]}" bash tools/schemathesis/run.sh)

  expect 1 "^build -q --target api -t [^ ]+ $hp\$" "$layout: stack-up builds from the project root" -- "${up[@]}"
  expect 1 "^compose -p api-fuzz -f $hp/tools/schemathesis/compose.yml up" "$layout: stack-up uses the project compose file" -- "${up[@]}"
  expect 0 "-v $hp/packages/contracts/openapi:/contracts:ro -v $hp/tools/schemathesis:/cfg:ro" \
    "$layout: run.sh mounts the project contracts and config" -- "${gate[@]}" gate
  expect 0 'Schemathesis gate \(owner credential\): [0-9]+ contract files, [1-9][0-9]* operations' \
    "$layout: gate selects operations" -- "${gate[@]}" gate
  expect 0 "-v $hp/packages/contracts/openapi:/contracts:ro" "$layout: run.sh is cwd-independent" -- \
    bash -c 'cd "$1" && shift && "$@"' _ "$TMP" bash "$p/tools/schemathesis/run.sh" gate
  FAKE_ST_CRASH=1 expect 1 'could not run' "$layout: a Schemathesis crash still fails the step" -- "${gate[@]}" gate

  mv "$p/Dockerfile" "$p/Dockerfile.off"
  expect 1 'missing .*Dockerfile' "$layout: stack-up refuses a root without the Dockerfile" -- "${up[@]}"
  mv "$p/Dockerfile.off" "$p/Dockerfile"

  mv "$p/packages/contracts/openapi" "$TMP/$layout-contracts"
  expect 1 'no contracts at' "$layout: run.sh refuses a missing contract tree" -- "${gate[@]}" gate
  mkdir -p "$p/packages/contracts/openapi"
  printf 'openapi: 3.0.3\ninfo: {title: t, version: "1"}\npaths: {}\n' >"$p/packages/contracts/openapi/empty.yaml"
  expect 1 'selected no operations' "$layout: zero selected operations fail" -- "${gate[@]}" gate
  rm -rf "$p/packages/contracts/openapi"
  mv "$TMP/$layout-contracts" "$p/packages/contracts/openapi"

  mv "$p/tools/schemathesis/5xx-baseline.json" "$TMP/baseline.off"
  expect 1 'missing .*5xx-baseline.json' "$layout: run.sh refuses a missing baseline" -- "${gate[@]}" gate
  mv "$TMP/baseline.off" "$p/tools/schemathesis/5xx-baseline.json"
done

if [[ "$fails" -gt 0 ]]; then
  echo "$fails root-path case(s) failed"
  exit 1
fi
echo "all root-path cases passed"
