// RT-713: load OpenAPI contracts as plain JSON for the envelope and replay checks.
// The compat job has no install step, so there is no YAML library: `oasdiff flatten`
// (already installed for the diff) parses each file and prints JSON, keeping local
// `$ref`s. Anything it cannot parse, or any `$ref` that is not local, fails closed.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export const oasdiffBin = () => process.env.OASDIFF ?? "oasdiff";

function flatten(file) {
  // PATH-resolved like tools/oasdiff/check.sh; CI installs a pinned, checksum-verified binary.
  const r = spawnSync(oasdiffBin(), ["flatten", file, "--format", "json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }); // NOSONAR
  if (r.error || r.status !== 0) throw new Error(`oasdiff flatten failed for ${file}: ${r.error?.message ?? r.stderr}`);
  return JSON.parse(r.stdout);
}

function yamlFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Parse every *.yaml contract under dir into a JSON document; any failure throws. */
export const loadDocs = (dir) => yamlFiles(dir).map(flatten);

/**
 * Like loadDocs, but a file oasdiff cannot flatten (e.g. an allOf it cannot merge) is skipped and
 * reported. Used for the current contracts: an operation that lived only in a skipped file then
 * reads as missing, so a skipped file can fail the gate but never hide a regression.
 * @returns { docs, skipped: string[] }
 */
export function loadDocsTolerant(dir) {
  const docs = [];
  const skipped = [];
  for (const file of yamlFiles(dir)) {
    try {
      docs.push(flatten(file));
    } catch {
      skipped.push(path.relative(dir, file));
    }
  }
  return { docs, skipped };
}

/** Follow local `$ref`s; a non-local one throws. */
export function deref(node, doc) {
  let cur = node;
  for (let hops = 0; cur && typeof cur === "object" && cur.$ref !== undefined; hops += 1) {
    if (hops > 20 || !cur.$ref.startsWith("#/")) throw new Error(`unsupported $ref '${cur.$ref}'`);
    cur = cur.$ref.slice(2).split("/").reduce((n, k) => n?.[k.replaceAll("~1", "/").replaceAll("~0", "~")], doc);
  }
  return cur;
}

const operationsOf = (doc) =>
  Object.entries(doc.paths ?? {}).flatMap(([p, item]) =>
    METHODS.filter((m) => item?.[m] !== undefined).map((m) => [`${m.toUpperCase()} ${p}`, { op: item[m], doc }]),
  );

/** Map `METHOD /path` -> { op, doc } across all documents; a duplicate throws. */
export function indexOperations(docs) {
  const index = new Map();
  for (const [key, entry] of docs.flatMap(operationsOf)) {
    if (index.has(key)) throw new Error(`operation ${key} is defined more than once`);
    index.set(key, entry);
  }
  return index;
}

/** Resolved parameters of an operation (path-item level parameters are not used by these contracts). */
export const parametersOf = ({ op, doc }) => (op.parameters ?? []).map((p) => deref(p, doc));

export const jsonSchemaOf = (content, doc) => deref(content?.["application/json"]?.schema, doc);
