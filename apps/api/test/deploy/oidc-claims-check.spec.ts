/**
 * RT-722 — the print-only OIDC claims check for the aws-lab environment
 * (.github/workflows/oidc-claims-check.yml and deploy/lab/oidc-claims-check.cjs).
 * The workflow checks are static. The helper checks run the real comparison
 * logic against synthetic tokens, so no GitHub token, AWS call or network is
 * involved.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as yaml from "js-yaml";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
// Normalise CRLF so checkouts with core.autocrlf behave like CI.
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");

type Helper = {
  decodeClaims: (token: string) => Record<string, unknown>;
  evaluate: (claims: Record<string, unknown>, workflowFile: string) => { ok: boolean; derived: string | null };
  expectedClaims: (workflowFile: string) => [string, string][];
  main: (argv: string[], io?: { token?: string; stdout?: (text: string) => void }) => number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const helper = require(resolve(repoRoot, "deploy/lab/oidc-claims-check.cjs")) as Helper;

// ---------------------------------------------------------------- workflow

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { if?: string; environment?: unknown; permissions?: Record<string, string>; steps: Step[] };
type Input = { required?: boolean; type?: string };
type Workflow = {
  on: Record<string, { inputs: Record<string, Input> }>;
  permissions: unknown;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
};

const workflowText = read(".github/workflows/oidc-claims-check.yml");
const workflow = yaml.load(workflowText) as Workflow;
const jobs = Object.entries(workflow.jobs);
const job = jobs[0]?.[1] as Job;
const steps = job.steps;
const tokenStep = steps.find((s) => (s.name ?? "").startsWith("Request the OIDC token")) as Step;
const tokenScript = tokenStep.run ?? "";

describe("oidc-claims-check workflow", () => {
  it("is manual only, with one required Jira key input", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch?.inputs).toEqual({
      jira_key: expect.objectContaining({ required: true, type: "string" }),
    });
  });

  it("holds one run at a time without cancelling a running one", () => {
    expect(workflow.concurrency).toEqual({ group: "oidc-claims-check", "cancel-in-progress": false });
  });

  it("has one job that runs in the aws-lab environment, so its reviewer approves every run", () => {
    expect(jobs).toHaveLength(1);
    expect(job.environment).toBe("aws-lab");
    expect(job.if).toBeUndefined();
  });

  it("grants nothing at the top level and exactly contents:read + id-token:write to the job", () => {
    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(workflowText.match(/^\s*id-token:/gm) ?? []).toHaveLength(1);
  });

  it("guards first: main ref and a validated Jira key", () => {
    const guard = steps[0];
    expect(guard?.name).toMatch(/^Guard/);
    expect(guard?.env?.RUN_REF).toBe("${{ github.ref }}");
    expect(guard?.run).toContain('"$RUN_REF" = "refs/heads/main"');
    expect(guard?.run).toContain("^RT-[1-9][0-9]*$");
    expect(steps.indexOf(tokenStep)).toBeGreaterThan(0);
  });

  it("uses only the pinned checkout action, without credentials or a ref", () => {
    const uses = steps.map((s) => s.uses).filter((u): u is string => typeof u === "string");
    expect(uses).toEqual(["actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683"]);
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@")) as Step;
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    expect(checkout.with).not.toHaveProperty("ref");
  });

  it("never interpolates expressions inside run scripts (the input reaches the shell via env only)", () => {
    for (const step of steps) if (step.run !== undefined) expect(step.run).not.toContain("${{");
  });

  it("uses no secret at all and persists nothing: no artifact, cache or output file", () => {
    expect(workflowText).not.toMatch(/secrets\./);
    expect(workflowText).not.toMatch(/upload-artifact|actions\/cache|GITHUB_OUTPUT|GITHUB_ENV/);
  });

  it("calls no AWS API and has no credentials step", () => {
    for (const step of steps) {
      expect(step.uses ?? "").not.toMatch(/aws|credentials|ssh|deploy/i);
      expect(step.run ?? "").not.toMatch(/(^|[\s;&|(])(aws|ssh|scp|ssm|kubectl)\s/im);
    }
    // code only: the header comment says "no AWS_* variable"
    const code = workflowText.replace(/^\s*#.*$/gm, "");
    expect(code).not.toMatch(/AWS_|configure-aws-credentials|role-to-assume/);
  });

  it("asks only GitHub for the token, for the sts.amazonaws.com audience", () => {
    expect(tokenScript).toContain('"$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com"');
    expect(tokenScript).not.toMatch(/https?:\/\//);
  });

  it("masks the request token before the request and the OIDC token before any other use", () => {
    const maskRequest = tokenScript.indexOf('echo "::add-mask::$ACTIONS_ID_TOKEN_REQUEST_TOKEN"');
    const curl = tokenScript.indexOf("curl ");
    const assign = tokenScript.indexOf('TOKEN="$(jq');
    const maskToken = tokenScript.indexOf('echo "::add-mask::$TOKEN"');
    const use = tokenScript.indexOf("printf '%s' \"$TOKEN\" | node deploy/lab/oidc-claims-check.cjs");
    expect(maskRequest).toBeGreaterThan(-1);
    expect(maskRequest).toBeLessThan(curl);
    expect(assign).toBeGreaterThan(curl);
    expect(maskToken).toBeGreaterThan(assign);
    expect(use).toBeGreaterThan(maskToken);
  });

  it("touches the token only to mask it and to pipe it to the helper: no trace, no echo", () => {
    expect(tokenScript).not.toMatch(/set\s+-\S*x|xtrace/);
    const lines = tokenScript.split("\n").filter((l) => /\$\{?TOKEN\b/.test(l));
    expect(lines.map((l) => l.trim())).toEqual([
      'echo "::add-mask::$TOKEN"',
      "printf '%s' \"$TOKEN\" | node deploy/lab/oidc-claims-check.cjs \\",
    ]);
  });

  it("runs the helper with this workflow's own file name and the step summary", () => {
    expect(tokenScript).toContain('--jira-key "$JIRA_KEY"');
    expect(tokenScript).toContain("--workflow-file oidc-claims-check.yml");
    expect(tokenScript).toContain('--summary "$GITHUB_STEP_SUMMARY"');
  });
});

// ------------------------------------------------------------------ helper

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const SIGNATURE = "c2lnbmF0dXJl-SIGNATURE_SHOULD_NEVER_PRINT";
const jwt = (claims: unknown): string => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.${SIGNATURE}`;

const WORKFLOW_FILE = "oidc-claims-check.yml";
const GOOD: Record<string, unknown> = {
  iss: "https://token.actions.githubusercontent.com",
  aud: "sts.amazonaws.com",
  sub: "repo:Kemetra@206601658/Backend-Core@1226735953:environment:aws-lab",
  repository_owner_id: "206601658",
  repository_id: "1226735953",
  environment: "aws-lab",
  ref: "refs/heads/main",
  actor_id: "206601658",
  job_workflow_ref: `Kemetra/Backend-Core/.github/workflows/${WORKFLOW_FILE}@refs/heads/main`,
  repository: "Kemetra/Backend-Core",
  actor: "Kemetra",
  workflow: "OIDC claims check",
  event_name: "workflow_dispatch",
  ref_type: "branch",
  runner_environment: "github-hosted",
  // present in a real token, but never allowlisted for printing
  jti: "JTI-SHOULD-NEVER-PRINT",
  sha: "SHA-SHOULD-NEVER-PRINT",
  run_id: "RUNID-SHOULD-NEVER-PRINT",
};

let errors: string[];
beforeEach(() => {
  errors = [];
  jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
});
afterEach(() => jest.restoreAllMocks());

function run(token: string, args: string[] = ["--jira-key", "RT-722"]): { code: number; out: string } {
  let out = "";
  const code = helper.main(args, { token, stdout: (text) => (out += text) });
  return { code, out };
}
const rowFor = (out: string, claim: string): string => out.split("\n").find((l) => l.startsWith(`| \`${claim}\``)) ?? "";

describe("oidc-claims-check helper", () => {
  it("expects exactly the S2a v2 trust-policy values", () => {
    expect(Object.fromEntries(helper.expectedClaims(WORKFLOW_FILE))).toEqual({
      iss: "https://token.actions.githubusercontent.com",
      aud: "sts.amazonaws.com",
      sub: "repo:Kemetra@206601658/Backend-Core@1226735953:environment:aws-lab",
      repository_owner_id: "206601658",
      repository_id: "1226735953",
      environment: "aws-lab",
      ref: "refs/heads/main",
      actor_id: "206601658",
      job_workflow_ref: "Kemetra/Backend-Core/.github/workflows/oidc-claims-check.yml@refs/heads/main",
    });
  });

  it("exits 0 when every expected claim matches, and prints the deploy-lab value to pin", () => {
    const { code, out } = run(jwt(GOOD));
    expect(code).toBe(0);
    for (const [claim] of helper.expectedClaims(WORKFLOW_FILE)) expect(rowFor(out, claim)).toMatch(/\| MATCH \|$/);
    expect(out).not.toMatch(/MISMATCH|MISSING/);
    expect(out).toContain("`Kemetra/Backend-Core/.github/workflows/deploy-lab.yml@refs/heads/main`");
    expect(out).toContain("Result: all 9 expected claims match.");
  });

  it.each(helper.expectedClaims(WORKFLOW_FILE).map(([claim]) => claim))("exits 1 and names %s when it differs", (claim) => {
    const { code, out } = run(jwt({ ...GOOD, [claim]: "wrong-value" }));
    expect(code).toBe(1);
    expect(rowFor(out, claim)).toMatch(/\| MISMATCH \|$/);
    const others = helper.expectedClaims(WORKFLOW_FILE).filter(([c]) => c !== claim);
    for (const [other] of others) expect(rowFor(out, other)).toMatch(/\| MATCH \|$/);
    expect(out).toContain("Result: 1 of 9 expected claims are missing or differ.");
  });

  it.each(helper.expectedClaims(WORKFLOW_FILE).map(([claim]) => claim))("exits 1 and reports %s as MISSING when absent", (claim) => {
    const claims = { ...GOOD };
    delete claims[claim];
    const { code, out } = run(jwt(claims));
    expect(code).toBe(1);
    expect(rowFor(out, claim)).toMatch(/\| - \| MISSING \|$/);
  });

  it("treats a one-element aud array as the audience and any other array as a mismatch", () => {
    expect(run(jwt({ ...GOOD, aud: ["sts.amazonaws.com"] })).code).toBe(0);
    const two = run(jwt({ ...GOOD, aud: ["sts.amazonaws.com", "other"] }));
    expect(two.code).toBe(1);
    expect(rowFor(two.out, "aud")).toMatch(/\| MISMATCH \|$/);
  });

  it("does not match a non-scalar claim value", () => {
    const { code, out } = run(jwt({ ...GOOD, environment: { name: "aws-lab" } }));
    expect(code).toBe(1);
    expect(rowFor(out, "environment")).toMatch(/\| MISMATCH \|$/);
  });

  it("compares job_workflow_ref with the workflow file it is told, and still derives the deploy-lab value", () => {
    const other = { ...GOOD, job_workflow_ref: "Kemetra/Backend-Core/.github/workflows/other.yml@refs/heads/main" };
    const asDefault = run(jwt(other));
    expect(asDefault.code).toBe(1);
    expect(rowFor(asDefault.out, "job_workflow_ref")).toMatch(/\| MISMATCH \|$/);
    expect(asDefault.out).toContain("deploy-lab.yml@refs/heads/main");
    const told = run(jwt(other), ["--jira-key", "RT-722", "--workflow-file", "other.yml"]);
    expect(told.code).toBe(0);
  });

  it("refuses to suggest a pin when job_workflow_ref is not in the expected form", () => {
    const { out } = run(jwt({ ...GOOD, job_workflow_ref: "Someone/Else/.github/workflows/x.yml@refs/heads/main" }));
    expect(out).toContain("do not pin it until it is understood");
    expect(out).not.toContain("deploy-lab.yml@refs/heads/main");
  });

  it("prints the informational claims but no other claim, and never the token or its parts", () => {
    const token = jwt(GOOD);
    const { out } = run(token);
    for (const claim of ["repository", "actor", "workflow", "event_name", "ref_type", "runner_environment"]) {
      expect(out).toContain(`- \`${claim}\` = `);
    }
    for (const forbidden of ["SHOULD-NEVER-PRINT", token, ...token.split(".")]) expect(out).not.toContain(forbidden);
    expect(errors.join("\n")).toBe("");
  });

  it("neutralises control characters and workflow commands in a claim value", () => {
    const { out } = run(jwt({ ...GOOD, actor: "x\n::error::boom\u0007|`y`" }));
    expect(out.split("\n").every((l) => !l.startsWith("::"))).toBe(true);
    expect(out).not.toContain("::error::");
    expect(out).toContain("- `actor` = `x?: :error: :boom?/'y'`");
  });

  it("appends the same text to the --summary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt722-"));
    try {
      const summary = join(dir, "summary.md");
      const { out } = run(jwt(GOOD), ["--jira-key", "RT-722", "--summary", summary]);
      expect(readFileSync(summary, "utf8")).toBe(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["an empty token", ""],
    ["two segments", "a.b"],
    ["a non-base64url segment", "aaa.b!b.ccc"],
    ["a payload that is not JSON", `${b64("h")}.${Buffer.from("not json").toString("base64url")}.sig`],
    ["a JSON array payload", `${b64("h")}.${b64([1, 2])}.sig`],
    ["a JSON null payload", `${b64("h")}.${b64(null)}.sig`],
    ["an oversized token", `${"a".repeat(20000)}.b.c`],
  ])("exits 2 for %s without echoing any of it", (_label, token) => {
    const { code, out } = run(token);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(errors).toHaveLength(1);
    if (token.length > 0) expect(errors[0]).not.toContain(token.slice(0, 12));
  });

  it.each([
    ["no Jira key", []],
    ["a bad Jira key", ["--jira-key", "RT-0"]],
    ["an unknown argument", ["--jira-key", "RT-722", "--verbose", "1"]],
    ["a flag with no value", ["--jira-key", "RT-722", "--summary"]],
    ["a path in --workflow-file", ["--jira-key", "RT-722", "--workflow-file", "../x.yml"]],
    ["a non-workflow --workflow-file", ["--jira-key", "RT-722", "--workflow-file", "x.sh"]],
  ])("exits 2 for %s", (_label, args) => {
    const { code, out } = run(jwt(GOOD), args as string[]);
    expect(code).toBe(2);
    expect(out).toBe("");
  });

  it("makes no network, process, AWS or token-writing call", () => {
    const source = read("deploy/lab/oidc-claims-check.cjs");
    expect(source).not.toMatch(/node:(https?|http2|net|tls|dns|child_process|worker_threads)|fetch\(|aws-sdk/);
    expect(source).not.toMatch(/process\.env/);
    expect(source).toContain('require("node:fs")');
  });
});
