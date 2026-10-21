"""Shard plan, fan-in and 3-vs-4 comparison for the sharded Schemathesis PR job (RT-809).

  plan    <inventory> <N> <timings>   "<shard> <group> <file> <operationIds...>" per unit
  select  <plan> <index>              "<group> <file>" per unit of one shard (run.sh SHARD_UNITS)
  check   --inventory F --shards N --timings F --ws DIR --sha SHA [--out F] [--job-result R]
                                      fan-in: exit 1 unless every shard ran exactly its plan and
                                      the union equals the inventory exactly once per mode
  compare <inventory> <timings> [--overhead S] [N ...]
                                      planned seconds per shard for several N (a model, not a measurement)

<inventory> is `run.sh inventory` output: "<group> <file> <operationIds...>" for the owner and
platform groups, from ops.py at the SHA under test, never a hardcoded list. Units are one per
owner contract file plus the whole platform group as one unit, so the platform files keep their
relative order on one stack. Assignment is LPT on the seconds in <timings> (JSON
{"<group> <file>": seconds}): units sorted by (-seconds, key), each to the least-loaded shard,
ties to the lowest index. A unit with no timing gets the median, so a new contract still lands
on a shard; a timing for a unit that no longer exists is ignored.

Fan-in layout (one directory per shard, written by shard.sh collect):
  <ws>/schemathesis-shard-<i>/{sha.txt, plan.txt, gate.rc, report.rc,
                               manifest-gate.txt, manifest-report.txt, gate.md, report.md}
A manifest line is "<mode> <group> <file> <exit> <errored 0|1> <generated> <id,id,...>" and is
written by run.sh itself. Everything that cannot be read or parsed is a problem, never a pass.

Stdlib only: runs on the host python3.
"""
import argparse
import dataclasses
import hashlib
import json
import math
import os
import pathlib
import statistics
import sys
import tempfile
from typing import Dict, List, NamedTuple, Optional, Set, Tuple

GROUPS = ("owner", "platform")
MODES = ("gate", "report")
ARTIFACT_PREFIX = "schemathesis-shard-"
DEFAULT_OVERHEAD_SECONDS = 120  # stack + clone per shard, RT-786 comment 13307

Unit = Tuple[str, str]  # (group, contract file)


class PlanError(ValueError):
    """The inventory, timings or arguments cannot produce a valid plan."""


class Row(NamedTuple):
    shard: int
    group: str
    file: str
    ids: Tuple[str, ...]


class ManifestEntry(NamedTuple):
    mode: str
    group: str
    file: str
    rc: int
    errored: bool
    generated: int
    ids: Tuple[str, ...]


# ---- inventory, timings, plan ------------------------------------------------------


def parse_inventory_line(n: int, line: str) -> Tuple[str, str, Tuple[str, ...]]:
    parts = line.split()
    if len(parts) < 3 or parts[0] not in GROUPS:
        raise PlanError(f"inventory line {n} is malformed: {line!r}")
    group, file, *ids = parts
    if len(set(ids)) != len(ids):
        raise PlanError(f"inventory lists an operation twice in {file} ({group})")
    return group, file, tuple(ids)


def read_inventory(path: str) -> List[Tuple[str, str, Tuple[str, ...]]]:
    rows: List[Tuple[str, str, Tuple[str, ...]]] = []
    seen: Set[Unit] = set()
    for n, line in enumerate(pathlib.Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        group, file, ids = parse_inventory_line(n, line)
        if (group, file) in seen:
            raise PlanError(f"inventory lists {file} ({group}) twice")
        seen.add((group, file))
        rows.append((group, file, ids))
    if not rows:
        raise PlanError("empty inventory")
    return rows


def is_positive_seconds(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value) and value > 0


def read_timings(path: str) -> Dict[str, float]:
    data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise PlanError("timings must be a JSON object")
    for key, seconds in data.items():
        if not is_positive_seconds(seconds):
            raise PlanError(f"timing for {key!r} is not a positive number")
    return data


def unit_key(group: str, file: str) -> str:
    return "platform *" if group == "platform" else f"{group} {file}"


def build_units(inventory, timings):
    default = statistics.median(timings.values()) if timings else 1.0
    units: Dict[str, list] = {}
    for group, file, ids in inventory:
        units.setdefault(unit_key(group, file), []).append((group, file, ids))
    weight = {k: sum(timings.get(f"{g} {f}", default) for g, f, _ in rows) for k, rows in units.items()}
    return units, weight


def plan(inventory, shards: int, timings) -> Tuple[List[Row], List[float]]:
    if not isinstance(shards, int) or shards < 1:
        raise PlanError("N must be >= 1")
    units, weight = build_units(inventory, timings)
    if shards > len(units):
        raise PlanError(f"{shards} shards for {len(units)} units would leave a shard with no coverage")
    load = [0.0] * shards
    out: List[Row] = []
    for key in sorted(units, key=lambda k: (-weight[k], k)):
        shard = min(range(shards), key=lambda i: (load[i], i))
        load[shard] += weight[key]
        out.extend(Row(shard, g, f, ids) for g, f, ids in units[key])
    return sorted(out, key=lambda r: (r.shard, r.group != "owner", r.file)), load


def plan_lines(rows: List[Row]) -> List[str]:
    return [" ".join([str(r.shard), r.group, r.file, *r.ids]) for r in rows]


def select(plan_text: str, index: int) -> List[str]:
    out = []
    for line in plan_text.splitlines():
        if not line.strip():
            continue
        shard, group, file, *_ids = line.split()
        if int(shard) == index:
            out.append(f"{group} {file}")
    if not out:
        raise PlanError(f"shard {index} has no units in the plan")
    return out


def digest(lines: List[str]) -> str:
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()[:16]


# ---- fan-in ----------------------------------------------------------------------


def read_text(path) -> Optional[str]:
    try:
        return pathlib.Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def parse_manifest_line(line: str) -> ManifestEntry:
    """Raise ValueError unless the line is exactly well-formed."""
    mode, group, file, rc, errored, generated, ids = line.split()
    exit_code, count, id_list = int(rc), int(generated), ids.split(",")
    in_range = [mode in MODES, group in GROUPS, errored in ("0", "1"), exit_code >= 0, count >= -1, "" not in id_list]
    if not all(in_range):
        raise ValueError("field out of range")
    return ManifestEntry(mode, group, file, exit_code, errored == "1", count, tuple(sorted(id_list)))


def parse_manifest(text: str) -> Tuple[List[ManifestEntry], List[str]]:
    """Return (entries, problems). A line that is not exactly well-formed is a problem."""
    entries: List[ManifestEntry] = []
    problems: List[str] = []
    for n, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            entries.append(parse_manifest_line(line))
        except ValueError:
            problems.append(f"manifest line {n} is corrupt: {line[:120]!r}")
    return entries, problems


class RunInfo(NamedTuple):
    """What the fan-in observed about this run: artifact directory, SHA, shard jobs' result."""

    ws: str
    sha: str
    job_result: Optional[str] = None


@dataclasses.dataclass
class FanIn:
    """Everything one fan-in check reads and collects."""

    inventory: list
    shards: int
    ws: pathlib.Path
    sha: str
    rows: List[Row]
    load: List[float]
    want: Dict[Unit, Tuple[str, ...]]
    expected_plan: List[str]
    problems: List[str] = dataclasses.field(default_factory=list)
    seen: Dict[str, Dict[Unit, List[int]]] = dataclasses.field(default_factory=lambda: {m: {} for m in MODES})
    gen: Dict[str, Dict[Unit, Tuple[int, int]]] = dataclasses.field(default_factory=lambda: {m: {} for m in MODES})

    def shard_dir(self, i: int) -> pathlib.Path:
        return self.ws / f"{ARTIFACT_PREFIX}{i}"

    def planned_units(self, i: int) -> Set[Unit]:
        return {(r.group, r.file) for r in self.rows if r.shard == i}


def check_shard_header(fan: FanIn, i: int) -> None:
    d = fan.shard_dir(i)
    sha_txt = read_text(d / "sha.txt")
    if sha_txt is None:
        fan.problems.append(f"shard {i}: sha.txt is missing or unreadable")
    elif sha_txt.strip() != fan.sha:
        fan.problems.append(f"shard {i} ran SHA {sha_txt.strip()[:12]}, the fan-in is at {fan.sha[:12]}")
    plan_txt = read_text(d / "plan.txt")
    if plan_txt is None:
        fan.problems.append(f"shard {i}: plan.txt is missing or unreadable")
    elif plan_txt.splitlines() != fan.expected_plan:
        fan.problems.append(f"shard {i} computed a different plan than the fan-in")


def entry_problems(fan: FanIn, mode: str, entry: ManifestEntry) -> List[str]:
    """What is wrong with one manifest line that belongs to `mode`."""
    key = (entry.group, entry.file)
    where = f"{entry.file} ({entry.group})"
    found = []
    if key in fan.want and entry.ids != tuple(sorted(fan.want[key])):
        found.append(f"{where} ran operations that differ from the inventory")
    if entry.errored:
        return found + [f"Schemathesis could not run {where}"]
    if entry.generated < 1:
        found.append(f"{where} generated no test cases ({entry.generated})")
    if mode == "gate" and entry.rc != 0:
        found.append(f"unbaselined 5xx in {where}")
    return found


def check_entry(fan: FanIn, i: int, mode: str, entry: ManifestEntry) -> Optional[Unit]:
    """Record one manifest line; return the unit it ran, or None if it belongs to another mode."""
    if entry.mode != mode:
        fan.problems.append(f"shard {i} {mode}: manifest line for mode {entry.mode} ({entry.file})")
        return None
    key = (entry.group, entry.file)
    fan.seen[mode].setdefault(key, []).append(i)
    fan.gen[mode][key] = (entry.generated, entry.rc)
    fan.problems.extend(f"shard {i} {mode}: {p}" for p in entry_problems(fan, mode, entry))
    return key


def check_shard_mode(fan: FanIn, i: int, mode: str) -> None:
    d = fan.shard_dir(i)
    rc_txt = read_text(d / f"{mode}.rc")
    rc = rc_txt.strip() if rc_txt is not None else "missing"
    if rc != "0":
        what = "unbaselined 5xx or the run could not finish" if mode == "gate" else "the run could not finish"
        fan.problems.append(f"shard {i} {mode} exit={rc} ({what})")
    manifest = read_text(d / f"manifest-{mode}.txt")
    if manifest is None:
        fan.problems.append(f"shard {i}: manifest-{mode}.txt is missing or unreadable")
        return
    entries, bad = parse_manifest(manifest)
    fan.problems.extend(f"shard {i} {mode}: {p}" for p in bad)
    ran = {key for key in (check_entry(fan, i, mode, e) for e in entries) if key is not None}
    mine = fan.planned_units(i)
    if ran != mine:
        fan.problems.append(f"shard {i} {mode} ran {sorted(ran ^ mine)} differently from its plan")


def check_artifact_dirs(fan: FanIn) -> None:
    names = [p.name for p in fan.ws.iterdir() if p.is_dir()] if fan.ws.is_dir() else []
    present = {n for n in names if n.startswith(ARTIFACT_PREFIX)}
    wanted = {f"{ARTIFACT_PREFIX}{i}" for i in range(fan.shards)}
    fan.problems.extend(
        f"{n} is missing (shard did not run, expired or was not uploaded)" for n in sorted(wanted - present)
    )
    fan.problems.extend(f"unexpected artifact {n}" for n in sorted(present - wanted))


def covered_operations(fan: FanIn, mode: str) -> int:
    return sum(len(ids) for key, ids in fan.want.items() if len(fan.seen[mode].get(key, [])) == 1)


def check_coverage(fan: FanIn) -> None:
    total = sum(len(ids) for ids in fan.want.values())
    for mode in MODES:
        for key in sorted(set(fan.want) | set(fan.seen[mode])):
            count = len(fan.seen[mode].get(key, []))
            if key not in fan.want or count != 1:
                fan.problems.append(f"{mode}: {key[1]} ({key[0]}) ran {count} times (in inventory: {key in fan.want})")
        covered = covered_operations(fan, mode)
        if covered != total:
            fan.problems.append(f"{mode}: covered {covered} operations, the inventory has {total}")


def summary_lines(fan: FanIn) -> List[str]:
    total = sum(len(ids) for ids in fan.want.values())
    per_group = {
        g: (sum(1 for k in fan.want if k[0] == g), sum(len(v) for k, v in fan.want.items() if k[0] == g))
        for g in GROUPS
    }
    inv_lines = sorted(" ".join([g, f, *ids]) for g, f, ids in fan.inventory)
    gate_counts = [f"{g} {f} {fan.gen['gate'].get((g, f), ('-',))[0]}" for g, f in sorted(fan.want)]
    findings = [f"{g} {f}" for g, f in sorted(fan.want) if fan.gen["report"].get((g, f), (0, 0))[1] != 0]
    return [
        f"# Schemathesis, {fan.shards} shard(s), merged (RT-809)",
        "",
        f"- verdict: {'PASS' if not fan.problems else 'FAIL'}",
        f"- SHA: {fan.sha}",
        f"- inventory: {len(fan.want)} (group, file) units, {total} operations "
        f"(owner {per_group['owner'][0]} files / {per_group['owner'][1]} ops, "
        f"platform {per_group['platform'][0]} files / {per_group['platform'][1]} ops), digest {digest(inv_lines)}",
        f"- covered operations: gate {covered_operations(fan, 'gate')}, report {covered_operations(fan, 'report')}",
        f"- gate generated-counts digest: {digest(gate_counts)}",
        f"- report files with findings ({len(findings)}), digest {digest(findings)}: {', '.join(findings) or 'none'}",
        f"- planned seconds per shard (model): {', '.join(f'{x:.0f}' for x in fan.load)}",
    ]


def table_lines(fan: FanIn) -> List[str]:
    lines = [
        "",
        "| shard | group | file | ops | gate generated | gate exit | report generated | report exit |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for row in fan.rows:
        key = (row.group, row.file)
        gate_generated, gate_exit = fan.gen["gate"].get(key, ("-", "-"))
        report_generated, report_exit = fan.gen["report"].get(key, ("-", "-"))
        lines.append(
            f"| {row.shard} | {row.group} | {row.file} | {len(row.ids)} | {gate_generated} | {gate_exit} "
            f"| {report_generated} | {report_exit} |"
        )
    return lines


def findings_lines(fan: FanIn) -> List[str]:
    lines: List[str] = []
    if fan.problems:
        lines += ["", "## Fan-in problems", *[f"- {p}" for p in fan.problems]]
    for mode in MODES:
        lines += ["", f"## {mode} findings by shard"]
        for i in range(fan.shards):
            body = read_text(fan.shard_dir(i) / f"{mode}.md")
            lines += ["", f"### shard {i}", (body or "(missing)").strip() or "No findings."]
    return lines


def check(inventory, shards: int, timings, run_info: RunInfo):
    rows, load = plan(inventory, shards, timings)
    fan = FanIn(
        inventory=inventory,
        shards=shards,
        ws=pathlib.Path(run_info.ws),
        sha=run_info.sha,
        rows=rows,
        load=load,
        want={(r.group, r.file): r.ids for r in rows},
        expected_plan=plan_lines(rows),
    )
    if run_info.job_result is not None and run_info.job_result != "success":
        fan.problems.append(f"the shard jobs finished '{run_info.job_result}' (expected success)")
    check_artifact_dirs(fan)
    for i in range(shards):
        if fan.shard_dir(i).is_dir():
            check_shard_header(fan, i)
            for mode in MODES:
                check_shard_mode(fan, i, mode)
    check_coverage(fan)
    return fan.problems, summary_lines(fan) + table_lines(fan) + findings_lines(fan)


# ---- comparison, CLI -------------------------------------------------------------


def compare(inventory, timings, counts: List[int], overhead: float) -> List[str]:
    units, weight = build_units(inventory, timings)
    total = sum(weight.values())
    unmeasured = sum(1 for g, f, _ in inventory if f"{g} {f}" not in timings)
    lines = [
        "# Planned shard comparison (a model from timings, NOT a measurement)",
        "",
        f"- {len(units)} units, {sum(len(ids) for *_, ids in inventory)} operations; "
        f"{total:.0f} s of fuzzing in total; {unmeasured} file(s) with no timing (median used)",
        f"- per-shard fixed cost assumed: {overhead:.0f} s (stack + clone); queue wait is NOT modelled",
        "",
        "| N | planned s per shard | makespan s | modelled elapsed s | modelled runner-minutes | vs N=1 elapsed |",
        "|---|---|---|---|---|---|",
    ]
    base = None
    for n in counts:
        _, load = plan(inventory, n, timings)
        elapsed = overhead + max(load)
        runner_min = (n * overhead + total) / 60
        base = elapsed if base is None else base
        lines.append(
            f"| {n} | {', '.join(f'{x:.0f}' for x in load)} | {max(load):.0f} | {elapsed:.0f} "
            f"| {runner_min:.1f} | {elapsed / base:.2f}x |"
        )
    return lines


def allowed_roots() -> List[str]:
    """The directories this tool may read and write: the checkout it runs in and the temp area."""
    candidates = [os.getcwd(), tempfile.gettempdir(), os.environ.get("RUNNER_TEMP", "")]
    return [os.path.normcase(os.path.realpath(c)) for c in candidates if c]


def safe_path(value: str) -> str:
    """Canonicalize a path argument and reject one outside the allowed roots (RT-809, Sonar S8707)."""
    resolved = os.path.normcase(os.path.realpath(value))
    for root in allowed_roots():
        if resolved == root or resolved.startswith(root.rstrip(os.sep) + os.sep):
            return resolved
    raise argparse.ArgumentTypeError(f"path {value!r} is outside the working directory and the temp area")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("plan")
    s.add_argument("inventory", type=safe_path)
    s.add_argument("shards", type=int)
    s.add_argument("timings", type=safe_path)
    s = sub.add_parser("select")
    s.add_argument("plan", type=safe_path)
    s.add_argument("index", type=int)
    s = sub.add_parser("check")
    s.add_argument("--inventory", required=True, type=safe_path)
    s.add_argument("--shards", type=int, required=True)
    s.add_argument("--timings", required=True, type=safe_path)
    s.add_argument("--ws", required=True, type=safe_path)
    s.add_argument("--sha", required=True)
    s.add_argument("--out", type=safe_path)
    s.add_argument("--job-result")
    s = sub.add_parser("compare")
    s.add_argument("inventory", type=safe_path)
    s.add_argument("timings", type=safe_path)
    s.add_argument("--overhead", type=float, default=DEFAULT_OVERHEAD_SECONDS)
    s.add_argument("counts", nargs="*", type=int)
    return p


def run_check(args: argparse.Namespace) -> int:
    run_info = RunInfo(args.ws, args.sha, args.job_result)
    problems, lines = check(read_inventory(args.inventory), args.shards, read_timings(args.timings), run_info)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as handle:
            handle.write("\n".join(lines) + "\n")
    print("\n".join(lines[:8]))
    for p in problems:
        print(f"FAN-IN: {p}", file=sys.stderr)
    return 1 if problems else 0


def run_plan(args: argparse.Namespace) -> int:
    rows, _ = plan(read_inventory(args.inventory), args.shards, read_timings(args.timings))
    print("\n".join(plan_lines(rows)))
    return 0


def run_select(args: argparse.Namespace) -> int:
    print("\n".join(select(pathlib.Path(args.plan).read_text(encoding="utf-8"), args.index)))
    return 0


def run_compare(args: argparse.Namespace) -> int:
    lines = compare(read_inventory(args.inventory), read_timings(args.timings), args.counts or [1, 3, 4], args.overhead)
    print("\n".join(lines))
    return 0


COMMANDS = {"plan": run_plan, "select": run_select, "compare": run_compare, "check": run_check}


def run(args: argparse.Namespace) -> int:
    return COMMANDS[args.cmd](args)


def main(argv: List[str]) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(newline="\n")  # LF on Windows too: run.sh reads these lines
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except Exception as exc:  # fail closed: an unreadable input is a failure, never a pass
        print(f"shards.py {args.cmd}: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
