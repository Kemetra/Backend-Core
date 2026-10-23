/**
 * RT-722 — the OIDC claims helper (deploy/lab/oidc-claims-check.cjs), now used
 * by the live job in deploy-lab.yml. The print-only workflow that first proved
 * the claims was removed at gate G5 (RT-532 c13609 / c13626). The checks run the
 * real comparison logic against synthetic tokens, so no GitHub token, AWS call or
 * network is involved.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
