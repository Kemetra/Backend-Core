#!/usr/bin/env node
// RT-594 PoC: convert `jest --json` output into JUnit XML with `file` and `time`
// attributes for CircleCI store_test_results and timing-based splitting.
// Avoids adding jest-junit (a gated package.json + lockfile change).
//
// usage: jest-json-to-junit.cjs <jest.json> <out.xml> <apiRootDir>
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const [, , jsonPath, outPath, rootDir] = process.argv;
if (!jsonPath || !outPath || !rootDir) {
  console.error("usage: jest-json-to-junit.cjs <jest.json> <out.xml> <apiRootDir>");
  process.exit(2);
}
if (!fs.existsSync(jsonPath)) {
  console.error(`missing ${jsonPath}: jest produced no JSON report`);
  process.exit(1);
}

const ENTITIES = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" };
// Drop characters XML 1.0 forbids (ANSI colour codes in failure messages).
const esc = (s) =>
  String(s)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[<>&"']/g, (c) => ENTITIES[c]);
const rel = (p) => path.relative(rootDir, p).split(path.sep).join("/");

function testcase(file, name, secs, body) {
  const attrs = `classname="${esc(file)}" name="${esc(name)}" file="${esc(file)}" time="${secs.toFixed(3)}"`;
  return `    <testcase ${attrs}>${body}</testcase>`;
}

function suiteXml(suite) {
  const file = rel(suite.name);
  const wallSecs = Math.max(0, (suite.endTime - suite.startTime) / 1000);
  const tests = suite.assertionResults;
  const testSecs = tests.reduce((sum, t) => sum + (t.duration || 0) / 1000, 0);
  // Container start-up and beforeAll time is not in per-test durations. Spread
  // it evenly so the per-file total equals the suite wall time, which is what
  // filename-based splitting balances on.
  const overhead = tests.length ? Math.max(0, wallSecs - testSecs) / tests.length : 0;

  const cases = tests.map((t) => {
    const secs = (t.duration || 0) / 1000 + overhead;
    if (t.status === "failed") {
      const msg = (t.failureMessages || []).join("\n");
      return testcase(file, t.fullName, secs, `<failure message="${esc(msg.split("\n")[0])}">${esc(msg)}</failure>`);
    }
    return testcase(file, t.fullName, secs, t.status === "passed" ? "" : "<skipped/>");
  });
  // A suite that failed to load has no assertions; never drop it silently.
  if (suite.status === "failed" && cases.length === 0) {
    cases.push(testcase(file, "suite failed to run", wallSecs, `<failure message="suite failed to run">${esc(suite.message || "")}</failure>`));
  }

  const failures = cases.filter((c) => c.includes("<failure")).length;
  const skipped = cases.filter((c) => c.includes("<skipped/>")).length;
  const head = `  <testsuite name="${esc(file)}" file="${esc(file)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${wallSecs.toFixed(3)}">`;
  return [head, ...cases, "  </testsuite>"].join("\n");
}

const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const xml = ['<?xml version="1.0" encoding="UTF-8"?>', "<testsuites>", ...report.testResults.map(suiteXml), "</testsuites>", ""].join("\n");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, xml);
console.log(`junit: ${report.testResults.length} files, ${report.numTotalTests} tests -> ${outPath}`);
