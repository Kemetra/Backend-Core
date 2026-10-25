#!/usr/bin/env node
// RT-863: the POS compatibility gate for image release (.github/workflows/release-images.yml)
// and lab deploy (deploy/lab/verify-release.cjs). Owner decision MR-3 (RT-863 comment 13811),
// option (b) with automatic tightening:
//
//   - The release SHA's own `contracts-compat (POS supported snapshots)` check run (ci.yml,
//     `check.mjs --mode pr`) must be green. The callers require it with their other checks.
//   - The fleet baseline in the release commit's pos-supported.yaml must be fresh NOW, at
//     release or deploy time (FAIL_STALE_FLEET is only a warning in PR mode).
//   - Until every supported snapshot has a `recorded` replay fixture, envelope/replay is
//     NOT_PROVEN for release mode: recorded in the evidence, never blocking.
//   - Once every supported snapshot has one, the gate is `--mode release` with no code change:
//     a green PR-mode run (matrix valid, oasdiff, envelope and replay all pass) + a fresh
//     fleet + a recorded fixture per snapshot is exactly what `check.mjs --mode release`
//     passes on (verdictOf in contracts-compat/check.mjs). A recorded fixture that is wrong
//     already turns the PR-mode run red.
//
// Reads only the release commit's own files (a checkout or `git archive <sha>`), never runs
// them, makes no network call and fails closed: anything it cannot read or parse is a refusal.
// Parsing is never re-implemented here: the matrix and fixture texts are parsed by
// contracts-compat's own parseYamlSubset + validateStructure + snapshotId + PROVENANCE (ESM), run in a child
// node process from the gate's OWN checkout (main), never from the release evidence.
//
// CLI (release guard):
//   node deploy/release-compat-gate.cjs --source DIR [--now ISO]
// Prints the decision; exit 0 = pass, 1 = refused, 2 = usage error.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const COMPAT_CHECK = "contracts-compat (POS supported snapshots)";
// contracts-compat/lib/evaluate.mjs keeps this private; the deploy-lab spec checks it stays equal.
// FRESHNESS_DAYS (owner decision O-3) is read from evaluate.mjs itself.
const MAX_CLOCK_SKEW_DAYS = 1 / 24;
const MATRIX = path.join("contracts-compat", "pos-supported.yaml");
const REPLAY = path.join("contracts-compat", "replay");
const COMPAT_LIB = path.join(__dirname, "..", "contracts-compat", "lib");
const MAX_FILE_BYTES = 1024 * 1024;

/** A regular file under the size cap, never through a symlink; null otherwise. */
function readRegular(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= MAX_FILE_BYTES ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

function isRealDir(dir) {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** replay/<dir>/*.yaml texts by directory name; a dir maps to null when anything in it is unreadable. */
function readFixtures(sourceDir) {
  const root = path.join(sourceDir, REPLAY);
  const out = {};
  if (!fs.existsSync(root)) return out;
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    if (!isRealDir(dir)) {
      out[id] = null;
      continue;
    }
    const texts = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort().map((f) => readRegular(path.join(dir, f)));
    out[id] = texts.includes(null) ? null : texts;
  }
  return out;
}

// Runs in a child node process (ESM). Input on stdin: { matrix, fixtures }; output on stdout.
const PARSE_SCRIPT = `
import { readFileSync } from "node:fs";
const [ev, ys, rp] = await Promise.all([import(process.env.COMPAT_EVALUATE), import(process.env.COMPAT_YAML), import(process.env.COMPAT_REPLAY)]);
const input = JSON.parse(readFileSync(0, "utf8"));
const out = { freshnessDays: ev.FRESHNESS_DAYS, provenance: {} };
try {
  const m = ys.parseYamlSubset(input.matrix);
  const problems = ev.validateStructure(m);
  if (problems.length > 0) out.error = "invalid matrix: " + problems.join("; ");
  else Object.assign(out, { capturedAt: m.fleet_baseline.captured_at, ids: m.supported.map(ev.snapshotId) });
} catch (e) {
  out.error = e.message;
}
for (const [id, texts] of Object.entries(input.fixtures)) {
  try {
    const values = texts === null ? null : texts.map((t) => ys.parseYamlSubset(t).provenance);
    // a provenance contracts-compat does not know is unreadable, never "not recorded"
    out.provenance[id] = values && values.every((p) => rp.PROVENANCE.includes(p)) ? values : null;
  } catch {
    out.provenance[id] = null;
  }
}
process.stdout.write(JSON.stringify(out));
`;

/** Parse with contracts-compat's own code. Throws when it cannot run or answer. */
function parseWithCompatLib(matrix, fixtures) {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", PARSE_SCRIPT], {
    input: JSON.stringify({ matrix, fixtures }),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      COMPAT_EVALUATE: pathToFileURL(path.join(COMPAT_LIB, "evaluate.mjs")).href,
      COMPAT_YAML: pathToFileURL(path.join(COMPAT_LIB, "yaml-subset.mjs")).href,
      COMPAT_REPLAY: pathToFileURL(path.join(COMPAT_LIB, "replay.mjs")).href,
    },
  });
  if (res.status !== 0) throw new Error(`contracts-compat parser did not run (${(res.stderr || String(res.error ?? "")).trim().split("\n")[0]})`);
  const out = JSON.parse(res.stdout);
  if (!Number.isFinite(out.freshnessDays)) throw new Error("contracts-compat parser returned no FRESHNESS_DAYS");
  return out;
}

function freshnessProblem(stamp, now, freshnessDays) {
  const ageDays = (now.getTime() - Date.parse(stamp)) / 86_400_000;
  if (ageDays < -MAX_CLOCK_SKEW_DAYS) return `fleet_baseline.captured_at is in the future (${stamp})`;
  if (ageDays <= freshnessDays) return null;
  return `FAIL_STALE_FLEET: fleet_baseline.captured_at is ${ageDays.toFixed(1)} days old (limit ${freshnessDays}); refresh the fleet baseline on RT-713 before releasing`;
}

/**
 * Judge the compat gate on the release commit's files. The check run itself is judged by the
 * caller with its other required checks.
 * @returns { mode: 'release'|'pr+fleet'|null, problems: string[], notes: string[] }
 */
function evaluateCompat(sourceDir, now = new Date()) {
  const refuse = (why) => ({ mode: null, problems: [`POS compat gate (${COMPAT_CHECK}): ${why}`], notes: [] });
  for (const dir of ["contracts-compat", REPLAY]) {
    if (fs.existsSync(path.join(sourceDir, dir)) && !isRealDir(path.join(sourceDir, dir))) {
      return refuse(`${dir} in the release commit is not a real directory`);
    }
  }
  const text = readRegular(path.join(sourceDir, MATRIX));
  if (text === null) return refuse(`${MATRIX} is missing or unreadable in the release commit`);
  let parsed;
  try {
    parsed = parseWithCompatLib(text, readFixtures(sourceDir));
  } catch (err) {
    return refuse(err.message);
  }
  if (parsed.error) return refuse(`cannot read ${MATRIX}: ${parsed.error}`);
  const { capturedAt: stamp, ids } = parsed;
  const problems = [];
  const stale = freshnessProblem(stamp, now, parsed.freshnessDays);
  if (stale) problems.push(`POS compat gate: ${stale}`);
  const unrecorded = [];
  for (const id of ids) {
    const provenance = Object.hasOwn(parsed.provenance, id) ? parsed.provenance[id] : [];
    if (provenance === null) return refuse(`replay fixtures for ${id} are unreadable`);
    if (!provenance.includes("recorded")) unrecorded.push(id);
  }
  // Release mode only once every supported snapshot (at least one) has a recorded fixture.
  const mode = ids.length > 0 && unrecorded.length === 0 ? "release" : "pr+fleet";
  const notes = [];
  if (mode === "release") {
    notes.push(`POS compat: --mode release semantics (a recorded replay fixture for each of ${ids.length} supported snapshot(s))`);
  } else {
    const which = ids.length === 0 ? "no supported snapshot" : `no recorded replay fixture for ${unrecorded.join(", ")}`;
    notes.push(
      `POS compat: PR-mode result + fresh fleet (RT-863 option b); release-mode envelope/replay NOT_PROVEN (${which}); not blocking until every supported snapshot has a recorded fixture`,
    );
  }
  notes.push(`POS compat: fleet baseline captured ${stamp}`);
  return { mode, problems, notes };
}

function main(argv) {
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const source = get("--source");
  const now = get("--now") ? new Date(get("--now")) : new Date();
  if (!source || Number.isNaN(now.getTime()) || argv.length % 2 !== 0) {
    console.error("usage: release-compat-gate.cjs --source DIR [--now ISO]");
    return 2;
  }
  const result = evaluateCompat(source, now);
  result.notes.forEach((n) => console.log(n));
  result.problems.forEach((p) => console.log(`::error::${p}`));
  console.log(`POS compat gate: ${result.problems.length ? "REFUSED" : "PASS"} (mode ${result.mode ?? "unknown"})`);
  return result.problems.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { COMPAT_CHECK, MAX_CLOCK_SKEW_DAYS, evaluateCompat, main };
