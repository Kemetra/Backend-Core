// RT-713: specs for the schema validator, the replay fixtures and the idempotency rules.
// Imported by compat.spec.mjs so the single CI path runs them. Tests that need the oasdiff
// binary (it parses the contracts) skip locally when it is absent, but fail when
// CONTRACTS_COMPAT_REQUIRE_OASDIFF=1 (CI).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { summarizeProof } from "../check.mjs";
import { mutate, MUTATIONS } from "../lib/mutations.mjs";
import { proveSnapshot } from "../lib/proof.mjs";
import { fixtureFiles, loadFixture } from "../lib/replay.mjs";
import { validate } from "../lib/schema.mjs";
import { deref, loadDocs } from "../lib/spec.mjs";

const COMPAT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oasdiffBin = process.env.OASDIFF ?? "oasdiff";
const haveOasdiff = !spawnSync(oasdiffBin, ["--version"]).error;
const needsOasdiff = {
  skip: !haveOasdiff && process.env.CONTRACTS_COMPAT_REQUIRE_OASDIFF !== "1" && "oasdiff not installed",
};

const SYNTH = path.join(COMPAT, "synthetic/idem");
const SYNTH_FIXTURE = path.join(COMPAT, "synthetic/replay/idem.yaml");
const prove = (docs, candidate, files = [SYNTH_FIXTURE]) =>
  proveSnapshot({ snapshotDocs: docs, candidateDocs: candidate, fixtureFiles: files, snapshotId: "synthetic" });

// ---- validator (pure) ---------------------------------------------------------------------------

const DOC = { components: { schemas: { Name: { type: "string", minLength: 2 } } } };

test("validator: types, required, additionalProperties, enum, pattern, refs", () => {
  const schema = {
    type: "object",
    required: ["a"],
    additionalProperties: false,
    properties: {
      a: { $ref: "#/components/schemas/Name" },
      b: { type: "string", enum: ["x", "y"] },
      c: { type: "string", pattern: "^[0-9]+$" },
    },
  };
  assert.deepEqual(validate({ a: "ok", b: "x", c: "12" }, schema, DOC), []);
  assert.match(validate({}, schema, DOC)[0], /missing required property 'a'/);
  assert.match(validate({ a: "ok", z: 1 }, schema, DOC)[0], /unknown property 'z'/);
  assert.match(validate({ a: "ok", b: "q" }, schema, DOC)[0], /not in enum/);
  assert.match(validate({ a: "ok", c: "x" }, schema, DOC)[0], /does not match/);
  assert.match(validate({ a: "o" }, schema, DOC)[0], /shorter than 2/);
  assert.match(validate("str", { type: "object" }, DOC)[0], /expected object/);
});

test("validator: an unimplemented keyword is an error, never a silent pass", () => {
  assert.match(validate("x", { type: "string", uniqueItems: true }, DOC)[0], /unsupported schema keyword 'uniqueItems'/);
  assert.match(validate("x", { not: { type: "string" } }, DOC)[0], /unsupported schema keyword 'not'/);
});

test("validator: a nullable null still reports an unimplemented keyword", () => {
  const schema = { type: "integer", nullable: true, multipleOf: 2 };
  assert.match(validate(null, schema, DOC)[0], /unsupported schema keyword 'multipleOf'/);
  assert.match(validate(4, schema, DOC)[0], /unsupported schema keyword 'multipleOf'/);
});

test("proof layers fail independently", () => {
  const base = { operations: 3, events: 5, recorded: 0, derived: 5, envelopeProblems: [], replayProblems: [], unproven: 0, unrecorded: 1 };
  const replayOnly = summarizeProof({ ...base, replayProblems: ["x"] });
  assert.equal(replayOnly.envelope.ok, true);
  assert.equal(replayOnly.replay.ok, false);
  assert.equal(replayOnly.proven, false);
  const envOnly = summarizeProof({ ...base, envelopeProblems: ["y"] });
  assert.equal(envOnly.envelope.ok, false);
  assert.equal(envOnly.replay.ok, true);
  assert.equal(summarizeProof(base).proven, true);
});

test("validator: documentation keywords and nullable are accepted", () => {
  assert.deepEqual(validate(null, { type: "string", nullable: true, description: "d", example: "e" }, DOC), []);
  assert.throws(() => validate("x", { $ref: "other.yaml#/X" }, DOC), /unsupported \$ref/);
});

// ---- replay fixtures and idempotency rules -------------------------------------------------------

test("the synthetic fixture replays clean against the synthetic snapshot", needsOasdiff, () => {
  const docs = loadDocs(SYNTH);
  const r = prove(docs, docs);
  assert.deepEqual([...r.semantics.problems, ...r.replay.problems], []);
  assert.equal(r.replay.events, 4);
  assert.deepEqual(r.replay.counts, { recorded: 0, "contract-derived": 0, synthetic: 4 });
});

test("each idempotency/replay rule fails on its deliberate regression", needsOasdiff, () => {
  const docs = loadDocs(SYNTH);
  const expected = {
    drop_x_idempotency: /x-idempotency is no longer/,
    optional_key_header: /Idempotency-Key header is no longer a required/,
    drop_409: /response 409 is no longer declared/,
    stricter_body: /missing required property 'newRequiredField'/,
  };
  for (const [name, re] of Object.entries(expected)) {
    const r = prove(docs, mutate(docs, name));
    assert.match([...r.semantics.problems, ...r.replay.problems].join(" | "), re, name);
  }
  assert.deepEqual(Object.keys(MUTATIONS).sort(), ["none", ...Object.keys(expected)].sort());
});

test("a fixture that names another snapshot, or an unknown mutation, is rejected", needsOasdiff, () => {
  const docs = loadDocs(SYNTH);
  const wrong = proveSnapshot({ snapshotDocs: docs, candidateDocs: docs, fixtureFiles: [SYNTH_FIXTURE], snapshotId: "pos-build-x" });
  assert.match(wrong.replay.problems[0], /names snapshot 'synthetic', expected 'pos-build-x'/);
  assert.throws(() => mutate(docs, "nope"), /unknown mutation/);
});

test("bad fixtures: unknown operation, undeclared status, bad key, bad body, broken duplicate", needsOasdiff, () => {
  const docs = loadDocs(SYNTH);
  const work = mkdtempSync(path.join(tmpdir(), "replay-spec-"));
  try {
    writeFileSync(path.join(work, "good.json"), JSON.stringify({ externalId: "o", total: "1.00" }));
    writeFileSync(path.join(work, "bad.json"), JSON.stringify({ externalId: "o", total: "one" }));
    const idx = path.join(work, "idx.yaml");
    const head = ["schema: retail-tower/pos-replay@1", "snapshot: synthetic", "provenance: synthetic", "events:"];
    const ev = ({ seq, op, key, body, status, extra = [] }) => [
      `  - seq: ${seq}`, `    operation: ${op}`, `    idempotency_key: ${key}`, `    body_ref: ${body}`, `    expect_status: ${status}`, ...extra,
    ];
    const events = [
      ...ev({ seq: 1, op: "GET /nope", key: "synthetic-key-000000001", body: "good.json", status: "200" }),
      ...ev({ seq: 2, op: "POST /probe/orders", key: "synthetic-key-000000001", body: "good.json", status: "418" }),
      ...ev({ seq: 3, op: "POST /probe/orders", key: "short", body: "good.json", status: "201" }),
      ...ev({ seq: 4, op: "POST /probe/orders", key: "synthetic-key-000000004", body: "bad.json", status: "201" }),
      ...ev({ seq: 5, op: "POST /probe/orders", key: "synthetic-key-000000005", body: "bad.json", status: "201", extra: ["    duplicate_of: 1"] }),
    ];
    writeFileSync(idx, [...head, ...events, ""].join("\n"));
    const r = prove(docs, docs, [idx]);
    const text = r.replay.problems.join(" | ");
    assert.match(text, /operation 'GET \/nope' not found/);
    assert.match(text, /expected status 418 is not declared/);
    assert.match(text, /Idempotency-Key .*shorter than 16/);
    assert.match(text, /body \.total: does not match/);
    assert.match(text, /duplicate_of 1 must repeat its operation, key and body/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("replay fails closed when the current contract has no JSON request schema", needsOasdiff, () => {
  const docs = loadDocs(SYNTH);
  const noJson = structuredClone(docs);
  const op = noJson[0].paths["/probe/orders"].post;
  op.requestBody = { required: true, content: { "text/plain": { schema: { type: "string" } } } };
  const r = prove(docs, noJson);
  assert.match(r.replay.problems.join(" | "), /no application[/]json schema/);
});

test("a malformed fixture index is reported, not ignored", () => {
  const work = mkdtempSync(path.join(tmpdir(), "replay-spec-"));
  try {
    const idx = path.join(work, "idx.yaml");
    writeFileSync(idx, ["schema: wrong", "provenance: invented", "events: []", ""].join("\n"));
    const f = loadFixture(idx);
    assert.match(f.problems.join(" | "), /schema must be 'retail-tower[/]pos-replay@1'/);
    assert.match(f.problems.join(" | "), /provenance must be recorded[|]contract-derived[|]synthetic/);
    assert.match(f.problems.join(" | "), /events must be a non-empty list/);
    assert.deepEqual(fixtureFiles(work, "no-such-snapshot"), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("deref follows local refs and fails closed on anything else", () => {
  assert.equal(deref({ $ref: "#/components/schemas/Name" }, DOC).type, "string");
  assert.throws(() => deref({ $ref: "http://x/y" }, DOC), /unsupported \$ref/);
});
