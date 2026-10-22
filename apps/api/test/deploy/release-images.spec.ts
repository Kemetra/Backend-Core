/**
 * RT-533 — the manual image-release workflow, its digest-pinned compose
 * override and the bundle allowlist. Static checks only (no bash, no Docker):
 * they keep the safety properties of the release path from drifting. The
 * workflow itself is exercised by a dry run on GitHub Actions.
 */
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import * as yaml from "js-yaml";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
// Normalise CRLF so checkouts with core.autocrlf behave like CI.
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");

const RESET = Symbol("compose !reset");
const composeSchema = yaml.DEFAULT_SCHEMA.extend(
  new yaml.Type("!reset", { kind: "scalar", construct: () => RESET }),
);

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { if?: string; needs?: unknown; permissions?: Record<string, string>; steps: Step[] };
type Workflow = { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Job> };

const workflowText = read(".github/workflows/release-images.yml");
const workflow = yaml.load(workflowText) as Workflow;
function job(name: string): Job {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`workflow job missing: ${name}`);
  return found;
}
const jobs = Object.entries(workflow.jobs);
const allSteps = jobs.flatMap(([jobName, job]) => job.steps.map((step) => ({ jobName, job, step })));

const usesAction = (s: Step, action: string): boolean => (s.uses ?? "").startsWith(`${action}@`);
const isPush = (s: Step): boolean => usesAction(s, "docker/build-push-action") && s.with?.push === true;
const isPublication = (s: Step): boolean =>
  usesAction(s, "actions/attest-build-provenance") || isPush(s) || /gh release create/.test(s.run ?? "");
const labelsOf = (s: Step): string => String(s.with?.labels);

/** A dry-run step must never push, log in for a push, attest or write a release. */
function expectNoPublication(step: Step): void {
  expect(step.uses ?? "").not.toMatch(/attest-build-provenance|docker\/login-action/);
  expect(step.with?.push).not.toBe(true);
  expect(step.run ?? "").not.toMatch(/gh release|docker push/);
}

describe("release-images workflow", () => {
  it("is manual only, with a full-SHA input and a publish switch that defaults to a dry run", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const inputs = (workflow.on.workflow_dispatch as { inputs: Record<string, Record<string, unknown>> }).inputs;
    expect(inputs.sha).toMatchObject({ required: true, type: "string" });
    expect(inputs.publish).toMatchObject({ type: "boolean", default: false });
  });

  it("grants nothing at the top level and write scopes to the publish job only", () => {
    expect(workflow.permissions).toEqual({});
    for (const [name, job] of jobs) {
      expect(job.permissions).toBeDefined();
      const writes = Object.entries(job.permissions ?? {}).filter(([, v]) => v === "write");
      if (name === "publish") {
        expect(job.permissions).toMatchObject({
          contents: "write",
          packages: "write",
          "id-token": "write",
          attestations: "write",
        });
      } else {
        expect(writes).toEqual([]);
      }
    }
  });

  it("guards on the main ref, a 40-hex SHA equal to the dispatched commit and the main tip", () => {
    const guard = job("guard");
    // refused loudly by the first step, never skipped by a job-level `if`
    expect(guard.if).toBeUndefined();
    const script = guard.steps.map((s) => s.run ?? "").join("\n");
    expect(script).toContain('"$RUN_REF" = "refs/heads/main"');
    expect(script).toContain("^[0-9a-f]{40}$");
    expect(script).toContain('"$INPUT_SHA" = "$RUN_SHA"');
    expect(script).toContain("commits/main");
    expect(script).toContain('"$INPUT_SHA" = "$MAIN_TIP"');
  });

  it("requires the ci.yml jobs green on the exact SHA and fails closed when one is missing", () => {
    const script = job("guard").steps.map((s) => s.run ?? "").join("\n");
    const env = job("guard").steps.map((s) => s.env?.REQUIRED_CHECKS ?? "").join("");
    expect(JSON.parse(env)).toEqual([
      "fast (build + Docker-free tests)",
      "db-integration (Testcontainers + RLS + migrations)",
    ]);
    expect(script).toContain('"missing"');
    expect(script).toContain('[ "$RESULT" = "success" ]');
    expect(script).toContain("check-runs");
  });

  it("refuses an existing release, tag or GHCR image tag", () => {
    const script = job("guard").steps.map((s) => s.run ?? "").join("\n");
    expect(script).toContain("gh release view");
    expect(script).toContain("git/ref/tags/");
    expect(script).toContain("docker buildx imagetools inspect");
    expect(script).toContain("refusing to overwrite");
    expect(workflowText).not.toMatch(/--clobber|gh release upload/);
  });

  it("pins every action to a 40-hex commit SHA", () => {
    const uses = allSteps.map(({ step }) => step.uses).filter((u): u is string => typeof u === "string");
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    expect(workflowText).toMatch(/uses: \S+@[0-9a-f]{40} # v\d/);
    // checkout never keeps the token and never takes a ref from inputs or job
    // outputs: it checks out github.sha, which the guard proved is the verified SHA
    for (const { step } of allSteps.filter(({ step }) => step.uses?.startsWith("actions/checkout@"))) {
      expect(step.with?.["persist-credentials"]).toBe(false);
      expect(step.with).not.toHaveProperty("ref");
    }
  });

  it("never interpolates expressions inside run scripts (inputs reach the shell via env only)", () => {
    for (const { step } of allSteps) {
      if (step.run !== undefined) expect(step.run).not.toContain("${{");
    }
    expect(JSON.stringify(allSteps.map(({ step }) => step.run))).not.toMatch(/inputs\./);
  });

  it("uses only sha-<40hex> image tags, never a floating tag", () => {
    expect(workflowText).not.toMatch(/latest/i);
    const pushes = allSteps.map(({ step }) => step).filter(isPush);
    expect(pushes.map((step) => step.with?.target).sort()).toEqual(["api", "migrate", "worker"]);
    for (const step of pushes) {
      expect(step.with?.tags).toMatch(
        /^ghcr\.io\/kemetra\/backend-core-(api|worker|migrate):sha-\$\{\{ needs\.guard\.outputs\.sha \}\}$/,
      );
      expect(labelsOf(step)).toContain("org.opencontainers.image.revision=${{ needs.guard.outputs.sha }}");
      expect(labelsOf(step)).toContain("org.opencontainers.image.source=");
    }
  });

  it("builds every target without registry or GHA cache and without build args", () => {
    expect(workflowText).not.toMatch(/cache-from|cache-to|type=gha|type=registry/);
    const builds = allSteps.filter(({ step }) => step.uses?.startsWith("docker/build-push-action@"));
    expect(builds).toHaveLength(6);
    for (const { step } of builds) {
      expect(step.with?.["no-cache"]).toBe(true);
      expect(step.with).not.toHaveProperty("build-args");
      expect(step.with).not.toHaveProperty("secrets");
    }
  });

  it("keeps every publication step (push, login for push, attest, release) behind publish=true", () => {
    const publication = allSteps.filter(({ step }) => isPublication(step));
    expect(publication).toHaveLength(3 + 3 + 1);
    for (const { jobName, job } of publication) {
      expect(jobName).toBe("publish");
      expect(job.if).toBe("inputs.publish == true");
    }
    // the dry run can never push, attest or write a release
    const dry = job("dry-run");
    expect(dry.if).toBe("inputs.publish == false");
    expect(dry.permissions).toEqual({ contents: "read" });
    dry.steps.forEach(expectNoPublication);
  });

  it("verifies pushed digests and revision labels before attesting or releasing", () => {
    const steps = job("publish").steps;
    const verify = steps.findIndex((s) => s.name?.startsWith("Verify pushed digests"));
    const firstAttest = steps.findIndex((s) => s.uses?.startsWith("actions/attest-build-provenance@"));
    const release = steps.findIndex((s) => /gh release create/.test(s.run ?? ""));
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(firstAttest);
    expect(firstAttest).toBeLessThan(release);
    expect(steps[verify]?.run).toContain("org.opencontainers.image.revision");
    // registry digest read through the JSON formatter, then shape-checked
    expect(steps[verify]?.run).toContain("--format '{{json .Manifest}}' | jq -r .digest");
    expect(steps[verify]?.run).not.toContain("{{.Manifest.Digest}}");
  });

  it("deploys nothing: no AWS, SSH or remote-execution tooling", () => {
    for (const { step } of allSteps) {
      expect(step.uses ?? "").not.toMatch(/aws|ssh|deploy|kubectl|appleboy/i);
      expect(step.run ?? "").not.toMatch(/\baws\b|\bssh\b|\bscp\b|kubectl|compose\s+up/i);
    }
  });
});

describe("docker-compose.release.yml", () => {
  const release = yaml.load(read("docker-compose.release.yml"), { schema: composeSchema }) as {
    services: Record<string, { build?: unknown; image?: string }>;
  };
  const vars = { migrate: "DP2_MIGRATE_IMAGE", api: "DP2_API_IMAGE", worker: "DP2_WORKER_IMAGE" } as const;

  it("overrides only migrate, api and worker, resetting build and requiring a digest-ref variable", () => {
    expect(Object.keys(release.services).sort()).toEqual(["api", "migrate", "worker"]);
    for (const [service, variable] of Object.entries(vars)) {
      const svc = release.services[service] ?? {};
      expect(svc.build).toBe(RESET);
      expect(svc.image).toMatch(new RegExp(`^\\$\\{${variable}:\\?[^}]+\\}$`));
    }
    expect(read("docker-compose.release.yml")).not.toMatch(/latest/i);
  });

  it("matches the variable names the bundle script writes to release.env", () => {
    const script = read("deploy/release-bundle.sh");
    for (const variable of Object.values(vars)) expect(script).toContain(`${variable}=`);
  });
});

describe("docker-compose.prod.yml default behaviour", () => {
  const prod = yaml.load(read("docker-compose.prod.yml")) as {
    services: Record<string, { build?: { context?: string; dockerfile?: string; target?: string } }>;
  };

  it("still builds migrate, api and worker from their Dockerfile targets", () => {
    for (const target of ["migrate", "api", "worker"]) {
      expect(prod.services[target]?.build).toEqual({ context: ".", dockerfile: "Dockerfile", target });
    }
  });
});

describe("release bundle", () => {
  const script = read("deploy/release-bundle.sh");

  function allowlist(): string[] {
    const body = /^ALLOWLIST=\(\n([\s\S]*?)^\)/m.exec(script)?.[1] ?? "";
    return body.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  function readmeDeploySql(): string[] {
    const readme = read("deploy/README.md");
    const deploy = readme.slice(readme.indexOf("\n## Deploy\n"), readme.indexOf("\n## Admin Console release\n"));
    expect(deploy.length).toBeGreaterThan(0);
    return [...deploy.matchAll(/-f (docs\/operations\/sql\/[\w-]+\.sql)/g)].flatMap((m) => m[1] ?? []);
  }

  it("is exactly the compose files, Caddyfile, smoke tool, the README's SQL scripts and their includes", () => {
    const list = allowlist();
    const sql = list.filter((f) => f.startsWith("docs/operations/sql/"));
    const included = list.filter((f) => f.startsWith("packages/db/drizzle/"));
    expect(included.sort()).toEqual([
      "packages/db/drizzle/0038_erpnext_posting_resolution_backfill.sql",
      "packages/db/drizzle/0043_inventory_effect_integration_backfill.sql",
    ]);
    expect(list.filter((f) => !sql.includes(f) && !included.includes(f)).sort()).toEqual(
      ["Caddyfile", "deploy/console-smoke.sh", "docker-compose.prod.yml", "docker-compose.release.yml"].sort(),
    );
    expect(sql.sort()).toEqual([...readmeDeploySql()].sort());
    expect(sql).toHaveLength(22);
    expect(new Set(list).size).toBe(list.length);
    for (const f of list) expect(f).not.toMatch(/\.env(\.|$)|secret|password/i);
  });

  it("only ships files that exist in the repo", () => {
    for (const f of allowlist()) expect(() => read(f)).not.toThrow();
  });

  it("ships every file a bundled SQL script includes with \\i or \\ir", () => {
    // Deploy runs `psql -f docs/operations/sql/<x>.sql` from the bundle root, so
    // \i resolves against the bundle root and \ir against the including file.
    const list = allowlist();
    const includes = list.filter((f) => f.endsWith(".sql")).flatMap((f) =>
      [...read(f).matchAll(/^\s*\\(ir?|include(?:_relative)?)\s+(\S+)/gm)].map((m) => {
        const relative = m[1] === "ir" || m[1] === "include_relative";
        const target = posix.normalize(relative ? posix.join(posix.dirname(f), m[2] ?? "") : (m[2] ?? ""));
        return { from: f, target };
      }),
    );
    expect(includes.length).toBeGreaterThan(0);
    for (const { from, target } of includes) {
      expect({ from, target, inBundle: list.includes(target) }).toEqual({ from, target, inBundle: true });
    }
  });

  it("validates digest refs and the SHA, and fails on any error", () => {
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("^ghcr\\.io/kemetra/backend-core-(api|worker|migrate)@sha256:[0-9a-f]{64}$");
    expect(script).toContain("^[0-9a-f]{40}$");
    expect(script).not.toMatch(/latest/i);
  });
});
