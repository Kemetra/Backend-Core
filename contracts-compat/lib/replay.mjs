// RT-713: contract-level replay of fixture events (RT-709 §C.2, `retail-tower/pos-replay@1`).
// A fixture is a YAML index plus JSON bodies. Each event is checked on its own, first against
// the snapshot it belongs to (a fixture must be valid there) and then against the current
// contracts: the operation still exists, the Idempotency-Key still fits the header schema,
// the body still validates against the request schema, and the expected status is still
// declared. Nothing here simulates the server: Backend-Core's runtime idempotency behavior is
// covered by its own suites (apps/api/test/idempotency/replay.spec.ts, db-integration).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { validate } from "./schema.mjs";
import { deref, jsonSchemaOf, parametersOf } from "./spec.mjs";
import { parseYamlSubset } from "./yaml-subset.mjs";

export const REPLAY_SCHEMA = "retail-tower/pos-replay@1";
export const PROVENANCE = ["recorded", "contract-derived", "synthetic"];
const INDEX_KEYS = ["schema", "snapshot", "provenance", "recorded_from", "events"];
const EVENT_KEYS = ["seq", "operation", "idempotency_key", "body_ref", "duplicate_of", "expect_status"];
const REQUIRED_EVENT_FIELDS = ["seq", "operation", "idempotency_key", "expect_status"];

const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
const eventsOf = (index) => (Array.isArray(index.events) ? index.events : []);

function indexProblems(idx) {
  const out = unknownKeys(idx, INDEX_KEYS).map((k) => `unknown key '${k}'`);
  if (idx.schema !== REPLAY_SCHEMA) out.push(`schema must be '${REPLAY_SCHEMA}'`);
  if (!PROVENANCE.includes(idx.provenance)) out.push(`provenance must be ${PROVENANCE.join("|")}`);
  if (eventsOf(idx).length === 0) out.push("events must be a non-empty list");
  return out;
}

function eventShapeProblems(e) {
  const out = unknownKeys(e, EVENT_KEYS).map((k) => `event ${e.seq}: unknown key '${k}'`);
  for (const k of REQUIRED_EVENT_FIELDS) {
    if (typeof e[k] !== "string" || e[k] === "") out.push(`event ${e.seq}: ${k} is required`);
  }
  return out;
}

/** Read one fixture index and its bodies. @returns { file, index, bodies: Map<ref, json>, problems } */
export function loadFixture(file) {
  const dir = path.dirname(file);
  const index = parseYamlSubset(readFileSync(file, "utf8"));
  const problems = [...indexProblems(index), ...eventsOf(index).flatMap(eventShapeProblems)];
  const bodies = new Map();
  for (const e of eventsOf(index).filter((x) => x.body_ref)) {
    bodies.set(e.body_ref, JSON.parse(readFileSync(path.join(dir, e.body_ref), "utf8")));
  }
  return { file, index, bodies, problems };
}

/** Index files for a snapshot id: contracts-compat/replay/<id>/*.yaml (none = zero fixtures). */
export function fixtureFiles(replayDir, snapshotId) {
  const dir = path.join(replayDir, snapshotId);
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function checkKeyHeader(entry, key, label) {
  const param = parametersOf(entry).find((p) => p.in === "header" && p.name === "Idempotency-Key");
  if (!param) return [`${label}: operation has no Idempotency-Key header`];
  return validate(key, param.schema ?? {}, entry.doc).map((m) => `${label}: Idempotency-Key ${m}`);
}

function checkBody(entry, body, label) {
  const rb = deref(entry.op.requestBody, entry.doc);
  if (!rb) return body === undefined ? [] : [`${label}: operation takes no request body`];
  if (body === undefined) return rb.required ? [`${label}: request body is required`] : [];
  const schema = jsonSchemaOf(rb.content, entry.doc);
  if (!schema) return [`${label}: request body has no application/json schema, so the old body cannot be sent as JSON`];
  return validate(body, schema, entry.doc).map((m) => `${label}: body ${m}`);
}

function checkEvent(event, body, index, label) {
  const entry = index.get(event.operation);
  if (!entry) return [`${label}: operation '${event.operation}' not found`];
  const out = [...checkKeyHeader(entry, event.idempotency_key, label), ...checkBody(entry, body, label)];
  if (entry.op.responses?.[event.expect_status] === undefined) {
    out.push(`${label}: expected status ${event.expect_status} is not declared`);
  }
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function duplicateProblem(e, bySeq, bodies) {
  const orig = bySeq.get(e.duplicate_of);
  const repeats = orig && orig.operation === e.operation && orig.idempotency_key === e.idempotency_key;
  if (repeats && same(bodies.get(orig.body_ref), bodies.get(e.body_ref))) return null;
  return `event ${e.seq}: duplicate_of ${e.duplicate_of} must repeat its operation, key and body`;
}

// A marked duplicate must repeat its original exactly; the fixture's own order is kept.
function duplicateProblems(fixture) {
  const events = eventsOf(fixture.index);
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  return events
    .filter((e) => e.duplicate_of !== undefined)
    .map((e) => duplicateProblem(e, bySeq, fixture.bodies))
    .filter(Boolean);
}

/** @returns string[] problems for one fixture against one contract index */
export function replayProblems(fixture, index, label) {
  const events = eventsOf(fixture.index);
  const seqs = events.map((e) => e.seq);
  const out = new Set(seqs).size === seqs.length ? [] : [`${label}: event seq values must be unique`];
  for (const e of events) out.push(...checkEvent(e, fixture.bodies.get(e.body_ref), index, `${label} event ${e.seq}`));
  return [...out, ...duplicateProblems(fixture).map((m) => `${label}: ${m}`)];
}
