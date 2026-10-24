// RT-713: small, fail-closed JSON Schema validator for the OpenAPI subset the POS
// contracts use. A keyword it does not implement is a validation ERROR (never a silent
// pass), so a contract that starts using one fails the replay check until it is added.
import { deref } from "./spec.mjs";

// Documentation-only keywords carry no validation semantics.
const ANNOTATIONS = new Set([
  "description", "example", "examples", "title", "deprecated", "readOnly", "writeOnly",
  "format", "default", "externalDocs", "xml", "nullable",
]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const TYPES = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: isObject,
  array: Array.isArray,
  null: (v) => v === null,
};
const at = (p, msg) => [`${p || "$"}: ${msg}`];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function checkType(v, arg, { p }) {
  const wanted = Array.isArray(arg) ? arg : [arg];
  return wanted.some((t) => TYPES[t]?.(v)) ? [] : at(p, `expected ${wanted.join("|")}`);
}

function checkRequired(v, arg, { p }) {
  if (!isObject(v)) return [];
  return arg.filter((k) => !Object.hasOwn(v, k)).flatMap((k) => at(p, `missing required property '${k}'`));
}

function checkProperties(v, arg, ctx) {
  if (!isObject(v)) return [];
  return Object.keys(arg)
    .filter((k) => Object.hasOwn(v, k))
    .flatMap((k) => validate(v[k], arg[k], ctx.doc, `${ctx.p}.${k}`));
}

function checkAdditional(v, arg, ctx) {
  if (!isObject(v) || arg === true) return [];
  const extra = Object.keys(v).filter((k) => !Object.hasOwn(ctx.node.properties ?? {}, k));
  if (arg === false) return extra.flatMap((k) => at(ctx.p, `unknown property '${k}'`));
  return extra.flatMap((k) => validate(v[k], arg, ctx.doc, `${ctx.p}.${k}`));
}

const checkItems = (v, arg, ctx) =>
  Array.isArray(v) ? v.flatMap((x, i) => validate(x, arg, ctx.doc, `${ctx.p}[${i}]`)) : [];

const checkEnum = (v, arg, { p }) => (arg.some((e) => same(e, v)) ? [] : at(p, "value not in enum"));
const checkPattern = (v, arg, { p }) => (typeof v !== "string" || new RegExp(arg).test(v) ? [] : at(p, `does not match ${arg}`));
const bound = (test, what) => (v, arg, { p }) => (test(v, arg) ? [] : at(p, what + " " + arg));
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number";

function countPassing(v, arg, ctx) {
  return arg.filter((s) => validate(v, s, ctx.doc, ctx.p).length === 0).length;
}

const checkOneOf = (v, arg, ctx) => (countPassing(v, arg, ctx) === 1 ? [] : at(ctx.p, "must match exactly one of oneOf"));
const checkAnyOf = (v, arg, ctx) => (countPassing(v, arg, ctx) >= 1 ? [] : at(ctx.p, "must match one of anyOf"));
const checkAllOf = (v, arg, ctx) => arg.flatMap((s) => validate(v, s, ctx.doc, ctx.p));

const RULES = {
  type: checkType, required: checkRequired, properties: checkProperties,
  additionalProperties: checkAdditional, items: checkItems, enum: checkEnum, pattern: checkPattern,
  minLength: bound((v, n) => !isStr(v) || v.length >= n, "shorter than"),
  maxLength: bound((v, n) => !isStr(v) || v.length <= n, "longer than"),
  minimum: bound((v, n) => !isNum(v) || v >= n, "below minimum"),
  maximum: bound((v, n) => !isNum(v) || v <= n, "above maximum"),
  minItems: bound((v, n) => !Array.isArray(v) || v.length >= n, "fewer items than"),
  maxItems: bound((v, n) => !Array.isArray(v) || v.length <= n, "more items than"),
  oneOf: checkOneOf, anyOf: checkAnyOf, allOf: checkAllOf,
};

const ignored = (kw) => ANNOTATIONS.has(kw) || kw.startsWith("x-");

/** @returns string[] validation errors (empty = valid) */
export function validate(value, schema, doc, p = "") {
  const node = deref(schema, doc);
  if (value === null && node.nullable === true) return [];
  const ctx = { node, doc, p };
  return Object.entries(node)
    .filter(([kw]) => !ignored(kw))
    .flatMap(([kw, arg]) => (RULES[kw] ? RULES[kw](value, arg, ctx) : at(p, `unsupported schema keyword '${kw}'`)));
}
