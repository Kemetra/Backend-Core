"""RT-809: Docker-free tests for the shard planner and the fail-closed fan-in.

Usage: python3 tools/schemathesis/__tests__/shards.test.py
Stdlib only. The `schemathesis` fan-in job in ci.yml runs it before it trusts the shards.
The real-inventory case also needs PyYAML and is skipped without it.
"""
import argparse
import importlib.util
import io
import json
import os
import pathlib
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

HERE = pathlib.Path(__file__).resolve().parent
SCHEMATHESIS = HERE.parent
spec = importlib.util.spec_from_file_location("shards", SCHEMATHESIS / "shards.py")
shards = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shards)

SHA = "c9dcb93fa0cd9fbd92fe5da6faa0b8017cfd6608"
INVENTORY = [
    ("owner", f"o{i:02d}.yaml", tuple(f"op{i}x{j}" for j in range(1 + i % 3))) for i in range(10)
] + [
    ("platform", "p1.yaml", ("pa", "pb")),
    ("platform", "p2.yaml", ("pc",)),
    ("platform", "p3.yaml", ("pd",)),
]
TIMINGS = {f"owner o{i:02d}.yaml": 10 + 7 * (i % 4) + i for i in range(10)}
TIMINGS.update({"platform p1.yaml": 20, "platform p2.yaml": 15, "platform p3.yaml": 9})


def write_inventory(path, rows):
    pathlib.Path(path).write_text("".join(" ".join([g, f, *ids]) + "\n" for g, f, ids in rows), encoding="utf-8")


GENERATED = 7


def make_ws(root, rows, shard_count, timings):
    """Valid shard artifacts for `rows`, exactly as shard.sh collect would leave them."""
    plan_rows, _ = shards.plan(rows, shard_count, timings)
    plan_txt = "\n".join(shards.plan_lines(plan_rows)) + "\n"
    for i in range(shard_count):
        d = pathlib.Path(root) / f"{shards.ARTIFACT_PREFIX}{i}"
        d.mkdir(parents=True)
        (d / "sha.txt").write_text(SHA + "\n")
        (d / "plan.txt").write_text(plan_txt)
        for mode in shards.MODES:
            (d / f"{mode}.rc").write_text("0\n")
            lines = [
                f"{mode} {g} {f} 0 0 {GENERATED} {','.join(ids)}" for s, g, f, ids in plan_rows if s == i
            ]
            (d / f"manifest-{mode}.txt").write_text("\n".join(lines) + "\n")
            (d / f"{mode}.md").write_text("")
    return pathlib.Path(root)


class TempCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def shard_dir(self, ws, i):
        return ws / f"{shards.ARTIFACT_PREFIX}{i}"


class PlannerTests(TempCase):
    def test_every_unit_exactly_once_for_n_1_3_4(self):
        for n in (1, 3, 4):
            rows, load = shards.plan(INVENTORY, n, TIMINGS)
            got = sorted((g, f, ids) for _, g, f, ids in rows)
            self.assertEqual(got, sorted(INVENTORY), f"N={n}")
            self.assertEqual({s for s, *_ in rows}, set(range(n)), f"N={n}: a shard has no unit")
            self.assertEqual(len(load), n)

    def test_platform_group_stays_together_and_owner_runs_first(self):
        for n in (1, 3, 4):
            rows, _ = shards.plan(INVENTORY, n, TIMINGS)
            self.assertEqual(len({s for s, g, *_ in rows if g == "platform"}), 1, f"N={n}")
            for shard in range(n):
                order = [g for s, g, *_ in rows if s == shard]
                self.assertEqual(order, sorted(order, key=lambda g: g != "owner"))

    def test_deterministic_and_independent_of_inventory_order(self):
        first = shards.plan_lines(shards.plan(INVENTORY, 4, TIMINGS)[0])
        shuffled = list(INVENTORY)
        random.Random(7).shuffle(shuffled)
        self.assertEqual(shards.plan_lines(shards.plan(shuffled, 4, TIMINGS)[0]), first)
        self.assertEqual(shards.plan_lines(shards.plan(INVENTORY, 4, TIMINGS)[0]), first)

    def test_more_shards_never_lengthen_the_critical_path(self):
        spans = [max(shards.plan(INVENTORY, n, TIMINGS)[1]) for n in (1, 3, 4)]
        self.assertGreaterEqual(spans[0], spans[1])
        self.assertGreaterEqual(spans[1], spans[2])

    def test_new_contract_without_a_timing_lands_on_a_shard(self):
        rows = INVENTORY + [("owner", "brand-new.yaml", ("newOp",))]
        for n in (1, 3, 4):
            plan_rows, _ = shards.plan(rows, n, TIMINGS)
            self.assertEqual([(s, ids) for s, g, f, ids in plan_rows if f == "brand-new.yaml"][0][1], ("newOp",))
            self.assertEqual(sum(1 for _, _, f, _ in plan_rows if f == "brand-new.yaml"), 1)

    def test_empty_timings_still_plan_every_unit(self):
        rows, _ = shards.plan(INVENTORY, 4, {})
        self.assertEqual(len(rows), len(INVENTORY))

    def test_a_timing_for_a_file_that_no_longer_exists_is_ignored(self):
        stale = dict(TIMINGS, **{"owner removed.yaml": 9999})
        self.assertEqual(shards.plan(INVENTORY, 3, stale), shards.plan(INVENTORY, 3, TIMINGS))

    def test_rejects_zero_or_negative_shards_and_shards_without_coverage(self):
        for n in (0, -1):
            with self.assertRaises(shards.PlanError):
                shards.plan(INVENTORY, n, TIMINGS)
        units = len({shards.unit_key(g, f) for g, f, _ in INVENTORY})
        shards.plan(INVENTORY, units, TIMINGS)
        with self.assertRaises(shards.PlanError):
            shards.plan(INVENTORY, units + 1, TIMINGS)

    def test_select_returns_this_shards_units_and_rejects_an_empty_one(self):
        rows, _ = shards.plan(INVENTORY, 4, TIMINGS)
        text = "\n".join(shards.plan_lines(rows))
        picked = [line for i in range(4) for line in shards.select(text, i)]
        self.assertEqual(sorted(picked), sorted(f"{g} {f}" for g, f, _ in INVENTORY))
        with self.assertRaises(shards.PlanError):
            shards.select(text, 4)

    def test_inventory_and_timing_validation(self):
        inv = self.tmp / "inv.txt"
        bad_inventories = [
            "",
            "\n\n",
            "owner a.yaml\n",  # no operation id
            "tenant a.yaml op\n",  # unknown group
            "owner a.yaml op\nowner a.yaml op2\n",  # file listed twice
            "owner a.yaml op op\n",  # operation listed twice
        ]
        for text in bad_inventories:
            inv.write_text(text, encoding="utf-8")
            with self.assertRaises(shards.PlanError, msg=repr(text)):
                shards.read_inventory(inv)
        timings = self.tmp / "t.json"
        for text in ('[]', '{"owner a": -1}', '{"owner a": 0}', '{"owner a": "5"}', '{"owner a": true}', '{"owner a": NaN}'):
            timings.write_text(text, encoding="utf-8")
            with self.assertRaises((shards.PlanError, ValueError), msg=text):
                shards.read_timings(timings)

    def test_shipped_timings_are_well_formed(self):
        timings = shards.read_timings(SCHEMATHESIS / "shard-timings.json")
        self.assertTrue(timings)
        for key in timings:
            self.assertRegex(key, r"^(owner|platform) \S+\.ya?ml$")

    def test_real_inventory_plans_for_n_1_3_4_even_with_untimed_files(self):
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML not installed")
        inventory = self.tmp / "inventory.txt"
        lines = []
        for group in shards.GROUPS:
            out = subprocess.run(
                [sys.executable, str(SCHEMATHESIS / "ops.py"), str(SCHEMATHESIS.parent.parent / "packages/contracts/openapi"), group],
                capture_output=True, text=True, check=True,
            ).stdout
            lines += [f"{group} {line}" for line in out.splitlines() if line.strip()]
        inventory.write_text("\n".join(lines) + "\n", encoding="utf-8")
        rows = shards.read_inventory(inventory)
        timings = shards.read_timings(SCHEMATHESIS / "shard-timings.json")
        for n in (1, 3, 4):
            plan_rows, _ = shards.plan(rows, n, timings)
            self.assertEqual(sorted((g, f, i) for _, g, f, i in plan_rows), sorted(rows), f"N={n}")

    def test_compare_prints_one_row_per_shard_count(self):
        out = shards.compare(INVENTORY, TIMINGS, [1, 3, 4], 120)
        rows = [line for line in out if line.startswith("| ") and line[2].isdigit()]
        self.assertEqual([r.split("|")[1].strip() for r in rows], ["1", "3", "4"])


class FanInTests(TempCase):
    N = 4

    def ws(self):
        return make_ws(self.tmp / "ws", INVENTORY, self.N, TIMINGS)

    def problems(self, ws, **kw):
        kw.setdefault("job_result", "success")
        run_info = shards.RunInfo(str(ws), SHA, kw["job_result"])
        problems, lines = shards.check(INVENTORY, self.N, TIMINGS, run_info)
        return problems, "\n".join(lines)

    def assertFails(self, ws, pattern, **kw):
        problems, _ = self.problems(ws, **kw)
        self.assertTrue(any(pattern in p for p in problems), f"{pattern!r} not in {problems}")

    def edit(self, ws, i, name, fn):
        path = self.shard_dir(ws, i) / name
        path.write_text(fn(path.read_text()), encoding="utf-8")

    def test_a_complete_run_passes_and_reports_the_totals(self):
        problems, text = self.problems(self.ws())
        self.assertEqual(problems, [])
        total = sum(len(ids) for *_, ids in INVENTORY)
        self.assertIn("- verdict: PASS", text)
        self.assertIn(f"covered operations: gate {total}, report {total}", text)

    def test_the_job_result_must_be_success(self):
        ws = self.ws()
        for result in ("failure", "cancelled", "skipped", ""):
            self.assertFails(ws, "shard jobs finished", job_result=result)

    def test_absent_shard_artifact_expired_or_not_uploaded(self):
        ws = self.ws()
        shutil.rmtree(self.shard_dir(ws, 2))
        self.assertFails(ws, "schemathesis-shard-2 is missing")

    def test_a_missing_download_directory_fails(self):
        problems, _ = shards.check(INVENTORY, self.N, TIMINGS, shards.RunInfo(str(self.tmp / "nothing"), SHA, "success"))
        self.assertEqual(len([p for p in problems if "is missing" in p]), self.N)

    def test_unexpected_extra_shard_artifact(self):
        ws = self.ws()
        shutil.copytree(self.shard_dir(ws, 0), self.shard_dir(ws, 7))
        self.assertFails(ws, "unexpected artifact schemathesis-shard-7")

    def test_failed_shard_gate_or_report_exit(self):
        for mode in shards.MODES:
            ws = self.tmp / f"ws-{mode}"
            make_ws(ws, INVENTORY, self.N, TIMINGS)
            (self.shard_dir(ws, 1) / f"{mode}.rc").write_text("1\n")
            self.assertFails(ws, f"shard 1 {mode} exit=1")

    def test_missing_or_corrupt_exit_code(self):
        ws = self.ws()
        (self.shard_dir(ws, 0) / "gate.rc").unlink()
        (self.shard_dir(ws, 1) / "report.rc").write_text("ok\n")
        problems, _ = self.problems(ws)
        self.assertTrue(any("shard 0 gate exit=missing" in p for p in problems))
        self.assertTrue(any("shard 1 report exit=ok" in p for p in problems))

    def test_missing_corrupt_and_non_utf8_artifacts(self):
        ws = self.ws()
        (self.shard_dir(ws, 0) / "manifest-gate.txt").unlink()
        (self.shard_dir(ws, 1) / "manifest-report.txt").write_bytes(b"\xff\xfe\x00garbage")
        (self.shard_dir(ws, 2) / "sha.txt").unlink()
        (self.shard_dir(ws, 3) / "plan.txt").write_text("")
        problems, _ = self.problems(ws)
        for needle in ("shard 0: manifest-gate.txt is missing", "shard 1: manifest-report.txt is missing",
                       "shard 2: sha.txt is missing", "shard 3 computed a different plan"):
            self.assertTrue(any(needle in p for p in problems), f"{needle!r} not in {problems}")

    def test_corrupt_manifest_lines_are_problems_not_crashes(self):
        for bad in ("gate owner x.yaml 0 0 five a,b", "gate owner x.yaml 0 2 5 a,b", "gate owner x.yaml 0 0 5",
                    "run owner x.yaml 0 0 5 a", "gate other x.yaml 0 0 5 a", "gate owner x.yaml -1 0 5 a", "gate owner x.yaml 0 0 5 a,,b"):
            ws = self.tmp / f"ws-{abs(hash(bad))}"
            make_ws(ws, INVENTORY, self.N, TIMINGS)
            self.edit(ws, 0, "manifest-gate.txt", lambda t, b=bad: t + b + "\n")
            self.assertFails(ws, "manifest line", job_result="success")

    def test_duplicate_unit_across_shards(self):
        ws = self.ws()
        line = (self.shard_dir(ws, 0) / "manifest-gate.txt").read_text().splitlines()[0]
        self.edit(ws, 1, "manifest-gate.txt", lambda t: t + line + "\n")
        self.assertFails(ws, "ran 2 times")

    def test_missing_unit(self):
        ws = self.ws()
        self.edit(ws, 0, "manifest-report.txt", lambda t: "\n".join(t.splitlines()[1:]) + "\n")
        problems, _ = self.problems(ws)
        self.assertTrue(any("report: " in p and "ran 0 times" in p for p in problems), problems)
        self.assertTrue(any("covered" in p and "operations, the inventory has" in p for p in problems), problems)

    def test_unexpected_unit_not_in_the_inventory(self):
        ws = self.ws()
        self.edit(ws, 2, "manifest-gate.txt", lambda t: t + "gate owner surprise.yaml 0 0 5 sOp\n")
        self.assertFails(ws, "surprise.yaml (owner) ran 1 times (in inventory: False)")

    def test_operation_ids_that_differ_from_the_inventory(self):
        ws = self.ws()
        first = (self.shard_dir(ws, 0) / "manifest-gate.txt").read_text().splitlines()[0]
        self.edit(ws, 0, "manifest-gate.txt", lambda t: t.replace(first, first.rsplit(" ", 1)[0] + " otherOp", 1))
        self.assertFails(ws, "ran operations that differ from the inventory")

    def test_a_shard_from_another_sha_or_another_plan(self):
        ws = self.ws()
        (self.shard_dir(ws, 3) / "sha.txt").write_text("deadbeef" * 5 + "\n")
        self.assertFails(ws, "shard 3 ran SHA deadbeefdead")
        other = self.tmp / "other"
        make_ws(other, INVENTORY[:-1], self.N, TIMINGS)
        self.assertFails(other, "different plan")

    def test_gate_5xx_in_one_file_fails(self):
        ws = self.ws()
        self.edit(ws, 0, "manifest-gate.txt", lambda t: t.replace(" 0 0 7 ", " 1 0 7 ", 1))
        self.assertFails(ws, "unbaselined 5xx")

    def test_run_errors_fail_in_both_modes_including_the_non_gating_report(self):
        for mode in shards.MODES:
            ws = self.tmp / f"ws-err-{mode}"
            make_ws(ws, INVENTORY, self.N, TIMINGS)
            self.edit(ws, 0, f"manifest-{mode}.txt", lambda t: t.replace(" 0 0 7 ", " 1 1 7 ", 1))
            self.assertFails(ws, "could not run")

    def test_report_findings_alone_stay_non_gating(self):
        ws = self.ws()
        self.edit(ws, 0, "manifest-report.txt", lambda t: t.replace(" 0 0 7 ", " 1 0 7 ", 1))
        (self.shard_dir(ws, 0) / "report.md").write_text("### finding")
        problems, text = self.problems(ws)
        self.assertEqual(problems, [])
        self.assertIn("report files with findings (1)", text)
        self.assertIn("### finding", text)

    def test_zero_or_unknown_generated_counts_fail(self):
        for generated in ("0", "-1"):
            ws = self.tmp / f"ws-gen{generated}"
            make_ws(ws, INVENTORY, self.N, TIMINGS)
            self.edit(ws, 0, "manifest-gate.txt", lambda t, g=generated: t.replace(" 0 0 7 ", f" 0 0 {g} ", 1))
            self.assertFails(ws, "generated no test cases")

    def test_a_shard_that_ran_nothing_has_no_coverage(self):
        ws = self.ws()
        (self.shard_dir(ws, 1) / "manifest-gate.txt").write_text("")
        problems, _ = self.problems(ws)
        self.assertTrue(any("shard 1 gate ran" in p for p in problems))

    def test_a_shard_run_for_a_different_n_is_rejected(self):
        three = self.tmp / "three"
        make_ws(three, INVENTORY, 3, TIMINGS)
        problems, _ = shards.check(INVENTORY, 4, TIMINGS, shards.RunInfo(str(three), SHA, "success"))
        self.assertTrue(any("schemathesis-shard-3 is missing" in p for p in problems))
        self.assertTrue(any("different plan" in p for p in problems))


class CliTests(TempCase):
    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = shards.main(list(argv))
        return rc, out.getvalue(), err.getvalue()

    def files(self, rows=INVENTORY):
        inv = self.tmp / "inventory.txt"
        write_inventory(inv, rows)
        timings = self.tmp / "timings.json"
        timings.write_text(json.dumps(TIMINGS), encoding="utf-8")
        return str(inv), str(timings)

    def test_plan_select_check_round_trip(self):
        inv, timings = self.files()
        rc, plan_text, _ = self.run_main("plan", inv, "4", timings)
        self.assertEqual(rc, 0)
        plan_file = self.tmp / "plan.txt"
        plan_file.write_text(plan_text, encoding="utf-8")
        rc, units, _ = self.run_main("select", str(plan_file), "0")
        self.assertEqual(rc, 0)
        self.assertTrue(units.strip())
        ws = make_ws(self.tmp / "ws", INVENTORY, 4, TIMINGS)
        out = self.tmp / "merged.md"
        argv = ["check", "--inventory", inv, "--shards", "4", "--timings", timings, "--ws", str(ws), "--sha", SHA,
                "--out", str(out), "--job-result", "success"]
        rc, stdout, _ = self.run_main(*argv)
        self.assertEqual(rc, 0)
        self.assertIn("verdict: PASS", out.read_text(encoding="utf-8"))
        shutil.rmtree(ws / "schemathesis-shard-1")
        rc, _, err = self.run_main(*argv)
        self.assertEqual(rc, 1)
        self.assertIn("FAN-IN:", err)
        self.assertIn("verdict: FAIL", out.read_text(encoding="utf-8"))

    def test_unreadable_inputs_fail_closed(self):
        inv, timings = self.files()
        missing = str(self.tmp / "nope")
        self.assertEqual(self.run_main("plan", missing, "4", timings)[0], 1)
        self.assertEqual(self.run_main("plan", inv, "0", timings)[0], 1)
        self.assertEqual(self.run_main("plan", inv, "4", missing)[0], 1)
        empty = self.tmp / "empty.txt"
        empty.write_text("", encoding="utf-8")
        ws = self.tmp / "ws"
        ws.mkdir()
        rc, _, err = self.run_main("check", "--inventory", str(empty), "--shards", "4", "--timings", timings,
                                   "--ws", str(ws), "--sha", SHA)
        self.assertEqual(rc, 1)
        self.assertIn("empty inventory", err)


class SafePathTests(TempCase):
    def test_paths_inside_the_temp_area_or_the_checkout_are_accepted(self):
        inside = self.tmp / "a" / "b.txt"
        self.assertEqual(os.path.normcase(shards.safe_path(str(inside))), os.path.normcase(os.path.realpath(inside)))
        self.assertTrue(shards.safe_path("relative/to/cwd.txt").startswith(os.path.normcase(os.path.realpath(os.getcwd()))))

    def test_traversal_out_of_the_allowed_roots_is_rejected(self):
        outside = [
            os.path.abspath(os.sep),
            str(pathlib.Path(tempfile.gettempdir()).parent),
            str(self.tmp / ".." / ".." / ".."),
            tempfile.gettempdir() + "-sibling",  # shares the prefix, is not inside
        ]
        for value in outside:
            with self.assertRaises(argparse.ArgumentTypeError, msg=value):
                shards.safe_path(value)

    def test_the_cli_refuses_a_path_outside_the_allowed_roots(self):
        err = io.StringIO()
        with redirect_stderr(err), self.assertRaises(SystemExit):
            shards.main(["select", os.path.abspath(os.sep), "0"])
        self.assertIn("outside the working directory", err.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
