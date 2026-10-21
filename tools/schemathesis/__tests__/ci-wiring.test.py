"""RT-809: static checks of the ci.yml wiring around the sharded Schemathesis job.

Usage: python3 tools/schemathesis/__tests__/ci-wiring.test.py
Needs PyYAML. Not run in CI (it would add a dependency to the `ci` jobs).

The "nothing else changed" cases compare with the workflows as they were before RT-809
and run only when RT809_BASE_SHA names that commit (c9dcb93f is the RT-809 baseline):
  RT809_BASE_SHA=c9dcb93f python3 tools/schemathesis/__tests__/ci-wiring.test.py
They are one-time evidence for the RT-809 change, so any later legitimate edit to another
job does not turn them red; without the variable they are skipped, with a message.
"""
import json
import os
import pathlib
import subprocess
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[3]
BASE_SHA = os.environ.get("RT809_BASE_SHA", "")
REQUIRED_NAME = "schemathesis (cookieAuth surface)"
# The pre-RT-809 `if:` of the required job, character for character.
ORIGINAL_IF = "${{ !cancelled() && github.event_name == 'pull_request' && needs.changes.outputs.run_schemathesis != 'false' }}"
PIN_UPLOAD = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"
PIN_DOWNLOAD = "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"


def load(text):
    return yaml.safe_load(text)


def base_workflow(path):
    if not BASE_SHA:
        return None
    try:
        text = subprocess.run(
            ["git", "show", f"{BASE_SHA}:{path}"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return load(text)


class CiWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        cls.ci = load(cls.text)
        cls.jobs = cls.ci["jobs"]
        cls.shard = cls.jobs["schemathesis-shard"]
        cls.fanin = cls.jobs["schemathesis"]
        cls.base = base_workflow(".github/workflows/ci.yml")

    def test_required_check_keeps_its_id_name_and_condition(self):
        self.assertEqual(self.fanin["name"], REQUIRED_NAME)
        self.assertEqual(self.fanin["if"], ORIGINAL_IF)

    def test_exactly_one_job_carries_the_required_name(self):
        names = [job.get("name") for job in self.jobs.values()]
        self.assertEqual(names.count(REQUIRED_NAME), 1)

    def test_shard_jobs_never_reuse_a_required_context(self):
        name = self.shard["name"]
        self.assertNotIn(name, {REQUIRED_NAME, "ci", "fast (build + Docker-free tests)", "oasdiff (breaking changes vs merge-base)"})
        self.assertIn("${{ matrix.shard }}", name)

    def test_shards_use_the_same_condition_and_run_after_changes(self):
        self.assertEqual(self.shard["if"], ORIGINAL_IF)
        self.assertEqual(self.shard["needs"], "changes")
        self.assertEqual(sorted(self.fanin["needs"]), ["changes", "schemathesis-shard"])

    def test_matrix_covers_every_shard_and_matches_shard_total_in_both_jobs(self):
        total = int(self.shard["env"]["SHARD_TOTAL"])
        self.assertEqual(int(self.fanin["env"]["SHARD_TOTAL"]), total)
        self.assertEqual(self.shard["strategy"]["matrix"]["shard"], list(range(total)))
        self.assertEqual(total, 4)

    def test_fail_fast_is_off_and_runners_are_distinct_github_hosted_jobs(self):
        self.assertIs(self.shard["strategy"]["fail-fast"], False)
        self.assertEqual(self.shard["runs-on"], "ubuntu-latest")
        self.assertEqual(self.shard["env"]["SHARD_INDEX"], "${{ matrix.shard }}")
        self.assertLessEqual(self.shard["timeout-minutes"], 30)

    def test_ci_aggregate_is_unchanged_and_still_needs_the_fan_in(self):
        self.assertIn("schemathesis", self.jobs["ci"]["needs"])
        if self.base is None:
            self.skipTest("set RT809_BASE_SHA=<commit before RT-809> to compare with the old workflow")
        self.assertEqual(self.jobs["ci"], self.base["jobs"]["ci"])

    def test_no_other_job_changed(self):
        if self.base is None:
            self.skipTest("set RT809_BASE_SHA=<commit before RT-809> to compare with the old workflow")
        for name in ("changes", "fast", "db-integration", "oasdiff", "ci"):
            self.assertEqual(self.jobs[name], self.base["jobs"][name], name)
        for key in ("name", "on", "concurrency", "permissions"):
            self.assertEqual(self.ci[key], self.base[key], key)
        self.assertEqual(set(self.jobs), set(self.base["jobs"]) | {"schemathesis-shard"})

    def test_trust_boundaries_are_not_widened(self):
        self.assertEqual(self.ci["permissions"], {"contents": "read"})
        self.assertNotIn("pull_request_target", self.ci["on"])
        for job in (self.shard, self.fanin):
            self.assertNotIn("secrets.", json.dumps(job))
            self.assertNotIn("permissions", job)
            for step in job["steps"]:
                if "uses" in step and not step["uses"].startswith("actions/checkout@"):
                    self.assertIn(step["uses"].split(" ")[0], {PIN_UPLOAD, PIN_DOWNLOAD})
                # no untrusted event data interpolated into a shell script
                self.assertNotIn("github.head_ref", step.get("run", ""))
                self.assertNotIn("${{", step.get("run", ""))

    def test_the_fan_in_cannot_be_waved_through(self):
        steps = {s["name"]: s for s in self.fanin["steps"]}
        lenient = [n for n, s in steps.items() if s.get("continue-on-error")]
        self.assertEqual(lenient, ["Download shard evidence"])
        fan = steps["Fan-in (coverage + gate)"]
        self.assertEqual(fan["env"]["SHARDS_RESULT"], "${{ needs.schemathesis-shard.result }}")
        self.assertEqual(fan["run"], "bash tools/schemathesis/shard.sh fanin")
        self.assertNotIn("if", fan)
        self.assertEqual(steps["Self-test the shard planner and fan-in"]["run"], "python3 tools/schemathesis/__tests__/shards.test.py")

    def test_shard_steps_run_gate_then_report_with_original_semantics(self):
        steps = {s["name"]: s for s in self.shard["steps"]}
        gate, report = steps['Gate: no 5xx (not_a_server_error)'], steps["Report (non-gating findings): positive_data_acceptance"]
        self.assertEqual(gate["run"], "bash tools/schemathesis/shard.sh run gate")
        self.assertEqual(report["run"], "bash tools/schemathesis/shard.sh run report")
        self.assertNotIn("if", gate)
        self.assertEqual(report["if"], "always()")
        self.assertEqual(steps["Start ephemeral stack"]["run"], "bash tools/schemathesis/stack-up.sh")
        order = [s["name"] for s in self.shard["steps"]]
        self.assertLess(order.index("Collect shard evidence"), order.index("Tear down"))
        for name in ("Collect shard evidence", "Upload shard evidence", "Tear down"):
            self.assertEqual(steps[name]["if"], "always()")
        env_text = json.dumps(self.shard["env"])
        for knob in ("SEED", "MAX_EXAMPLES", "BASELINE_UPDATE", "SHARD_UNITS"):
            self.assertNotIn(knob, env_text)

    def test_only_the_structured_evidence_is_uploaded(self):
        upload = next(s for s in self.shard["steps"] if s["name"] == "Upload shard evidence")["with"]
        self.assertTrue(upload["path"].endswith("/st-shard/artifact"))
        self.assertEqual(upload["if-no-files-found"], "error")
        self.assertEqual(upload["name"], "schemathesis-shard-${{ matrix.shard }}")
        self.assertNotIn("api-fuzz", json.dumps(upload))

    def test_nightly_workflow_is_untouched(self):
        base = base_workflow(".github/workflows/api-fuzz.yml")
        if base is None:
            self.skipTest("set RT809_BASE_SHA=<commit before RT-809> to compare with the old workflow")
        now = load((ROOT / ".github/workflows/api-fuzz.yml").read_text(encoding="utf-8"))
        self.assertEqual(now, base)


if __name__ == "__main__":
    unittest.main(verbosity=2)
