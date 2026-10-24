// RT-713: idempotency-key contract tests, run for each supported snapshot against the current
// contracts. Only rules oasdiff does not already enforce live here (checked with probes: oasdiff
// passes each of these regressions, so each rule earns its place):
//   R1  an operation the snapshot marks `x-idempotency: required` still does, and still
//       requires the `Idempotency-Key` header if the snapshot required it (some operations,
//       e.g. cashier admissions, carry the key in the body instead)
//   R2  every non-2xx status the snapshot declares (409 conflict, 422, ...) is still declared
// The error envelope shape itself (a required `error.code` removed) is already an oasdiff ERR,
// so it is not re-implemented here.
import { parametersOf } from "./spec.mjs";

const KEY_HEADER = "Idempotency-Key";
const isSuccess = (status) => /^2\d\d$/.test(status);

const errorStatuses = (entry) => Object.keys(entry.op.responses ?? {}).filter((s) => !isSuccess(s));

const requiredKeyHeader = (entry) =>
  parametersOf(entry).some((p) => p.in === "header" && p.name === KEY_HEADER && p.required === true);

function ruleIdempotency(snap, cand, key) {
  if (snap.op["x-idempotency"] !== "required") return [];
  const out = [];
  if (cand.op["x-idempotency"] !== "required") out.push(`${key}: x-idempotency is no longer 'required'`);
  if (requiredKeyHeader(snap) && !requiredKeyHeader(cand)) out.push(`${key}: the ${KEY_HEADER} header is no longer a required parameter`);
  return out;
}

const ruleStatuses = (snap, cand, key) =>
  errorStatuses(snap)
    .filter((s) => cand.op.responses?.[s] === undefined)
    .map((s) => `${key}: response ${s} is no longer declared`);

const RULES = [ruleIdempotency, ruleStatuses];

/** @returns { problems: string[], operations: number } */
export function checkSemantics(snapshotIndex, candidateIndex) {
  const problems = [];
  for (const [key, snap] of snapshotIndex) {
    const cand = candidateIndex.get(key);
    if (cand === undefined) problems.push(`${key}: operation is missing from the current contracts`);
    else problems.push(...RULES.flatMap((rule) => rule(snap, cand, key)));
  }
  return { problems, operations: snapshotIndex.size };
}
