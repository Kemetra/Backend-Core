#!/usr/bin/env node
// RT-594 PoC fan-in gate for the split apps/api Jest run. Fails unless:
//   1. every one of <nodes> shards left jest.json + coverage-final.json + all-tests.txt;
//   2. every shard saw the same `jest --listTests` inventory;
//   3. the executed spec files equal that inventory, each exactly once;
//   4. every shard's Jest run succeeded;
//   5. the MERGED coverage meets coverageThreshold.global from jest.config.cjs
//      (all keys, read from the file — the floor is never copied or lowered);
//   6. (if given) merged covered/total counts equal the unsplit control's.
//
// usage: coverage-gate.cjs <apiDir> <splitDir> <nodes> [controlCoverageFinal.json]
// No new dependency: istanbul-lib-coverage is resolved through jest's own tree.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const [, , apiArg, splitDir, nodesArg, controlPath] = process.argv;
const apiDir = path.resolve(apiArg || "");
const nodes = Number(nodesArg);
if (!apiArg || !splitDir || !Number.isInteger(nodes) || nodes < 1) {
  console.error("usage: coverage-gate.cjs <apiDir> <splitDir> <nodes> [controlCoverageFinal.json]");
  process.exit(2);
}

const errors = [];
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const readLines = (p) => fs.readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
const rel = (p) => path.relative(apiDir, p).split(path.sep).join("/");

function loadIstanbul() {
  const viaJest = createRequire(require.resolve("jest/package.json", { paths: [apiDir] }));
  const viaCore = createRequire(viaJest.resolve("@jest/core/package.json"));
  const viaReporters = createRequire(viaCore.resolve("@jest/reporters/package.json"));
  return viaReporters("istanbul-lib-coverage");
}

function loadShards() {
  const shards = [];
  for (let i = 0; i < nodes; i++) {
    const dir = path.join(splitDir, `node-${i}`);
    const files = ["jest.json", "coverage-final.json", "all-tests.txt"].map((f) => path.join(dir, f));
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length) {
      errors.push(`shard ${i}: missing ${missing.map((f) => path.basename(f)).join(", ")}`);
      continue;
    }
    shards.push({ index: i, jest: readJson(files[0]), coverage: readJson(files[1]), inventory: readLines(files[2]) });
  }
  return shards;
}

function checkInventory(shards) {
  const expected = shards[0].inventory;
  for (const s of shards.slice(1)) {
    if (s.inventory.join("\n") !== expected.join("\n")) errors.push(`shard ${s.index}: listTests inventory differs from shard 0`);
  }
  const seen = new Map();
  for (const s of shards) {
    if (!s.jest.success) errors.push(`shard ${s.index}: jest reported failure`);
    for (const r of s.jest.testResults) {
      const f = rel(r.name);
      seen.set(f, (seen.get(f) || 0) + 1);
    }
  }
  const missing = expected.filter((f) => !seen.has(f));
  const dupes = [...seen].filter(([, n]) => n > 1).map(([f]) => f);
  const extra = [...seen.keys()].filter((f) => !expected.includes(f));
  if (missing.length) errors.push(`${missing.length} spec file(s) never ran, e.g. ${missing.slice(0, 5).join(", ")}`);
  if (dupes.length) errors.push(`${dupes.length} spec file(s) ran in more than one shard, e.g. ${dupes.slice(0, 5).join(", ")}`);
  if (extra.length) errors.push(`${extra.length} executed file(s) not in listTests, e.g. ${extra.slice(0, 5).join(", ")}`);
  const tests = shards.reduce((n, s) => n + s.jest.numTotalTests, 0);
  console.log(`inventory: ${expected.length} spec files expected, ${seen.size} executed, ${tests} tests across ${shards.length} shard(s)`);
}

// Mirrors Jest's global threshold semantics: positive = minimum %, negative =
// maximum number of uncovered entities.
function checkThresholds(summary, thresholds) {
  for (const [key, floor] of Object.entries(thresholds)) {
    const m = summary[key];
    if (!m) {
      errors.push(`threshold key "${key}" has no coverage metric`);
      continue;
    }
    const ok = floor >= 0 ? m.pct >= floor : m.total - m.covered <= -floor;
    console.log(`  ${key.padEnd(10)} ${m.pct}% (${m.covered}/${m.total}) floor ${floor} ${ok ? "OK" : "FAIL"}`);
    if (!ok) errors.push(`merged ${key} ${m.pct}% does not meet floor ${floor}`);
  }
}

function checkControlParity(istanbul, summary, merged) {
  if (!controlPath) return;
  if (!fs.existsSync(controlPath)) {
    errors.push(`control coverage missing: ${controlPath}`);
    return;
  }
  const controlMap = istanbul.createCoverageMap(readJson(controlPath));
  const control = controlMap.getCoverageSummary();
  let differs = false;
  for (const key of ["statements", "branches", "functions", "lines"]) {
    const a = summary[key];
    const b = control[key];
    const same = a.covered === b.covered && a.total === b.total;
    console.log(`  parity ${key.padEnd(10)} split ${a.covered}/${a.total} control ${b.covered}/${b.total} ${same ? "EQUAL" : "DIFF"}`);
    if (!same) {
      differs = true;
      errors.push(`merged ${key} differs from the unsplit control`);
    }
  }
  if (differs) printPerFileDiff(merged, controlMap);
}

// On a parity DIFF, show which source files cover differently, so one run's log
// separates "nondeterministic branch in X" from "the merge is wrong".
function printPerFileDiff(splitMap, controlMap) {
  const files = new Set([...splitMap.files(), ...controlMap.files()]);
  const rows = [];
  for (const f of files) {
    const a = splitMap.files().includes(f) ? splitMap.fileCoverageFor(f).toSummary() : null;
    const b = controlMap.files().includes(f) ? controlMap.fileCoverageFor(f).toSummary() : null;
    const cell = (s, k) => (s ? `${s[k].covered}/${s[k].total}` : "absent");
    const keys = ["statements", "branches", "functions", "lines"];
    if (!a || !b || keys.some((k) => cell(a, k) !== cell(b, k))) {
      rows.push(`  ${rel(f)}: ${keys.map((k) => `${k[0]} ${cell(a, k)} vs ${cell(b, k)}`).join(", ")}`);
    }
  }
  console.log(`per-file parity diff (split vs control), ${rows.length} file(s):\n${rows.slice(0, 50).join("\n")}`);
}

const config = require(path.join(apiDir, "jest.config.cjs"));
const thresholds = config.coverageThreshold && config.coverageThreshold.global;
if (!thresholds || !Object.keys(thresholds).length) errors.push("jest.config.cjs has no coverageThreshold.global");

const shards = loadShards();
if (shards.length === nodes && thresholds) {
  checkInventory(shards);
  const istanbul = loadIstanbul();
  const merged = istanbul.createCoverageMap({});
  for (const s of shards) merged.merge(s.coverage);
  const summary = merged.getCoverageSummary();
  console.log("merged coverage vs jest.config.cjs coverageThreshold.global:");
  checkThresholds(summary, thresholds);
  checkControlParity(istanbul, summary, merged);
  const outDir = path.join(splitDir, "..", "merged");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "coverage-final.json"), JSON.stringify(merged.toJSON()));
}

if (errors.length) {
  console.error(`\nGATE FAILED (${errors.length}):\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log("\nGATE PASSED");
