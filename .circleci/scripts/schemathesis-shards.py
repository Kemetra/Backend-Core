"""Shard plan and fan-in for the sharded Schemathesis lane job (RT-806, lane only).

  plan  <inventory> <N> <timings>             print "<shard> <group> <file> <ids...>" per unit
  check <inventory> <N> <timings> <ws> <out>  fan-in: fail unless every shard ran its plan,
                                              the union equals the inventory exactly once per
                                              mode, and every gate passed; write the merged report

<inventory> is ops.py output prefixed with the group: "<group> <file> <ids...>" (from
ops.py at the same SHA, never a hardcoded list). Units are one per owner file plus the
whole platform group as one unit, so its files stay together. Assignment is LPT: units
sorted by (-seconds, key), each to the least-loaded shard (ties to the lowest index).
A unit missing from <timings> gets the median, so a new contract still lands on a shard.
Stdlib only: runs on the host python3.
"""
import hashlib
import json
import pathlib
import re
import statistics
import sys

MODES = ("gate", "report")


def read_inventory(path):
    rows = []
    for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            group, file, *ids = line.split()
            rows.append((group, file, tuple(ids)))
    if not rows:
        sys.exit("empty inventory")
    return rows


def plan(inventory, shards, timings_path):
    timings = json.loads(pathlib.Path(timings_path).read_text(encoding="utf-8"))
    default = statistics.median(timings.values())
    units = {}
    for group, file, ids in inventory:
        key = "platform *" if group == "platform" else f"{group} {file}"
        units.setdefault(key, []).append((group, file, ids))
    weight = {key: sum(timings.get(f"{g} {f}", default) for g, f, _ in rows) for key, rows in units.items()}
    load = [0.0] * shards
    out = []
    for key in sorted(units, key=lambda k: (-weight[k], k)):
        shard = min(range(shards), key=lambda i: (load[i], i))
        load[shard] += weight[key]
        out.extend((shard, g, f, ids) for g, f, ids in units[key])
    return sorted(out, key=lambda r: (r[0], r[1] != "owner", r[2])), load


def plan_lines(rows):
    return [" ".join([str(s), g, f, *ids]) for s, g, f, ids in rows]


def read_lines(path):
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


def read_manifest(path):
    """Lines "<mode> <group> <file> <exit> <errored> <generated>" written by the shard."""
    rows = []
    for line in read_lines(path):
        if line.strip():
            mode, group, file, rc, errored, generated = line.split()
            rows.append((mode, group, file, int(rc), errored == "1", int(generated)))
    return rows


def digest(lines):
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()[:16]


def check(inventory, shards, timings_path, ws, out):
    rows, load = plan(inventory, shards, timings_path)
    expected = plan_lines(rows)
    want = {(g, f) for _, g, f, _ in rows}
    problems = []
    seen = {m: {} for m in MODES}
    gen = {m: {} for m in MODES}
    nodes = sorted(p.name for p in pathlib.Path(ws).glob("node-*"))
    if nodes != [f"node-{i}" for i in range(shards)]:
        problems.append(f"expected shards node-0..node-{shards - 1}, found {nodes}")
    for i in range(shards):
        node = pathlib.Path(ws) / f"node-{i}"
        if not node.is_dir():
            continue
        if read_lines(node / "plan.txt") != expected:
            problems.append(f"node-{i} computed a different plan than the fan-in")
        mine = {(g, f) for s, g, f, _ in rows if s == i}
        for mode in MODES:
            rc_file = node / f"{mode}.rc"
            rc = rc_file.read_text().strip() if rc_file.exists() else "missing"
            if rc != "0":
                problems.append(f"node-{i} {mode} exit={rc}")
            ran = set()
            for m, g, f, file_rc, errored, generated in read_manifest(node / "manifest.txt"):
                if m != mode:
                    continue
                ran.add((g, f))
                seen[mode].setdefault((g, f), []).append(i)
                gen[mode][(g, f)] = (generated, file_rc)
                if errored:
                    problems.append(f"node-{i} {mode} could not run {f} ({g})")
                if mode == "gate" and file_rc != 0:
                    problems.append(f"node-{i} gate: unbaselined 5xx in {f} ({g})")
            if ran != mine:
                problems.append(f"node-{i} {mode} ran {sorted(ran ^ mine)} differently from its plan")
    for mode in MODES:
        for key in sorted(want | set(seen[mode])):
            count = len(seen[mode].get(key, []))
            if key not in want or count != 1:
                problems.append(f"{mode}: {key[1]} ({key[0]}) ran {count} times (inventory: {key in want})")

    inv_lines = sorted(" ".join([g, f, *ids]) for g, f, ids in inventory)
    gate_counts = [f"{g} {f} {gen['gate'].get((g, f), ('-',))[0]}" for g, f in sorted(want)]
    report_findings = [f"{g} {f}" for g, f in sorted(want) if gen["report"].get((g, f), (0, 0))[1] != 0]
    lines = [
        f"# Schemathesis, {shards} shard(s), merged (RT-806 lane)",
        "",
        f"- inventory: {len(want)} (group, file) runs, {sum(len(ids) for *_, ids in inventory)} operations, digest {digest(inv_lines)}",
        f"- gate generated-counts digest: {digest(gate_counts)}",
        f"- report files with findings ({len(report_findings)}), digest {digest(report_findings)}: {', '.join(report_findings) or 'none'}",
        f"- planned seconds per shard: {', '.join(f'{x:.0f}' for x in load)}",
        f"- verdict: {'PASS' if not problems else 'FAIL'}",
        "",
        "| shard | group | file | ops | gate generated | gate exit | report generated | report exit |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for s, g, f, ids in rows:
        gg, ge = gen["gate"].get((g, f), ("-", "-"))
        rg, re_ = gen["report"].get((g, f), ("-", "-"))
        lines.append(f"| {s} | {g} | {f} | {len(ids)} | {gg} | {ge} | {rg} | {re_} |")
    if problems:
        lines += ["", "## Fan-in problems", *[f"- {p}" for p in problems]]
    for mode in MODES:
        lines += ["", f"## {mode} findings by shard"]
        for i in range(shards):
            md = pathlib.Path(ws) / f"node-{i}" / f"{mode}.md"
            body = md.read_text(encoding="utf-8").strip() if md.exists() else "(missing)"
            lines += ["", f"### shard {i}", body or "No findings."]
    pathlib.Path(out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[:8]))
    for p in problems:
        print(f"FAN-IN: {p}", file=sys.stderr)
    return 1 if problems else 0


def main(argv):
    cmd, inventory, shards, timings = argv[1], read_inventory(argv[2]), int(argv[3]), argv[4]
    if shards < 1:
        sys.exit("N must be >= 1")
    if cmd == "plan":
        print("\n".join(plan_lines(plan(inventory, shards, timings)[0])))
        return 0
    if cmd == "check":
        return check(inventory, shards, timings, argv[5], argv[6])
    sys.exit(f"unknown command: {cmd}")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
