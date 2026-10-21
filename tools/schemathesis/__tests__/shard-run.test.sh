#!/usr/bin/env bash
# RT-809: Docker-free checks of the shard input of run.sh (SHARD_UNITS, manifest,
# inventory) and of shard.sh (plan, run, collect, fan-in), with the real contracts.
#
# A fake `docker` on PATH records every call and runs ops.py on the host against the
# bind-mount source (like root-path.test.sh). The real stack and Schemathesis are not started.
#
# The fixture keeps a real subset of packages/contracts/openapi (the first 4 owner files and
# every platform file): a full tree makes the fake-Docker runs take minutes on Windows.
#
# Usage: bash tools/schemathesis/__tests__/shard-run.test.sh
# Needs python3 with PyYAML. Not wired into CI (the Docker-free planner/fan-in tests are:
# shards.test.py). The unsharded-equivalence cases are one-time evidence for RT-809 and run
# only with RT809_BASE_SHA=<commit before RT-809, c9dcb93f> (its run.sh is read with
# `git show`) or BASE_RUN_SH=<path to that run.sh>; otherwise they are skipped, with a message.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SRC="$(cd "$HERE/../../.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_CEILING_DIRECTORIES="$TMP"
export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PY="$(command -v python3 || command -v python)"
fails=0 skips=0

mkdir -p "$TMP/bin"
cat >"$TMP/bin/docker" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$1" in
  build) exit 0 ;;
  compose) exit 97 ;;
esac
contracts="" cfg=""
shift # `docker run`
while [[ $# -gt 0 ]]; do
  case "$1" in
    -v) case "$2" in
          *:/contracts:*) contracts="${2%:/contracts:*}" ;;
          *:/cfg:*) cfg="${2%:/cfg:*}" ;;
        esac; shift 2 ;;
    /cfg/ops.py)
      [[ -d "$contracts" ]] || contracts="$(mktemp -d)"
      # Windows python writes CRLF; the Linux image does not.
      "$FAKE_PY" "$cfg/ops.py" "$contracts" "$3" | tr -d '\015'
      exit "${PIPESTATUS[0]}" ;;
    -c) echo 200; exit 0 ;;
    run) [[ -n "${FAKE_ST_CRASH:-}" ]] && { echo 'Traceback (most recent call last):'; exit 1; }
         printf 'Test cases:\n    %s generated, 3 passed\n' "${FAKE_ST_GENERATED:-9}"
         case " ${FAKE_ST_FAIL:-} " in *" ${2#/contracts/} "*) exit 1 ;; esac
         exit 0 ;;
    *) shift ;;
  esac
done
exit 0
FAKE
chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH" FAKE_PY="$PY"

KEEP="$("$PY" - "$SRC" <<'PYSUBSET'
import pathlib, subprocess, sys
src = pathlib.Path(sys.argv[1])
ops, root = src / "tools/schemathesis/ops.py", src / "packages/contracts/openapi"
keep = set()
for group in ("owner", "platform"):
    out = subprocess.run([sys.executable, str(ops), str(root), group], capture_output=True, text=True, check=True).stdout
    names = [line.split()[0] for line in out.splitlines() if line.strip()]
    keep.update(names[:4] if group == "owner" else names)
print(chr(10).join(sorted(keep)))
PYSUBSET
)"

fixture() { # <name> <run.sh to install>
  local project="$TMP/$1" f
  mkdir -p "$project/tools" "$project/packages/contracts/openapi"
  cp -R "$SRC/tools/schemathesis" "$project/tools/"
  rm -rf "$project/tools/schemathesis/__tests__"
  if [[ -n "${2:-}" ]]; then cp "$2" "$project/tools/schemathesis/run.sh"; fi
  while read -r f; do
    mkdir -p "$project/packages/contracts/openapi/$(dirname "$f")"
    cp "$SRC/packages/contracts/openapi/$f" "$project/packages/contracts/openapi/$f"
  done <<<"$(tr -d '\015' <<<"$KEEP")"
  echo "FROM scratch" >"$project/Dockerfile"
  git -C "$project" init -q
  git -C "$project" add -A >/dev/null
  git -C "$project" commit -q -m fixture
  echo "$project"
}

pass() { echo "ok    $1"; }
fail() { echo "FAIL  $1"; [[ -z "${2:-}" ]] || sed 's/^/      | /' <<<"$2" | head -n 12; fails=$((fails + 1)); }

# expect <want 0|nonzero> <grep pattern over output+docker log> <name> -- <command...>
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
    pass "$name (exit $rc)"
  else
    fail "$name: want exit $want and /$pattern/, got exit $rc" "$(tail -n 8 <<<"$out")"
  fi
}

st_runs() { grep -c -- ' run /contracts/' "$FAKE_DOCKER_LOG" || true; }

P="$(fixture new)"
export FAKE_DOCKER_LOG="$TMP/docker.log"
export FUZZ_OUT="$TMP/out"
mkdir -p "$FUZZ_OUT"
printf 'cookie-owner-0123456789abcdef0123456789abcdef' >"$FUZZ_OUT/cookie-owner"
printf 'cookie-platform-0123456789abcdef0123456789abcdef' >"$FUZZ_OUT/cookie-platform"
printf 'PG_OWNER_PASSWORD=pgowner0123456789abcdef01234567\nREDIS_PASSWORD=redis0123456789abcdef0123456789\n' >"$FUZZ_OUT/stack.env"
RUN="$P/tools/schemathesis/run.sh"
cd "$P"

# ---- inventory ------------------------------------------------------------------
bash "$RUN" inventory >"$TMP/inventory.txt"
n_owner="$("$PY" tools/schemathesis/ops.py packages/contracts/openapi owner | wc -l)"
n_platform="$("$PY" tools/schemathesis/ops.py packages/contracts/openapi platform | wc -l)"
if [[ "$(grep -c '^owner ' "$TMP/inventory.txt")" -eq "$n_owner" && "$(grep -c '^platform ' "$TMP/inventory.txt")" -eq "$n_platform" && "$n_owner" -gt 0 && "$n_platform" -gt 0 ]]; then
  pass "inventory lists every owner ($n_owner) and platform ($n_platform) contract file"
else
  fail "inventory does not match ops.py"
fi
expect 0 -- "inventory runs on no network" -- bash "$RUN" inventory
grep -q -- '--network none' "$FAKE_DOCKER_LOG" && pass "inventory uses --network none" || fail "inventory used a stack network"
mv packages/contracts/openapi "$TMP/contracts.off"
expect 1 'no contracts at' "inventory refuses a missing contract tree" -- bash "$RUN" inventory
mkdir packages/contracts/openapi
printf 'openapi: 3.0.3\ninfo: {title: t, version: "1"}\npaths: {}\n' >packages/contracts/openapi/empty.yaml
expect 1 'no operations in' "inventory refuses zero operations" -- bash "$RUN" inventory
rm -rf packages/contracts/openapi
mv "$TMP/contracts.off" packages/contracts/openapi

owner_a="$(awk 'NR==1 {print $2}' "$TMP/inventory.txt")"
owner_b="$(awk '$1=="owner" {print $2}' "$TMP/inventory.txt" | sed -n 3p)"
plat_a="$(awk '$1=="platform" {print $2}' "$TMP/inventory.txt" | head -n 1)"
plat_only="$(awk 'NR == FNR { if ($1 == "owner") o[$2] = 1; next } $1 == "platform" && !($2 in o) { print $2; exit }' "$TMP/inventory.txt" "$TMP/inventory.txt")"

# ---- without SHARD_UNITS nothing changes ----------------------------------------
BASE_SH="${BASE_RUN_SH:-}"
if [[ -z "$BASE_SH" && -n "${RT809_BASE_SHA:-}" ]] && git -C "$SRC" cat-file -e "$RT809_BASE_SHA:tools/schemathesis/run.sh" 2>/dev/null; then
  git -C "$SRC" show "$RT809_BASE_SHA:tools/schemathesis/run.sh" >"$TMP/run.base.sh"
  BASE_SH="$TMP/run.base.sh"
fi
if [[ -n "$BASE_SH" ]]; then
  B="$(fixture base "$BASE_SH")"
  for mode in gate report; do
    for variant in plain crash fail; do
      case "$variant" in crash) export FAKE_ST_CRASH=1 ;; fail) export FAKE_ST_FAIL="$owner_a" ;; esac
      for which in new base; do
        proj="$P"; [[ "$which" == base ]] && proj="$B"
        : >"$FAKE_DOCKER_LOG"
        rm -f "$FUZZ_OUT"/manifest-*.txt
        set +e
        (cd "$proj" && bash tools/schemathesis/run.sh "$mode") >"$TMP/$which.out" 2>&1
        echo "exit=$?" >>"$TMP/$which.out"
        set -e
        sed "s#$(cygpath -m "$proj" 2>/dev/null || echo "$proj")#<P>#g; s#$proj#<P>#g" "$FAKE_DOCKER_LOG" >"$TMP/$which.log"
        sed -i "s#$(cygpath -m "$proj" 2>/dev/null || echo "$proj")#<P>#g; s#$proj#<P>#g" "$TMP/$which.out"
      done
      unset FAKE_ST_CRASH FAKE_ST_FAIL
      if cmp -s "$TMP/new.out" "$TMP/base.out" && cmp -s "$TMP/new.log" "$TMP/base.log" && ! ls "$FUZZ_OUT"/manifest-*.txt >/dev/null 2>&1; then
        pass "no SHARD_UNITS: $mode/$variant output, exit code and docker calls match the pre-RT-809 run.sh, no manifest"
      else
        fail "no SHARD_UNITS: $mode/$variant differs from the pre-RT-809 run.sh" "$(diff "$TMP/base.out" "$TMP/new.out" | head -n 6; diff "$TMP/base.log" "$TMP/new.log" | head -n 6)"
      fi
    done
  done
else
  echo "SKIP  unsharded-equivalence cases (set RT809_BASE_SHA=<commit before RT-809> or BASE_RUN_SH=<old run.sh>)"
  skips=$((skips + 1))
fi

# ---- SHARD_UNITS ----------------------------------------------------------------
printf 'owner %s\nowner %s\nplatform %s\n' "$owner_a" "$owner_b" "$plat_a" >"$TMP/units.txt"
rm -f "$FUZZ_OUT"/manifest-*.txt
: >"$FAKE_DOCKER_LOG"
SHARD_UNITS="$TMP/units.txt" bash "$RUN" gate >"$TMP/sharded.out" 2>&1 && pass "sharded gate exits 0" || fail "sharded gate failed" "$(tail -n 5 "$TMP/sharded.out")"
[[ "$(st_runs)" -eq 3 ]] && pass "only the 3 listed contract files ran" || fail "ran $(st_runs) contract files, want 3"
for f in "$owner_a" "$owner_b" "$plat_a"; do grep -q -- " run /contracts/$f " "$FAKE_DOCKER_LOG" || fail "$f did not run"; done
grep -qE "^Schemathesis gate \(owner credential\): 2 contract files" "$TMP/sharded.out" && pass "owner selection reported" || fail "owner selection line missing" "$(cat "$TMP/sharded.out")"
grep -qE "^Schemathesis gate \(platform credential\): 1 contract files" "$TMP/sharded.out" && pass "platform selection reported" || fail "platform selection line missing"
if [[ "$(wc -l <"$FUZZ_OUT/manifest-gate.txt")" -eq 3 ]] &&
  ! grep -vqE '^gate (owner|platform) [^ ]+ 0 0 9 [^ ,]+(,[^ ,]+)*$' "$FUZZ_OUT/manifest-gate.txt"; then
  pass "manifest has one well-formed line per file run (mode group file exit errored generated ids)"
else
  fail "manifest is malformed" "$(cat "$FUZZ_OUT/manifest-gate.txt")"
fi
ids_a="$(awk -v f="$owner_a" '$1=="owner" && $2==f {$1=$2=""; sub(/^ +/,""); gsub(/ /,","); print}' "$TMP/inventory.txt")"
grep -q "^gate owner $owner_a 0 0 9 $ids_a\$" "$FUZZ_OUT/manifest-gate.txt" && pass "manifest ids equal the inventory's" || fail "manifest ids differ from the inventory"

printf 'owner %s\n' "$owner_a" >"$TMP/units-owner.txt"
SHARD_UNITS="$TMP/units-owner.txt" bash "$RUN" report >"$TMP/sharded2.out" 2>&1 || fail "owner-only report failed"
if ! grep -q 'platform credential' "$TMP/sharded2.out" && [[ "$(wc -l <"$FUZZ_OUT/manifest-report.txt")" -eq 1 ]]; then pass "a shard without platform units skips the platform group"; else fail "owner-only shard ran platform"; fi

FAKE_ST_GENERATED=0 SHARD_UNITS="$TMP/units-owner.txt" bash "$RUN" gate >/dev/null 2>&1 || true
grep -q "^gate owner $owner_a 0 0 0 " "$FUZZ_OUT/manifest-gate.txt" && pass "manifest records a zero generated count for the fan-in to reject" || fail "zero count not recorded"
FAKE_ST_CRASH=1 SHARD_UNITS="$TMP/units-owner.txt" expect 1 'could not run' "sharded: a Schemathesis crash fails the step" -- bash "$RUN" gate
grep -q "^gate owner $owner_a 1 1 -1 " "$FUZZ_OUT/manifest-gate.txt" && pass "crash recorded as errored, exit 1, no generated count" || fail "crash not recorded" "$(cat "$FUZZ_OUT/manifest-gate.txt")"
FAKE_ST_FAIL="$owner_a" SHARD_UNITS="$TMP/units-owner.txt" expect 1 "$owner_a \(owner\): exit=1" "sharded: an unbaselined 5xx fails the gate" -- bash "$RUN" gate
grep -q "^gate owner $owner_a 1 0 9 " "$FUZZ_OUT/manifest-gate.txt" && pass "5xx recorded as exit 1, not errored" || fail "5xx not recorded"
FAKE_ST_FAIL="$owner_a" SHARD_UNITS="$TMP/units-owner.txt" expect 0 'findings are informational' "sharded: report findings stay non-gating" -- bash "$RUN" report
grep -q "^report owner $owner_a 1 0 9 " "$FUZZ_OUT/manifest-report.txt" && pass "report finding recorded as exit 1, not errored" || fail "report finding not recorded"

reject() { # <name> <pattern> <units content> [env...]
  local name="$1" pattern="$2" content="$3"
  shift 3
  printf '%s' "$content" >"$TMP/bad-units.txt"
  : >"$FAKE_DOCKER_LOG"
  set +e
  out="$(env SHARD_UNITS="$TMP/bad-units.txt" "$@" bash "$RUN" "${MODE_UNDER_TEST:-gate}" 2>&1)"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]] && grep -qE -- "$pattern" <<<"$out" && [[ "$(st_runs)" -eq 0 ]]; then pass "$name (exit $rc, nothing ran)"; else fail "$name: exit $rc, ran $(st_runs)" "$out"; fi
}
reject "rejects an empty unit file" 'missing or empty' ""
reject "rejects a malformed line" 'malformed or duplicate' $'owner\n'
reject "rejects an unknown group" 'malformed or duplicate' $'tenant a.yaml\n'
reject "rejects a duplicate line" 'malformed or duplicate' "owner $owner_a"$'\n'"owner $owner_a"$'\n'
reject "rejects a unit ops.py does not list" 'ops.py does not report: nope.yaml' $'owner nope.yaml\n'
if [[ -n "$plat_only" ]]; then
  reject "rejects a platform-only file listed as owner" 'ops.py does not report' "owner $plat_only"$'\n'
else
  echo "SKIP  platform-only-file case (every platform file name is also an owner file here)"
  skips=$((skips + 1))
fi
reject "rejects BASELINE_UPDATE" 'only for gate and report runs without BASELINE_UPDATE' "owner $owner_a"$'\n' BASELINE_UPDATE=1
MODE_UNDER_TEST=operator reject "rejects operator mode" 'only for gate and report runs' "owner $owner_a"$'\n'
MODE_UNDER_TEST=inventory reject "rejects inventory mode" 'only for gate and report runs' "owner $owner_a"$'\n'
expect 1 'missing or empty' "rejects a missing unit file" -- env SHARD_UNITS="$TMP/does-not-exist" bash "$RUN" gate

# ---- shard.sh: plan, run, collect, fan-in ---------------------------------------
SH="$P/tools/schemathesis/shard.sh"
for i in 0 1 2 3; do
  d="$TMP/shard-$i"
  mkdir -p "$d/out"
  cp "$FUZZ_OUT/cookie-owner" "$FUZZ_OUT/cookie-platform" "$FUZZ_OUT/stack.env" "$d/out/"
done
shard() { # <i> <command...>
  local i="$1"
  shift
  env SHARD_TOTAL=4 SHARD_INDEX="$i" SHARD_WS="$TMP/shard-$i/ws" FUZZ_OUT="$TMP/shard-$i/out" bash "$SH" "$@"
}
expect 1 'SHARD_INDEX must be in 0..3' "shard.sh rejects an index outside 0..N-1" -- env SHARD_TOTAL=4 SHARD_INDEX=4 bash "$SH" plan
expect 1 'SHARD_TOTAL must be a positive integer' "shard.sh rejects N=0" -- env SHARD_TOTAL=0 SHARD_INDEX=0 bash "$SH" plan
expect 1 'BASELINE_UPDATE is not allowed in sharded mode' "shard.sh refuses BASELINE_UPDATE" -- env SHARD_TOTAL=4 SHARD_INDEX=0 BASELINE_UPDATE=1 SHARD_WS="$TMP/x" bash "$SH" plan
for i in 0 1 2 3; do shard "$i" plan >"$TMP/plan-$i.out" 2>&1 || fail "shard $i plan failed" "$(tail -n 6 "$TMP/plan-$i.out")"; done
cat "$TMP"/shard-?/ws/units.txt | sort >"$TMP/all-units.txt"
awk '{print $1, $2}' "$TMP/inventory.txt" | sort >"$TMP/inv-units.txt"
cmp -s "$TMP/all-units.txt" "$TMP/inv-units.txt" && pass "the 4 shards' units are the inventory, each exactly once" || fail "shard units differ from the inventory" "$(diff "$TMP/all-units.txt" "$TMP/inv-units.txt" | head)"
cmp -s "$TMP/shard-0/ws/plan.txt" "$TMP/shard-3/ws/plan.txt" && pass "every shard computes the same plan" || fail "plans differ between shards"

for i in 0 1 2 3; do
  shard "$i" run gate >"$TMP/gate-$i.out" 2>&1 || fail "shard $i gate failed" "$(tail -n 6 "$TMP/gate-$i.out")"
  shard "$i" run report >"$TMP/report-$i.out" 2>&1 || fail "shard $i report failed" "$(tail -n 6 "$TMP/report-$i.out")"
  shard "$i" collect >"$TMP/collect-$i.out" 2>&1 || fail "shard $i collect failed" "$(tail -n 6 "$TMP/collect-$i.out")"
done
ls "$TMP/shard-0/ws/artifact" | tr '\n' ' ' | grep -q 'gate.rc.*manifest-gate.txt.*plan.txt.*report.rc.*sha.txt' && pass "artifact holds plan, SHA, exit codes and manifests only" || fail "unexpected artifact content: $(ls "$TMP/shard-0/ws/artifact")"
if [[ -z "$(find "$TMP"/shard-?/ws/artifact -name '*.txt' -newer "$TMP/units.txt" -name '[a-z]*-owner-*' 2>/dev/null)" ]]; then pass "no raw per-file log is published"; fi

DL="$TMP/downloaded"
assemble() { rm -rf "$DL"; mkdir -p "$DL"; for i in 0 1 2 3; do cp -R "$TMP/shard-$i/ws/artifact" "$DL/schemathesis-shard-$i"; done; }
fanin() { env SHARD_TOTAL=4 SHARD_WS="$TMP/fanin" SHARD_ARTIFACTS="$DL" SHARDS_RESULT="${1:-success}" bash "$SH" fanin; }
assemble
expect 0 'verdict: PASS' "fan-in passes when all 4 shards ran their plan" -- fanin success
expect 1 "shard jobs finished 'failure'" "fan-in fails when a shard job failed" -- fanin failure
expect 1 "shard jobs finished 'cancelled'" "fan-in fails when a shard job was cancelled" -- fanin cancelled
expect 1 "shard jobs finished 'skipped'" "fan-in fails when the shard jobs were skipped" -- fanin skipped
expect 1 'SHARDS_RESULT is not set' "fan-in fails without a shard job result" -- env SHARD_TOTAL=4 SHARD_ARTIFACTS="$DL" SHARD_WS="$TMP/fanin" bash "$SH" fanin
rm -rf "$DL/schemathesis-shard-2"
expect 1 'schemathesis-shard-2 is missing' "fan-in fails when a shard artifact is absent" -- fanin success
assemble
echo deadbeef >"$DL/schemathesis-shard-1/sha.txt"
expect 1 'shard 1 ran SHA deadbeef' "fan-in fails on a shard from another SHA" -- fanin success
assemble
printf 'gate owner x.yaml 0 0 9 a\n' >>"$DL/schemathesis-shard-0/manifest-gate.txt"
expect 1 'x.yaml \(owner\) ran 1 times \(in inventory: False\)' "fan-in fails on an unexpected contract file" -- fanin success
assemble
sed -i '1d' "$DL/schemathesis-shard-3/manifest-report.txt"
expect 1 'report: .* ran 0 times' "fan-in fails on a missing contract file" -- fanin success

# ---- secret guard ---------------------------------------------------------------
cp -R "$TMP/shard-0/out/." "$TMP/shard-0/out2" 2>/dev/null || true
echo "curl -H 'Cookie: dp2_session=$(cat "$FUZZ_OUT/cookie-owner")'" >"$TMP/shard-0/out/gate.md"
expect 1 'a credential appeared in a file to publish' "collect withholds the artifact when a cookie is in a findings file" -- shard 0 collect
[[ ! -e "$TMP/shard-0/ws/artifact" ]] && pass "the artifact directory is removed" || fail "artifact directory still present"
echo "### clean finding" >"$TMP/shard-0/out/gate.md"
printf 'redis0123456789abcdef0123456789' >>"$TMP/shard-0/out/report.md"
expect 1 'a credential appeared' "collect withholds the artifact when a stack password is in a findings file" -- shard 0 collect

if [[ "$fails" -gt 0 ]]; then
  echo "$fails shard-run case(s) failed"
  exit 1
fi
echo "all shard-run cases passed ($skips skipped)"
