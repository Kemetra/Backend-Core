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
// The matrix reader below handles only the fields it needs and throws on anything unexpected;
// contracts-compat/lib/yaml-subset.mjs stays the authority (ESM; the verifier is CommonJS).
//
// CLI (release guard):
//   node deploy/release-compat-gate.cjs --source DIR [--now ISO]
// Prints the decision; exit 0 = pass, 1 = refused, 2 = usage error.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const COMPAT_CHECK = "contracts-compat (POS supported snapshots)";
// Same values as contracts-compat/lib/evaluate.mjs (FRESHNESS_DAYS, owner decision O-3, and
// MAX_CLOCK_SKEW_DAYS); the deploy-lab spec checks they stay equal.
const FRESHNESS_DAYS = 7;
const MAX_CLOCK_SKEW_DAYS = 1 / 24;
const MATRIX = path.join("contracts-compat", "pos-supported.yaml");
const REPLAY = path.join("contracts-compat", "replay");
const MAX_FILE_BYTES = 1024 * 1024;
const TOP_KEY = /^([A-Za-z0-9_.-]+):(?:[ ]+(.*))?$/;
const ITEM_KEY = /^([A-Za-z0-9_.-]+):(?:[ ]+(.*))?$/;

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

/** A plain or quoted scalar, without a trailing ` #` comment on a plain one. */
function scalar(raw) {
  const v = (raw ?? "").trim();
  if (/^".*"$/.test(v)) return JSON.parse(v);
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replaceAll("''", "'");
  if (/^["']/.test(v)) throw new Error(`unterminated quoted scalar ${v}`);
  return v.replace(/\s+#.*$/, "");
}

/** Top-level keys -> { value, lines } of the block under each. Duplicates and tabs throw. */
function topBlocks(text) {
  const blocks = new Map();
  let current = null;
  for (const [i, line] of text.replace(/\r\n/g, "\n").split("\n").entries()) {
    if (/\t/.test(line)) throw new Error(`line ${i + 1}: tab character`);
    if (/^\s*(#.*)?$/.test(line)) continue;
    const top = TOP_KEY.exec(line);
    if (top) {
      if (blocks.has(top[1])) throw new Error(`line ${i + 1}: duplicate key '${top[1]}'`);
      current = { value: top[2] ?? "", lines: [] };
      blocks.set(top[1], current);
    } else if (current && line.startsWith(" ")) {
      current.lines.push(line);
    } else {
      throw new Error(`line ${i + 1}: unexpected content`);
    }
  }
  return blocks;
}

function capturedAt(block) {
  if (!block || block.value !== "") throw new Error("fleet_baseline must be a mapping");
  const hits = block.lines.map((l) => /^ {2}captured_at:[ ]+(.+)$/.exec(l)).filter(Boolean);
  if (hits.length !== 1) throw new Error("fleet_baseline.captured_at must appear exactly once");
  const stamp = scalar(hits[0][1]);
  if (Number.isNaN(Date.parse(stamp))) throw new Error(`fleet_baseline.captured_at is not a timestamp (${stamp})`);
  return stamp;
}

/** The snapshot id of every supported entry (contracts-compat/lib/evaluate.mjs snapshotId). */
function supportedIds(block) {
  if (!block) throw new Error("supported is missing");
  if (block.value === "[]" && block.lines.length === 0) return [];
  if (block.value !== "") throw new Error("supported must be a list");
  const items = [];
  for (const line of block.lines) {
    const first = /^ {2}- (.*)$/.exec(line);
    const key = first ? first[1] : (/^ {4}(\S.*)$/.exec(line) ?? [])[1];
    if (first) items.push({});
    else if (!/^ {4}/.test(line) || items.length === 0) throw new Error(`supported: unexpected line '${line.trim()}'`);
    if (key === undefined) continue; // deeper nesting (pos_pin, contract_ref): not needed here
    const kv = ITEM_KEY.exec(key);
    if (!kv) throw new Error(`supported: unexpected line '${line.trim()}'`);
    const item = items.at(-1);
    if (Object.hasOwn(item, kv[1])) throw new Error(`supported: duplicate key '${kv[1]}'`);
    item[kv[1]] = scalar(kv[2]);
  }
  if (items.length === 0) throw new Error("supported must be a list");
  return items.map((e) => {
    if (e.kind === "build" && /^[0-9a-f]{12,40}$/.test(e.build_id ?? "")) return `pos-build-${e.build_id.slice(0, 12)}`;
    if (e.kind === "release" && /^[A-Za-z0-9._-]+$/.test(e.pos_version ?? "")) return `pos-release-${e.pos_version}`;
    throw new Error(`supported entry with kind '${e.kind}' has no usable build_id/pos_version`);
  });
}

/** Provenance of each fixture index under replay/<id>/ (none = []); null if unreadable. */
function fixtureProvenance(sourceDir, id) {
  const dir = path.join(sourceDir, REPLAY, id);
  if (!fs.existsSync(dir)) return [];
  if (!isRealDir(dir)) return null;
  const out = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    const text = readRegular(path.join(dir, name));
    if (text === null) return null;
    const hits = text.replace(/\r\n/g, "\n").split("\n").map((l) => /^provenance:[ ]+(.+)$/.exec(l)).filter(Boolean);
    if (hits.length !== 1) return null;
    out.push(scalar(hits[0][1]));
  }
  return out;
}

function freshnessProblem(stamp, now) {
  const ageDays = (now.getTime() - Date.parse(stamp)) / 86_400_000;
  if (ageDays < -MAX_CLOCK_SKEW_DAYS) return `fleet_baseline.captured_at is in the future (${stamp})`;
  if (ageDays <= FRESHNESS_DAYS) return null;
  return `FAIL_STALE_FLEET: fleet_baseline.captured_at is ${ageDays.toFixed(1)} days old (limit ${FRESHNESS_DAYS}); refresh the fleet baseline on RT-713 before releasing`;
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
  let stamp;
  let ids;
  try {
    const blocks = topBlocks(text);
    stamp = capturedAt(blocks.get("fleet_baseline"));
    ids = supportedIds(blocks.get("supported"));
  } catch (err) {
    return refuse(`cannot read ${MATRIX}: ${err.message}`);
  }
  const problems = [];
  const stale = freshnessProblem(stamp, now);
  if (stale) problems.push(`POS compat gate: ${stale}`);
  const unrecorded = [];
  for (const id of ids) {
    const provenance = fixtureProvenance(sourceDir, id);
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

module.exports = { COMPAT_CHECK, FRESHNESS_DAYS, MAX_CLOCK_SKEW_DAYS, evaluateCompat, main };
