/**
 * RT-703 — the manual lab deploy workflow (slice 1: preflight / dry run only)
 * and its offline release verifier. The workflow checks are static; the
 * verifier checks run the real refusal logic against generated evidence, so
 * every refusal path is exercised without cloud credentials or host access.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as yaml from "js-yaml";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
// Normalise CRLF so checkouts with core.autocrlf behave like CI.
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");

type Ctx = {
  release: string;
  jiraKey: string;
  target: string;
  mode: string;
  currentRelease?: string | null;
  transport?: { roleArn?: string; ssmNodeId?: string; environmentReviewers?: number } | null;
};
type Ledger = {
  mode: string;
  outcome: string;
  release: { tag: string; sha: string | null };
  images: Record<string, { digest: string; ref: string }>;
  plan: {
    steps: { step: string; status: string }[];
    grants: string[];
    catchups: string[];
    migrations: {
      targetCount: number;
      added: string[] | null;
      removed: string[] | null;
      changed: string[] | null;
      rollback: { allowed: boolean };
    } | null;
  };
  gates: { environment: { status: string }; transport: { status: string } };
  pendingApprovals: string[];
  failureBoundary: string | null;
  refusals: string[];
};
type Helper = {
  REQUIRED_CHECKS: string[];
  SIGNER_WORKFLOW: string;
  evaluate: (dir: string, ctx: Ctx) => { refusals: string[]; ledger: Ledger };
  assessRollback: (added: string[], removed: string[]) => { allowed: boolean; reason: string };
  checkTransport: (identity: Ctx["transport"]) => string[];
  renderSummary: (ledger: Ledger) => string;
  main: (argv: string[]) => number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const helper = require(resolve(repoRoot, "deploy/lab/verify-release.cjs")) as Helper;

// ---------------------------------------------------------------- workflow

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { if?: string; environment?: unknown; permissions?: Record<string, string>; steps: Step[] };
type Input = { required?: boolean; type?: string; default?: unknown; options?: string[] };
type Workflow = {
  on: Record<string, { inputs: Record<string, Input> }>;
  permissions: unknown;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
};

const workflowText = read(".github/workflows/deploy-lab.yml");
const workflow = yaml.load(workflowText) as Workflow;
const jobs = Object.entries(workflow.jobs);
const allSteps = jobs.flatMap(([, job]) => job.steps);
const scripts = allSteps.map((s) => s.run ?? "").join("\n");
function stepIndex(prefix: string): number {
  const i = allSteps.findIndex((s) => (s.name ?? "").startsWith(prefix));
  if (i < 0) throw new Error(`workflow step missing: ${prefix}`);
  return i;
}
function stepNamed(prefix: string): Step & { id?: string } {
  const found = allSteps.find((s) => (s.name ?? "").startsWith(prefix));
  if (!found) throw new Error(`workflow step missing: ${prefix}`);
  return found;
}

describe("deploy-lab workflow", () => {
  it("is manual only, with release, Jira key, lab-01 target and a dry run that defaults on", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
    expect(inputs.backend_release).toMatchObject({ required: true, type: "string" });
    expect(inputs.jira_key).toMatchObject({ required: true, type: "string" });
    expect(inputs.target).toMatchObject({ type: "choice", options: ["lab-01"] });
    expect(inputs.current_release).toMatchObject({ required: false, type: "string" });
    expect(inputs.dry_run).toMatchObject({ type: "boolean", default: true });
  });

  it("holds one run at a time without cancelling a running one", () => {
    expect(workflow.concurrency).toEqual({ group: "deploy-aws-lab", "cancel-in-progress": false });
  });

  it("grants nothing at the top level and only read scopes to jobs: no id-token, no writes", () => {
    expect(workflow.permissions).toEqual({});
    for (const [, job] of jobs) {
      expect(job.permissions).toBeDefined();
      expect(Object.values(job.permissions ?? {}).every((v) => v === "read")).toBe(true);
      expect(job.permissions).not.toHaveProperty("id-token");
    }
    expect(workflowText).not.toMatch(/id-token|:\s*write\b/);
  });

  it("references no GitHub Environment, which GitHub would otherwise create unprotected", () => {
    for (const [, job] of jobs) expect(job).not.toHaveProperty("environment");
  });

  it("guards first: main ref, validated inputs, and refuses dry_run=false", () => {
    for (const [, job] of jobs) {
      expect(job.if).toBeUndefined();
      const guard = job.steps[0];
      expect(guard?.name).toMatch(/^Guard/);
      expect(guard?.env?.RUN_REF).toBe("${{ github.ref }}");
      const run = guard?.run ?? "";
      expect(run).toContain('"$RUN_REF" = "refs/heads/main"');
      expect(run).toContain("^backend-core-[0-9a-f]{12}$");
      expect(run).toContain("^RT-[1-9][0-9]*$");
      expect(run).toContain('[ "$TARGET" = "lab-01" ]');
      expect(run).toContain('[ "$DRY_RUN" = "true" ] || fail "live deploy not enabled');
    }
  });

  it("pins every action to a commit SHA and checks out main without credentials or a ref", () => {
    const uses = allSteps.map((s) => s.uses).filter((u): u is string => typeof u === "string");
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    for (const step of allSteps.filter((s) => s.uses?.startsWith("actions/checkout@"))) {
      expect(step.with?.["persist-credentials"]).toBe(false);
      expect(step.with).not.toHaveProperty("ref");
    }
  });

  it("never interpolates expressions inside run scripts (inputs reach the shell via env only)", () => {
    for (const step of allSteps) if (step.run !== undefined) expect(step.run).not.toContain("${{");
  });

  it("uses no secret but the read-only GITHUB_TOKEN", () => {
    const secrets = [...workflowText.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect(secrets.length).toBeGreaterThan(0);
    expect(new Set(secrets)).toEqual(new Set(["GITHUB_TOKEN"]));
  });

  it("deploys nothing: no AWS, SSH, SSM, remote execution, compose or image pulls", () => {
    for (const step of allSteps) {
      expect(step.uses ?? "").not.toMatch(/aws|ssh|deploy|kubectl|appleboy/i);
      // command words only: "aws-lab" (the environment name) is not the aws CLI
      expect(step.run ?? "").not.toMatch(/(^|[\s;&|(])(aws|ssh|scp|ssm|kubectl|appleboy)\s/im);
      expect(step.run ?? "").not.toMatch(/docker\s+(compose|pull|run|push)|compose\s+up|send-command/i);
    }
    expect(workflowText).not.toMatch(/latest/i);
  });

  it("verifies the checksums before unpacking, and every image attestation against main and the release SHA", () => {
    expect(scripts.indexOf("sha256sum --check --strict SHA256SUMS")).toBeGreaterThan(-1);
    expect(scripts.indexOf("sha256sum --check --strict SHA256SUMS")).toBeLessThan(scripts.indexOf("tar -xzf"));
    expect(scripts).toContain("for TARGET in api worker migrate; do");
    expect(scripts).toContain('--signer-workflow "$REPO/.github/workflows/release-images.yml"');
    expect(scripts).toContain('--source-digest "$SHA"');
    expect(scripts).toContain("--source-ref refs/heads/main");
    expect(scripts).toContain('compare/$SHA...main');
  });

  it("decides in the verifier, in dry-run mode, and always publishes the ledger", () => {
    expect(scripts).toContain("node deploy/lab/verify-release.cjs");
    expect(scripts).toContain("--mode dry-run");
    expect(scripts).not.toContain("--mode live");
    const upload = allSteps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe("always()");
  });

  it("runs every shell step with set -euo pipefail, paginates check runs and fetches full history", () => {
    for (const step of allSteps) if (step.run !== undefined) expect(step.run.trimStart()).toMatch(/^set -euo pipefail\n/);
    expect(scripts).toContain("gh api --paginate");
    const checkout = allSteps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  it("only unpacks a tarball covered by SHA256SUMS that holds plain files under one directory", () => {
    const at = (needle: string): number => {
      const i = scripts.indexOf(needle);
      expect({ needle, found: i > -1 }).toEqual({ needle, found: true });
      return i;
    };
    const extract = at("tar -xzf");
    expect(at("SHA256SUMS does not cover")).toBeLessThan(extract);
    expect(at("sha256sum --check --strict")).toBeLessThan(extract);
    expect(at('[[ "$TYPES" =~ ^[-d]+$ ]]')).toBeLessThan(extract);
    expect(at('case "$ENTRY" in "$BUNDLE"/*)')).toBeLessThan(extract);
    expect(at("unsafe bundle entry path")).toBeLessThan(extract);
    expect(at('refs/tags/$BACKEND_RELEASE^{commit}')).toBeGreaterThan(-1);
  });

  it("records early collection stops as evidence and still runs the verifier, but never after a failed guard", () => {
    const collect = String(stepNamed("Collect release evidence").run);
    expect(collect).toContain('echo "$*" >> "$EVIDENCE/collect-error.txt"; exit 1; }');
    expect(collect).toMatch(/trap '.*collect-error\.txt"' ERR/);
    expect(collect).toContain('|| fail "release assets do not match SHA256SUMS"');
    expect(stepNamed("Verify evidence").if).toBe(
      "${{ !cancelled() && steps.guard.outcome == 'success' && steps.checkout.outcome == 'success' && steps.logout.outcome == 'success' }}",
    );
    expect(stepNamed("Guard")).toMatchObject({ id: "guard" });
    expect(stepNamed("Checkout main")).toMatchObject({ id: "checkout" });
  });

  it("records migration blob IDs, not only names, for the target and current releases", () => {
    const collect = String(stepNamed("Collect release evidence").run);
    expect(collect).toContain('git ls-tree "$SHA" packages/db/drizzle/ > "$EVIDENCE/migrations-target.txt"');
    expect(collect).toContain('git ls-tree "$CURRENT_SHA" packages/db/drizzle/ > "$EVIDENCE/migrations-current.txt"');
    expect(collect).not.toContain("ls-tree --name-only");
  });

  it("logs out of GHCR however collection ended, and verifies only after a successful logout", () => {
    const order = ["Collect release evidence", "Log out of GHCR", "Verify evidence"].map(stepIndex);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const logout = stepNamed("Log out of GHCR");
    expect(logout).toMatchObject({ id: "logout", if: "always()" });
    expect(logout.run).toContain("docker logout ghcr.io");
    expect(stepNamed("Verify evidence").if).toContain("steps.logout.outcome == 'success'");
  });

  it("records the release commit's tree so bundled files can be bound to it", () => {
    expect(String(stepNamed("Collect release evidence").run)).toContain('git -c core.autocrlf=false archive --format=tar "$SHA" | tar -x -C "$EVIDENCE/source"');
  });

  it("requires the same CI checks as the image release workflow", () => {
    const release = yaml.load(read(".github/workflows/release-images.yml")) as Workflow;
    const env = (release.jobs.guard?.steps ?? []).map((s) => s.env?.REQUIRED_CHECKS ?? "").join("");
    expect(helper.REQUIRED_CHECKS).toEqual(JSON.parse(env));
  });
});

// ---------------------------------------------------------------- verifier

const SHA = "1711813df1f36d7ed60db1096f9a23c2be1e81c3";
const OLD_SHA = "ff9e68331415c29aa21ba3ece6af3e2f62b22646";
const TAG = `backend-core-${SHA.slice(0, 12)}`;
const OLD_TAG = `backend-core-${OLD_SHA.slice(0, 12)}`;
const BUNDLE = `backend-core-release-${SHA.slice(0, 12)}`;
const DIGESTS: Record<string, string> = {
  api: `sha256:${"a".repeat(64)}`,
  worker: `sha256:${"b".repeat(64)}`,
  migrate: `sha256:${"c".repeat(64)}`,
};
const ref = (target: string): string => `ghcr.io/kemetra/backend-core-${target}@${DIGESTS[target] ?? ""}`;
const hash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ release: TAG, jiraKey: "RT-703", target: "lab-01", mode: "dry-run", ...over });

const MIGRATIONS = [
  "packages/db/drizzle/0001_init.down.sql",
  "packages/db/drizzle/0001_init.sql",
  "packages/db/drizzle/0002_sales.down.sql",
  "packages/db/drizzle/0002_sales.sql",
  "packages/db/drizzle/meta",
];
const UP = MIGRATIONS.filter((m) => m.endsWith(".sql") && !m.endsWith(".down.sql"));
/** `git ls-tree <sha> packages/db/drizzle/` output; a blob ID is derived from the path unless overridden. */
const lsTree = (paths: string[], blobs: Record<string, string> = {}): string =>
  paths
    .map((p) => {
      const type = p.endsWith(".sql") ? "100644 blob" : "040000 tree";
      const blob = blobs[p] ?? createHash("sha256").update(p).digest("hex").slice(0, 40);
      return `${type} ${blob}\t${p}`;
    })
    .join("\n");

let dir: string;

function put(rel: string, content: string | Buffer): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
const putJson = (rel: string, value: unknown): void => put(rel, JSON.stringify(value));
const sums = (entries: Record<string, string | Buffer>): string =>
  Object.entries(entries).map(([name, content]) => `${hash(content)}  ${name}\n`).join("");

function attestation(target: string, over: Record<string, string> = {}): unknown {
  return [
    {
      verificationResult: {
        statement: {
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [{ digest: { sha256: (DIGESTS[target] ?? "").slice(7) } }],
        },
        signature: {
          certificate: {
            sourceRepositoryDigest: SHA,
            sourceRepositoryRef: "refs/heads/main",
            buildSignerURI: helper.SIGNER_WORKFLOW,
            ...over,
          },
        },
      },
    },
  ];
}

function bundleFiles(): Record<string, string> {
  return {
    "docker-compose.release.yml": "services: {}\n",
    "docs/operations/sql/cashier-admissions-domain-grants.sql": "select 1;\n",
    "docs/operations/sql/erpnext-posting-resolution-catchup.sql": "select 2;\n",
    "release.env": `# Release ${SHA}.\nDP2_MIGRATE_IMAGE=${ref("migrate")}\nDP2_API_IMAGE=${ref("api")}\nDP2_WORKER_IMAGE=${ref("worker")}\n`,
  };
}

function manifest(files: Record<string, string>): Record<string, unknown> {
  const image = (t: string) => ({ repository: `ghcr.io/kemetra/backend-core-${t}`, tag: `sha-${SHA}`, digest: DIGESTS[t], ref: ref(t) });
  return {
    schemaVersion: 1,
    repository: "Kemetra/Backend-Core",
    sha: SHA,
    releaseTag: TAG,
    published: true,
    digestKind: "registry-manifest-digest",
    createdAt: "2026-10-18T12:59:25Z",
    images: { api: image("api"), worker: image("worker"), migrate: image("migrate") },
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hash(content)])),
  };
}

/** Writes the release assets and the extracted bundle; returns the manifest text. */
function writeRelease(files: Record<string, string>, m: Record<string, unknown> = manifest(files)): string {
  const manifestText = JSON.stringify(m, null, 2);
  for (const [name, content] of Object.entries(files)) put(`bundle/${BUNDLE}/${name}`, content);
  put(`bundle/${BUNDLE}/release-manifest.json`, manifestText);
  put(`bundle/${BUNDLE}/SHA256SUMS`, sums({ ...files, "release-manifest.json": manifestText }));
  const tarball = Buffer.from("not really a tarball");
  put(`release/${BUNDLE}.tar.gz`, tarball);
  put("release/release-manifest.json", manifestText);
  put("release/SHA256SUMS", sums({ [`${BUNDLE}.tar.gz`]: tarball, "release-manifest.json": manifestText }));
  return manifestText;
}

/** Evidence for a release that passes every check. */
function writeGoodEvidence(): void {
  putJson("release.json", { tagName: TAG, targetCommitish: SHA, isDraft: false, isPrerelease: false, isImmutable: true });
  put("tag-commit.txt", `${SHA}\n`);
  writeRelease(bundleFiles());
  putJson("compare.json", { status: "ahead", ahead_by: 3, behind_by: 0, merge_base: SHA });
  putJson(
    "check-runs.json",
    helper.REQUIRED_CHECKS.map((name) => ({ name, conclusion: "success", slug: "github-actions", started_at: "2026-10-18T10:00:00Z" })),
  );
  for (const t of ["api", "worker", "migrate"]) putJson(`attest-${t}.json`, attestation(t));
  put("migrations-target.txt", lsTree(MIGRATIONS));
  writeSource(bundleFiles());
  putJson("environment.json", { status: "not-visible", reviewers: 0 });
}

/** `git archive <sha>` of the release commit: every shipped file except the generated release.env. */
function writeSource(files: Record<string, string>): void {
  rmSync(join(dir, "source"), { recursive: true, force: true });
  for (const [name, content] of Object.entries(files)) if (name !== "release.env") put(`source/${name}`, content);
  put("source/unrelated/file.ts", "export {};\n");
}

function writeCurrent(migrations: string[], blobs: Record<string, string> = {}): void {
  putJson("current-release.json", { tagName: OLD_TAG, targetCommitish: OLD_SHA, isDraft: false, isPrerelease: false, isImmutable: true });
  put("current-tag-commit.txt", `${OLD_SHA}\n`);
  putJson("compare-current.json", { status: "ahead", ahead_by: 9, behind_by: 0, merge_base: OLD_SHA });
  put("migrations-current.txt", lsTree(migrations, blobs));
}

const refusalsOf = (c: Ctx = ctx()): string[] => helper.evaluate(dir, c).refusals;
const expectRefused = (pattern: RegExp, c: Ctx = ctx()): void => {
  expect(refusalsOf(c)).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
};

beforeEach(() => {
  // the CLI reports one outcome line; keep test output clean
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  dir = mkdtempSync(join(tmpdir(), "rt703-evidence-"));
  writeGoodEvidence();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("verify-release: a good release", () => {
  it("passes every check and plans, without running, the full live sequence", () => {
    const { refusals, ledger } = helper.evaluate(dir, ctx());
    expect(refusals).toEqual([]);
    expect(ledger.outcome).toBe("planned");
    expect(ledger.mode).toBe("dry-run");
    expect(ledger.release).toEqual({ tag: TAG, sha: SHA });
    expect(Object.fromEntries(Object.entries(ledger.images).map(([t, i]) => [t, i.ref]))).toEqual({
      api: ref("api"),
      worker: ref("worker"),
      migrate: ref("migrate"),
    });
    expect(ledger.plan.steps).toHaveLength(8);
    expect(ledger.plan.steps.every((s) => s.status.startsWith("not-run"))).toBe(true);
    expect(ledger.plan.grants).toEqual(["docs/operations/sql/cashier-admissions-domain-grants.sql"]);
    expect(ledger.plan.catchups).toEqual(["docs/operations/sql/erpnext-posting-resolution-catchup.sql"]);
    expect(ledger.plan.migrations?.targetCount).toBe(2);
    expect(ledger.gates.transport.status).toBe("not-provisioned");
    expect(ledger.pendingApprovals.join("\n")).toMatch(/aws-lab environment/);
    expect(ledger.failureBoundary).toBeNull();
  });

  it("accepts an older release that is still reachable from main", () => {
    putJson("compare.json", { status: "identical", ahead_by: 0, behind_by: 0, merge_base: SHA });
    expect(refusalsOf()).toEqual([]);
  });

  it("writes ledger.json and summary.md and exits 0 from the CLI", () => {
    const out = join(dir, "out");
    const argv = ["--evidence", dir, "--out", out, "--release", TAG, "--jira-key", "RT-703", "--target", "lab-01", "--mode", "dry-run", "--current-release", ""];
    expect(helper.main(argv)).toBe(0);
    const ledger = JSON.parse(readFileSync(join(out, "ledger.json"), "utf8")) as Ledger;
    expect(ledger.outcome).toBe("planned");
    expect(readFileSync(join(out, "summary.md"), "utf8")).toContain("Nothing was deployed.");
  });

  it("exits 1 with a refused ledger, and 2 on a usage error", () => {
    putJson("compare.json", { status: "diverged", ahead_by: 1, behind_by: 1, merge_base: OLD_SHA });
    const out = join(dir, "out");
    expect(helper.main(["--evidence", dir, "--out", out, "--release", TAG, "--jira-key", "RT-703", "--target", "lab-01", "--mode", "dry-run"])).toBe(1);
    const ledger = JSON.parse(readFileSync(join(out, "ledger.json"), "utf8")) as Ledger;
    expect(ledger.outcome).toBe("refused");
    expect(ledger.failureBoundary).toMatch(/not reachable from main/);
    expect(helper.renderSummary(ledger)).toContain("### Refused");
    expect(helper.main(["--evidence", dir])).toBe(2);
  });
});

describe("verify-release: refusals", () => {
  it.each([
    [{ release: "backend-core-latest" }, /backend_release must be/],
    [{ jiraKey: "703" }, /jira_key must be/],
    [{ target: "lab-02" }, /target must be one of/],
    [{ currentRelease: "main" }, /current_release must be/],
    [{ mode: "apply" }, /mode must be/],
  ])("refuses bad input %o", (over, pattern) => expectRefused(pattern, ctx(over as Partial<Ctx>)));

  it.each([
    [{ isImmutable: false }, /not an immutable release/],
    [{ isDraft: true }, /draft or prerelease/],
    [{ targetCommitish: OLD_SHA }, /tag does not match its commit/],
    [{ targetCommitish: "main" }, /not a 40-hex commit SHA/],
  ])("refuses release metadata %o", (over, pattern) => {
    putJson("release.json", { tagName: TAG, targetCommitish: SHA, isDraft: false, isPrerelease: false, isImmutable: true, ...over });
    expectRefused(pattern);
  });

  it.each([
    [{ status: "behind", ahead_by: 0, behind_by: 2, merge_base: OLD_SHA }, /not reachable from main/],
    [{ status: "diverged", ahead_by: 1, behind_by: 1, merge_base: OLD_SHA }, /commit\(s\) that are not on main/],
    [{ status: "ahead", ahead_by: 1, behind_by: 0, merge_base: OLD_SHA }, /merge base/],
  ])("refuses unverified ancestry %o", (cmp, pattern) => {
    putJson("compare.json", cmp);
    expectRefused(pattern);
  });

  it("refuses when ancestry or CI evidence is missing", () => {
    rmSync(join(dir, "compare.json"));
    rmSync(join(dir, "check-runs.json"));
    expectRefused(/ancestry evidence missing/);
    expectRefused(/CI check-run evidence missing/);
  });

  it("refuses a missing or failed required check, judging only the latest github-actions run", () => {
    const [fast, db] = helper.REQUIRED_CHECKS;
    putJson("check-runs.json", [
      { name: fast, conclusion: "success", slug: "github-actions", started_at: "2026-10-18T09:00:00Z" },
      { name: fast, conclusion: "failure", slug: "github-actions", started_at: "2026-10-18T10:00:00Z" },
      { name: db, conclusion: "success", slug: "some-other-app", started_at: "2026-10-18T10:00:00Z" },
    ]);
    expect(refusalsOf()).toContain(`required check '${fast ?? ""}' is 'failure' on the release SHA`);
    expectRefused(/db-integration .* is 'missing'/);
  });

  it("refuses a missing, tampered or padded release SHA256SUMS", () => {
    rmSync(join(dir, "release/SHA256SUMS"));
    expectRefused(/release SHA256SUMS missing/);
    writeRelease(bundleFiles());
    put(`release/${BUNDLE}.tar.gz`, "swapped tarball");
    expectRefused(/release SHA256SUMS: checksum mismatch for 'backend-core-release-/);
    writeRelease(bundleFiles());
    put("release/SHA256SUMS", `${readFileSync(join(dir, "release/SHA256SUMS"), "utf8")}${"0".repeat(64)}  extra.txt\n`);
    expectRefused(/release SHA256SUMS lists/);
  });

  it.each([
    [{ published: false, digestKind: "local-image-id" }, /not a published release/],
    [{ digestKind: "local-image-id" }, /not registry digests/],
    [{ sha: OLD_SHA }, /is not the release commit/],
    [{ schemaVersion: 2 }, /schemaVersion is 2/],
  ])("refuses a manifest with %o", (over, pattern) => {
    const files = bundleFiles();
    writeRelease(files, { ...manifest(files), ...over });
    expectRefused(pattern);
  });

  it.each([
    ["a malformed digest", { digest: "sha256:xyz" }, /api image is missing or not a digest ref/],
    ["a ref that is not the digest", { ref: "ghcr.io/kemetra/backend-core-api:latest" }, /api image is missing|latest/],
    ["a floating tag", { tag: "latest" }, /latest/],
    ["another commit's tag", { tag: `sha-${OLD_SHA}` }, /api image is missing or not a digest ref/],
  ])("refuses an api image with %s", (_label, over, pattern) => {
    const files = bundleFiles();
    const m = manifest(files);
    const images = m.images as Record<string, Record<string, unknown>>;
    writeRelease(files, { ...m, images: { ...images, api: { ...images.api, ...over } } });
    expectRefused(pattern);
  });

  it("refuses a bundle whose release.env does not match the manifest", () => {
    const files = { ...bundleFiles(), "release.env": `DP2_MIGRATE_IMAGE=${ref("migrate")}\nDP2_API_IMAGE=${ref("worker")}\nDP2_WORKER_IMAGE=${ref("worker")}\nEXTRA=1\n` };
    writeRelease(files);
    expectRefused(/release.env DP2_API_IMAGE does not match/);
    expectRefused(/unexpected variable 'EXTRA'/);
  });

  it("refuses a bundle file that no longer matches its checksums", () => {
    put(`bundle/${BUNDLE}/docs/operations/sql/cashier-admissions-domain-grants.sql`, "grant all;\n");
    expectRefused(/bundle SHA256SUMS: checksum mismatch/);
    expectRefused(/manifest file hash mismatch for 'docs\/operations\/sql\/cashier-admissions-domain-grants.sql'/);
  });

  it("refuses a bundle manifest that differs from the release asset, or an unsafe checksum path", () => {
    put(`bundle/${BUNDLE}/release-manifest.json`, "{}");
    expectRefused(/bundle release-manifest.json differs/);
    put(`bundle/${BUNDLE}/SHA256SUMS`, `${"0".repeat(64)}  ../escape.sql\n`);
    expectRefused(/unsafe path '..\/escape.sql'/);
  });

  it("refuses a missing extracted bundle", () => {
    rmSync(join(dir, "bundle"), { recursive: true });
    expectRefused(/extracted release bundle missing/);
  });

  it.each([
    ["no verified attestation", null, /no verified attestation for the worker image/],
    ["another source commit", { sourceRepositoryDigest: OLD_SHA }, /worker attestation does not bind/],
    ["another ref", { sourceRepositoryRef: "refs/heads/feature" }, /worker attestation does not bind/],
    ["another signer workflow", { buildSignerURI: "https://github.com/Kemetra/Backend-Core/.github/workflows/other.yml@refs/heads/main" }, /worker attestation does not bind/],
  ])("refuses the worker image with %s", (_label, over, pattern) => {
    if (over === null) rmSync(join(dir, "attest-worker.json"));
    else putJson("attest-worker.json", attestation("worker", over));
    expectRefused(pattern);
  });

  it("refuses an attestation for another image digest", () => {
    putJson("attest-migrate.json", attestation("api"));
    expectRefused(/migrate attestation does not bind/);
  });

  it("refuses a missing migration list", () => {
    rmSync(join(dir, "migrations-target.txt"));
    expectRefused(/target migration list missing/);
  });
});

describe("verify-release: current release, schema and rollback", () => {
  it("plans an app-only rollback when the schema is unchanged", () => {
    writeCurrent(MIGRATIONS);
    const { refusals, ledger } = helper.evaluate(dir, ctx({ currentRelease: OLD_TAG }));
    expect(refusals).toEqual([]);
    expect(ledger.plan.migrations).toMatchObject({ added: [], removed: [], rollback: { allowed: true } });
  });

  it("refuses rolling back past an added migration (no automatic database downgrade)", () => {
    writeCurrent(UP.slice(0, 1));
    const { refusals, ledger } = helper.evaluate(dir, ctx({ currentRelease: OLD_TAG }));
    expect(refusals).toEqual([]);
    expect(ledger.plan.migrations).toMatchObject({ added: ["0002_sales.sql"], rollback: { allowed: false } });
    expect(helper.assessRollback(["0002_sales.sql"], [])).toMatchObject({ allowed: false, reason: expect.stringMatching(/restore or forward-fix/) });
  });

  it("refuses an app-only rollback past a migration edited in place (same name, new content)", () => {
    writeCurrent(MIGRATIONS, { "packages/db/drizzle/0002_sales.sql": "f".repeat(40) });
    const { refusals, ledger } = helper.evaluate(dir, ctx({ currentRelease: OLD_TAG }));
    expect(refusals).toEqual([]);
    expect(ledger.plan.migrations).toMatchObject({ added: [], removed: [], changed: ["0002_sales.sql"], rollback: { allowed: false } });
  });

  it("refuses a migration list that is not git ls-tree output with blob IDs", () => {
    put("migrations-target.txt", MIGRATIONS.join("\n"));
    expectRefused(/target migration list missing, empty or not git ls-tree output/);
  });

  it("refuses deploying a release that lacks a migration the host already has", () => {
    writeCurrent([...MIGRATIONS, "packages/db/drizzle/0003_newer.sql"]);
    expectRefused(/schema downgrade is never automatic/, ctx({ currentRelease: OLD_TAG }));
  });

  it("refuses a current release that is not an immutable release with its evidence", () => {
    expectRefused(/current release metadata missing/, ctx({ currentRelease: OLD_TAG }));
    expectRefused(/current release migration list missing/, ctx({ currentRelease: OLD_TAG }));
  });

  it("still writes the summary when the current release evidence is missing", () => {
    const out = join(dir, "out");
    const argv = ["--evidence", dir, "--out", out, "--release", TAG, "--jira-key", "RT-703", "--target", "lab-01", "--mode", "dry-run", "--current-release", OLD_TAG];
    expect(helper.main(argv)).toBe(1);
    const summary = readFileSync(join(out, "summary.md"), "utf8");
    expect(summary).toContain("### Refused");
    expect(summary).toContain("no verified current release");
  });

  it("summarises the schema plan against a verified current release", () => {
    writeCurrent(UP.slice(0, 1));
    const { ledger } = helper.evaluate(dir, ctx({ currentRelease: OLD_TAG }));
    expect(helper.renderSummary(ledger)).toContain(`1 added and 0 edited in place since ${OLD_TAG} (operator-asserted, not host-verified)`);
  });
});

describe("verify-release: live mode and deployment identity", () => {
  it("refuses live mode without a deployment identity", () => {
    expectRefused(/no deployment identity/, ctx({ mode: "live" }));
    expectRefused(/live execution is not implemented/, ctx({ mode: "live" }));
  });

  it.each([
    ["the account root", { roleArn: "arn:aws:iam::431988153035:root", ssmNodeId: `mi-${"0".repeat(17)}`, environmentReviewers: 1 }, /IAM role ARN/],
    ["an IAM user", { roleArn: "arn:aws:iam::431988153035:user/deployer", ssmNodeId: `mi-${"0".repeat(17)}`, environmentReviewers: 1 }, /IAM role ARN/],
    ["an unregistered host", { roleArn: "arn:aws:iam::431988153035:role/lab-deploy", ssmNodeId: "i-0123", environmentReviewers: 1 }, /SSM managed node/],
    ["no required reviewer", { roleArn: "arn:aws:iam::431988153035:role/lab-deploy", ssmNodeId: `mi-${"0".repeat(17)}`, environmentReviewers: 0 }, /required reviewer|at least one reviewer/],
  ])("refuses a deployment identity using %s", (_label, identity, pattern) => {
    expect(helper.checkTransport(identity)).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
  });

  it("still refuses live mode with a well-formed identity, because slice 1 has no live path", () => {
    const transport = { roleArn: "arn:aws:iam::431988153035:role/lab-deploy", ssmNodeId: `mi-${"0".repeat(17)}`, environmentReviewers: 1 };
    expect(helper.checkTransport(transport)).toEqual([]);
    expect(refusalsOf(ctx({ mode: "live", transport }))).toEqual(["live execution is not implemented in RT-703 slice 1 (dry run only)"]);
  });
});

describe("verify-release: review hardening", () => {
  it("refuses a git tag that does not point at the release commit, or a missing tag", () => {
    put("tag-commit.txt", `${OLD_SHA}\n`);
    expectRefused(/release git tag does not point at/);
    rmSync(join(dir, "tag-commit.txt"));
    expectRefused(/release git tag does not point at .*resolves to 'nothing'/);
  });

  it("refuses release metadata for another tag, or no release metadata at all", () => {
    putJson("release.json", { tagName: OLD_TAG, targetCommitish: SHA, isDraft: false, isPrerelease: false, isImmutable: true });
    expectRefused(/release tag is 'backend-core-ff9e68331415'/);
    rmSync(join(dir, "release.json"));
    expectRefused(/release metadata missing or not JSON/);
  });

  it("refuses an ahead compare that still reports commits off main", () => {
    putJson("compare.json", { status: "ahead", ahead_by: 2, behind_by: 1, merge_base: SHA });
    expectRefused(/1 commit\(s\) that are not on main/);
  });

  it("accepts a newer success after an older failure (latest run wins)", () => {
    const runs = helper.REQUIRED_CHECKS.flatMap((name) => [
      { name, conclusion: "failure", slug: "github-actions", started_at: "2026-10-18T09:00:00Z" },
      { name, conclusion: "success", slug: "github-actions", started_at: "2026-10-18T10:00:00Z" },
    ]);
    putJson("check-runs.json", runs);
    expect(refusalsOf()).toEqual([]);
  });

  it("puts an early collection stop first in the ledger, so a checksum refusal is still recorded", () => {
    put("collect-error.txt", "release assets do not match SHA256SUMS\n");
    rmSync(join(dir, "bundle"), { recursive: true });
    const { refusals, ledger } = helper.evaluate(dir, ctx());
    expect(refusals[0]).toBe("evidence collection refused: release assets do not match SHA256SUMS");
    expect(ledger.outcome).toBe("refused");
    expect(ledger.failureBoundary).toBe(refusals[0]);
    expect(helper.renderSummary(ledger)).toContain("evidence collection refused: release assets do not match SHA256SUMS");
  });

  it("refuses a bundled file that differs from the release commit, even with self-consistent hashes", () => {
    writeRelease({ ...bundleFiles(), "docker-compose.release.yml": "services: { injected: {} }\n" });
    expectRefused(/bundled 'docker-compose.release.yml' does not match the release commit/);
  });

  it("refuses a bundled file that is not in the release commit, or missing source evidence", () => {
    writeSource({ "docker-compose.release.yml": bundleFiles()["docker-compose.release.yml"] ?? "" });
    expectRefused(/bundled 'docs\/operations\/sql\/cashier-admissions-domain-grants.sql' is not in the release commit/);
    rmSync(join(dir, "source"), { recursive: true });
    expectRefused(/release source evidence missing/);
  });

  it("refuses a duplicate SHA256SUMS entry", () => {
    const sumsFile = join(dir, "release/SHA256SUMS");
    const first = readFileSync(sumsFile, "utf8").split("\n")[0] ?? "";
    put("release/SHA256SUMS", `${readFileSync(sumsFile, "utf8")}${first}\n`);
    expectRefused(/release SHA256SUMS: duplicate entry/);
  });

  it.each([
    ["repository", { repository: "Kemetra/Other" }, /manifest repository is 'Kemetra\/Other'/],
    ["releaseTag", { releaseTag: OLD_TAG }, /manifest releaseTag 'backend-core-ff9e68331415'/],
  ])("refuses a manifest with another %s", (_label, over, pattern) => {
    const files = bundleFiles();
    writeRelease(files, { ...manifest(files), ...over });
    expectRefused(pattern);
  });

  it("refuses a manifest that is not JSON", () => {
    put("release/release-manifest.json", "not json");
    expectRefused(/release manifest missing or not JSON/);
  });

  it("refuses a manifest whose file list leaves out release.env", () => {
    const files = bundleFiles();
    const { "release.env": _env, ...listed } = files;
    const m = manifest(listed);
    writeRelease(files, m);
    // release.env is still on disk, but neither listed nor hashed
    expectRefused(/manifest file list does not include release.env/);
    expectRefused(/bundle has an unlisted file 'release.env'/);
  });

  it("refuses an unlisted file in the extracted bundle", () => {
    put(`bundle/${BUNDLE}/docs/operations/sql/extra-domain-grants.sql`, "grant all;\n");
    expectRefused(/bundle has an unlisted file 'docs\/operations\/sql\/extra-domain-grants.sql'/);
  });

  it("refuses a bundle entry that is not a regular file, and never reads through it", () => {
    rmSync(join(dir, `bundle/${BUNDLE}/release.env`));
    mkdirSync(join(dir, `bundle/${BUNDLE}/release.env`));
    expectRefused(/'release.env' missing or not a regular file/);
    expectRefused(/bundle release.env missing or not a regular file/);
  });

  // Creating a symlink needs privileges on Windows; CI (Linux) always runs this case.
  const itWithSymlinks = process.platform === "win32" ? it.skip : it;
  itWithSymlinks("refuses a symlink in the bundle instead of following it", () => {
    put("secret.json", '{"auths":{"ghcr.io":{"auth":"c2VjcmV0"}}}');
    rmSync(join(dir, `bundle/${BUNDLE}/release.env`));
    symlinkSync(join(dir, "secret.json"), join(dir, `bundle/${BUNDLE}/release.env`));
    const refusals = refusalsOf();
    expect(refusals).toEqual(expect.arrayContaining([expect.stringMatching(/bundle entry 'release.env' is not a regular file/)]));
    expect(refusals.join("\n")).not.toContain("c2VjcmV0");
  });

  it("never echoes a raw release.env line that is not KEY=value", () => {
    const files = { ...bundleFiles(), "release.env": `${bundleFiles()["release.env"]}{"auths":{"ghcr.io":{"auth":"c2VjcmV0"}}}\n` };
    writeRelease(files);
    const refusals = refusalsOf();
    expect(refusals).toContain("release.env has a line that is not an expected KEY=value");
    expect(refusals.join("\n")).not.toContain("c2VjcmV0");
  });

  it.each([
    ["an empty result", []],
    ["a non-SLSA predicate", [{ verificationResult: { statement: { predicateType: "https://example.test/other", subject: [{ digest: { sha256: "c".repeat(64) } }] }, signature: { certificate: { sourceRepositoryDigest: SHA, sourceRepositoryRef: "refs/heads/main", buildSignerURI: helper.SIGNER_WORKFLOW } } } }]],
  ])("refuses an attestation with %s", (_label, value) => {
    putJson("attest-migrate.json", value);
    expectRefused(/(no verified attestation for the migrate image|migrate attestation does not bind)/);
  });

  it("counts only forward migrations, not their .down.sql companions", () => {
    expect(helper.evaluate(dir, ctx()).ledger.plan.migrations?.targetCount).toBe(UP.length);
  });

  it("refuses a current release that is not reachable from main or whose tag moved", () => {
    writeCurrent(MIGRATIONS);
    putJson("compare-current.json", { status: "diverged", ahead_by: 1, behind_by: 4, merge_base: SHA });
    put("current-tag-commit.txt", `${SHA}\n`);
    const c = ctx({ currentRelease: OLD_TAG });
    expectRefused(/current release SHA is not reachable from main/, c);
    expectRefused(/current release git tag does not point at/, c);
    // an unverified current release never feeds the rollback plan
    expect(helper.evaluate(dir, c).ledger.plan.migrations?.added).toBeNull();
  });

  it("escapes release-derived text in the Markdown summary", () => {
    put("release/release-manifest.json", JSON.stringify({ repository: "[click](https://evil.test) <img src=x> | ![x](y)" }));
    const summary = helper.renderSummary(helper.evaluate(dir, ctx()).ledger);
    expect(summary).not.toMatch(/(^|[^\\])\[click\]/);
    expect(summary).not.toMatch(/(^|[^\\])<img/);
    expect(summary).toContain("\\[click\\]\\(https://evil.test\\)");
  });
});
