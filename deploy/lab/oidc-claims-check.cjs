#!/usr/bin/env node
// RT-722: print-only check of the GitHub Actions OIDC token claims for the
// aws-lab environment (.github/workflows/oidc-claims-check.yml). It reads one
// token from stdin, decodes its payload, prints an allowlist of non-secret
// claims and compares them with the values the AWS trust policy for
// rt-gha-aws-lab-deploy will depend on (RT-532, S2a v2). It makes no network
// call, reads no secret, calls no AWS API and writes only to stdout and,
// with --summary, appends to that one file.
//
// The signature is NOT verified: this is a diagnostic on a token the workflow
// fetched straight from GitHub. AWS verifies the signature when a role is
// assumed. The token and the full payload are never printed: only the
// allowlisted claims below, each cleaned of control characters.
//
// Usage:
//   printf '%s' "$TOKEN" | node deploy/lab/oidc-claims-check.cjs
//     --jira-key RT-<n> [--workflow-file oidc-claims-check.yml] [--summary FILE]
//
// Exit 0: every expected claim matches. Exit 1: at least one is missing or
// differs (the table says which). Exit 2: usage error or an unreadable token.
"use strict";

const fs = require("node:fs");

const OWNER = "Kemetra";
const REPO_NAME = "Backend-Core";
const OWNER_ID = "206601658";
const REPO_ID = "1226735953";
const ENVIRONMENT = "aws-lab";
const AUDIENCE = "sts.amazonaws.com";
const ISSUER = "https://token.actions.githubusercontent.com";
// The workflow the trust policy pins as job_workflow_ref (the S4 deploy job).
const TRUSTED_WORKFLOW_FILE = "deploy-lab.yml";
const DEFAULT_WORKFLOW_FILE = "oidc-claims-check.yml";
const JIRA_RE = /^RT-[1-9]\d*$/;
const WORKFLOW_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/;
const WORKFLOW_REF_RE = /^Kemetra\/Backend-Core\/\.github\/workflows\/([A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml)@refs\/heads\/main$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const MAX_TOKEN_CHARS = 16 * 1024;
const MAX_VALUE_CHARS = 200;
// Printed for context, never compared.
const INFO_CLAIMS = ["repository", "actor", "workflow", "workflow_ref", "event_name", "ref_type", "runner_environment"];

const workflowRef = (file) => `${OWNER}/${REPO_NAME}/.github/workflows/${file}@refs/heads/main`;

class UsageError extends Error {}

/** The expected value of each claim the trust policy checks, in table order. */
function expectedClaims(workflowFile) {
  return [
    ["iss", ISSUER],
    ["aud", AUDIENCE],
    ["sub", `repo:${OWNER}@${OWNER_ID}/${REPO_NAME}@${REPO_ID}:environment:${ENVIRONMENT}`],
    ["repository_owner_id", OWNER_ID],
    ["repository_id", REPO_ID],
    ["environment", ENVIRONMENT],
    ["ref", "refs/heads/main"],
    ["actor_id", OWNER_ID],
    ["job_workflow_ref", workflowRef(workflowFile)],
  ];
}

/** Decode the payload of a JWT. Never echoes any part of the token in an error. */
function decodeClaims(token) {
  if (typeof token !== "string" || token.length === 0) throw new UsageError("no token on stdin");
  if (token.length > MAX_TOKEN_CHARS) throw new UsageError("token is larger than expected");
  if (!JWT_RE.test(token)) throw new UsageError("input is not a three-part JWT");
  let claims;
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    throw new UsageError("token payload is not JSON");
  }
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    throw new UsageError("token payload is not a JSON object");
  }
  return claims;
}

/** A printable, single-line, table-safe form of a claim value. */
function clean(text) {
  return String(text)
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/::/g, ": :")
    .replace(/\|/g, "/")
    .replace(/`/g, "'")
    .slice(0, MAX_VALUE_CHARS);
}

/** The claim as a string to compare, or null when it is absent. aud may be an array. */
function observe(claims, name) {
  const value = claims[name];
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.length === 1 && typeof value[0] === "string" ? value[0] : `[${value.length} values]`;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "<non-scalar value>";
}

function evaluate(claims, workflowFile) {
  const rows = expectedClaims(workflowFile).map(([claim, expected]) => {
    const observed = observe(claims, claim);
    const status = observed === null ? "MISSING" : observed === expected ? "MATCH" : "MISMATCH";
    return { claim, expected, observed, status };
  });
  const info = INFO_CLAIMS.map((claim) => ({ claim, observed: observe(claims, claim) })).filter((r) => r.observed !== null);
  const observedRef = observe(claims, "job_workflow_ref");
  const refForm = observedRef === null ? null : WORKFLOW_REF_RE.exec(observedRef);
  return {
    rows,
    info,
    ok: rows.every((r) => r.status === "MATCH"),
    // What the trust policy would pin if the observed form is right: same repo and ref, the deploy workflow file.
    derived: refForm ? workflowRef(TRUSTED_WORKFLOW_FILE) : null,
  };
}

function render(result, jiraKey, workflowFile) {
  const lines = [
    `### OIDC claims check for ${jiraKey} (workflow file ${workflowFile})`,
    "",
    "| Claim | Expected (S2a v2) | Observed | Status |",
    "| --- | --- | --- | --- |",
    ...result.rows.map((r) => `| \`${r.claim}\` | \`${clean(r.expected)}\` | ${r.observed === null ? "-" : `\`${clean(r.observed)}\``} | ${r.status} |`),
    "",
  ];
  if (result.info.length) {
    lines.push("Other claims (informational, not compared):", ...result.info.map((r) => `- \`${r.claim}\` = \`${clean(r.observed)}\``), "");
  }
  lines.push(
    result.derived
      ? `job_workflow_ref has the expected form. The value the trust policy pins for the deploy job is \`${result.derived}\`.`
      : "job_workflow_ref is missing or not in the form Kemetra/Backend-Core/.github/workflows/<file>@refs/heads/main: do not pin it until it is understood.",
    result.ok
      ? `Result: all ${result.rows.length} expected claims match.`
      : `Result: ${result.rows.filter((r) => r.status !== "MATCH").length} of ${result.rows.length} expected claims are missing or differ. Correct the policy to the printed value, never to a wildcard.`,
    "",
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { "workflow-file": DEFAULT_WORKFLOW_FILE };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!["--jira-key", "--workflow-file", "--summary"].includes(key)) throw new UsageError(`unknown argument ${clean(key)}`);
    if (argv[i + 1] === undefined) throw new UsageError(`${key} needs a value`);
    args[key.slice(2)] = argv[i + 1];
  }
  if (!JIRA_RE.test(args["jira-key"] ?? "")) throw new UsageError("--jira-key must be RT-<number>");
  if (!WORKFLOW_FILE_RE.test(args["workflow-file"])) throw new UsageError("--workflow-file must be a plain workflow file name");
  return args;
}

/** io.token, io.stdout and io.readStdin exist so the spec can run the real logic without a process. */
function main(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  try {
    const args = parseArgs(argv);
    const token = (io.token ?? (io.readStdin ?? (() => fs.readFileSync(0, "utf8")))()).trim();
    const result = evaluate(decodeClaims(token), args["workflow-file"]);
    const text = render(result, args["jira-key"], args["workflow-file"]);
    stdout(text);
    if (args.summary) fs.appendFileSync(args.summary, text);
    return result.ok ? 0 : 1;
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`oidc-claims-check: ${err.message}`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { decodeClaims, evaluate, expectedClaims, main, render };
