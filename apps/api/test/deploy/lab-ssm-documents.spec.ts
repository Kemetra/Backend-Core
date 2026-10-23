/**
 * RT-842 (RT-532 S4) — the two SSM Command documents the live `Deploy lab` job
 * runs: RT-BackendLabBackup on lab-02 and RT-BackendLabDeploy on lab-01. The
 * owner creates them in AWS from these files, and the SSM agent runs them as
 * root, so the files are the security boundary. The checks are static (no AWS,
 * no host): strict parameters that never reach shell text, the RT-532 gate
 * order, no secrets or raw output on stdout, and valid bash.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");

type Param = { type: string; allowedPattern?: string; allowedValues?: string[]; interpolationType?: string };
type Doc = {
  schemaVersion: string;
  parameters: Record<string, Param>;
  mainSteps: { action: string; name: string; precondition?: unknown; inputs: { timeoutSeconds: string; runCommand: string[] } }[];
};

const load = (file: string): { text: string; doc: Doc; command: string; body: string } => {
  const text = read(`deploy/lab/ssm/${file}`);
  const doc = yaml.load(text) as Doc;
  const command = doc.mainSteps.map((s) => s.inputs.runCommand.join("\n")).join("\n");
  // The bash body the wrapper writes to a root-only file and runs.
  const body = /<<'RT_\w+_SCRIPT'\n([\s\S]*?)\nRT_\w+_SCRIPT\n/.exec(command)?.[1] ?? "";
  return { text, doc, command, body };
};
const backup = load("RT-BackendLabBackup.yaml");
const deploy = load("RT-BackendLabDeploy.yaml");

function bashWorks(): boolean {
  const probe = spawnSync("bash", ["-c", "printf ok"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout === "ok";
}
const haveBash = bashWorks();
if (!haveBash && process.env["CI"]) throw new Error("bash is required in CI for the SSM document syntax checks");
const itBash = haveBash ? it : it.skip;

/** Index of each needle in the deploy body; every one must exist and appear in order. */
function expectInOrder(body: string, needles: string[]): void {
  const at = needles.map((needle) => ({ needle, i: body.indexOf(needle) }));
  for (const { needle, i } of at) expect({ needle, found: i > -1 }).toEqual({ needle, found: true });
  const indices = at.map((a) => a.i);
  expect(indices).toEqual([...indices].sort((a, b) => a - b));
}

describe.each([
  ["RT-BackendLabBackup", backup, ["ReleaseTag", "CurrentRelease", "JiraKey"]],
  ["RT-BackendLabDeploy", deploy, ["ReleaseTag", "ApiDigest", "WorkerDigest", "MigrateDigest", "CurrentRelease", "JiraKey", "BackupName", "BackupSha256", "RollbackAllowed"]],
])("%s document", (_name, d, params) => {
  it("is a schema 2.2 Command document with one Linux shell step", () => {
    expect(d.doc.schemaVersion).toBe("2.2");
    expect(d.doc.mainSteps).toHaveLength(1);
    expect(d.doc.mainSteps[0]).toMatchObject({ action: "aws:runShellScript", precondition: { StringEquals: ["platformType", "Linux"] } });
    expect(Number(d.doc.mainSteps[0]?.inputs.timeoutSeconds)).toBeGreaterThan(0);
  });

  it("takes exactly its strict String parameters: anchored allowedPattern, no free-form command", () => {
    expect(Object.keys(d.doc.parameters)).toEqual(params);
    for (const [name, p] of Object.entries(d.doc.parameters)) {
      expect({ name, type: p.type }).toEqual({ name, type: "String" });
      expect({ name, pattern: p.allowedPattern }).toEqual({ name, pattern: expect.stringMatching(/^\^.+\$$/) });
      // no wildcard that would admit shell metacharacters or whitespace
      expect({ name, wide: /(^|[^\\])\.[*+]|\\s|\[\^/.test(p.allowedPattern ?? "") }).toEqual({ name, wide: false });
      expect({ name, interpolation: p.interpolationType }).toEqual({ name, interpolation: "ENV_VAR" });
    }
    expect(Object.keys(d.doc.parameters).some((n) => /command|script/i.test(n))).toBe(false);
  });

  it("never pastes a parameter into shell text: no {{ }} placeholder, each value read once from SSM_<name>", () => {
    expect(d.command).not.toContain("{{");
    for (const name of params) {
      expect({ name, uses: [...d.body.matchAll(new RegExp(`\\$\\{?SSM_${name}\\b`, "g"))].length }).toEqual({ name, uses: 1 });
      expect(d.body).toContain(`"\${SSM_${name}:-}"`);
    }
  });

  it("re-validates every parameter in the script before using it", () => {
    for (const name of params) expect(d.body).toMatch(new RegExp(`stop "${name}-missing-or-invalid"`));
  });

  it("prints only fixed RT_* lines: command output goes to a root-only log", () => {
    expect(d.body).toContain('exec 3>&1 >>"$LOG" 2>&1');
    expect(d.body.indexOf('exec 3>&1 >>"$LOG" 2>&1')).toBeLessThan(d.body.indexOf("RELEASE_TAG="));
    expect(d.body).toMatch(/say\(\) \{ printf '%s\\n' "\$\*" >&3; \}/);
    // fd 3 is written only by say()
    expect([...d.body.matchAll(/>&3/g)]).toHaveLength(1);
    for (const line of d.body.split("\n").filter((l) => /\bsay "/.test(l))) expect(line).toMatch(/say "RT_[A-Z]+ /);
    expect(d.body).toContain("umask 077");
  });

  it("holds no secret and dumps no environment, and never pipes a download into a shell", () => {
    expect(d.text).not.toMatch(/set -x|printenv|(^|[|;&]\s*)env\s*($|\|)|declare -p|BASH_XTRACEFD|AKIA[0-9A-Z]{16}|PASSWORD=|SECRET=|TOKEN=/m);
    expect(d.text).not.toMatch(/curl[^\n|]*\|\s*(ba|z)?sh\b|wget[^\n|]*\|\s*(ba|z)?sh\b|(ba)?sh\s+<\(\s*curl/);
    expect(d.text).not.toMatch(/AWS-RunShellScript|StartSession/);
    expect(d.text).not.toMatch(/latest/i);
  });

  it("runs the body with bash -euo pipefail under a lock, never stdin-fed", () => {
    expect(d.body.startsWith("set -euo pipefail\n")).toBe(true);
    expect(d.command).toMatch(/\/bin\/bash "\$RT_SCRIPT" \|\| RC=\$\?/);
    expect(d.body).toMatch(/flock -n 9 \|\| stop/);
  });

  itBash("is valid bash", () => {
    const r = spawnSync("bash", ["-n"], { input: d.body, encoding: "utf8" });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const wrapper = spawnSync("bash", ["-n"], { input: d.command, encoding: "utf8" });
    expect(wrapper.status).toBe(0);
  });
});

describe("RT-BackendLabBackup (lab-02, D-1a)", () => {
  const b = backup.body;

  it("dumps with pg_dump -Fc as the postgres user, checksums it, and verifies the checksum", () => {
    expectInOrder(b, ["sudo -u postgres pg_dump -Fc", 'sha256sum "$DUMP"', "sha256sum --check --strict --quiet"]);
    // FORCE RLS tables cannot be dumped by the owner role
    expect(b).not.toMatch(/pg_dump[^\n]*-U\s/);
  });

  it("rehearses the restore into a scratch database with table-count parity, then drops it", () => {
    expectInOrder(b, ['createdb "$SCRATCH"', "pg_restore --exit-on-error", 'SRC_TABLES="$(', 'RST_TABLES="$(', '[ "$SRC_TABLES" = "$RST_TABLES" ] || stop "table-count-mismatch"', "drop_scratch\n"]);
    expect(b).toContain("trap drop_scratch EXIT");
  });

  it("prints only the backup name and checksum as its result", () => {
    expect(b).toContain('say "RT_BACKUP name=$NAME sha256=$SUM"');
    expect(b.indexOf('say "RT_BACKUP')).toBeGreaterThan(b.indexOf('say "RT_GATE backup-restore-rehearsal pass'));
    expect(b).toMatch(/NAME="rtlab-\$\{CURRENT_RELEASE#backend-core-\}-to-\$\{RELEASE_TAG#backend-core-\}-\$STAMP\.dump"/);
  });

  it("names backups in the form the deploy document's BackupName parameter accepts", () => {
    const pattern = new RegExp(deploy.doc.parameters.BackupName?.allowedPattern ?? "^$");
    expect(pattern.test("rtlab-046b7f7cff53-to-1711813df1f3-20261023T120000Z.dump")).toBe(true);
    expect(pattern.test("rtlab-046b7f7cff53-to-1711813df1f3-20261023T120000Z.dump; id")).toBe(false);
  });
});

describe("RT-BackendLabDeploy (lab-01)", () => {
  const b = deploy.body;

  it("follows the RT-532 order: host, backup, fetch, config backup, auto-revert, migrate, grants, catch-up, start, ready, cancel", () => {
    expectInOrder(b, [
      "GATE=G-Host",
      "pass G-Host",
      "GATE=G-Backup",
      "pass G-Backup",
      "GATE=fetch",
      "GATE=backup-config",
      "GATE=arm-revert",
      'systemd-run --unit="$UNIT" --on-active="$REVERT_AFTER"',
      'mv "$DC.next" "$DC"',
      '"$DC" run --rm migrate </dev/null || stop "migrate-failed"',
      "psql_client bash deploy/apply-domain-grants.sh",
      "erpnext-posting-resolution-catchup.sql",
      "inventory-effect-integration-catchup.sql",
      '"$DC" up -d </dev/null || stop "compose-up-failed"',
      'running_matches api "$API_REF"',
      "GATE=G-Ready",
      'deploy/console-smoke.sh" "http://$ORIGIN_HOST"',
      'systemctl stop "$UNIT.timer"',
      'say "RT_DONE release=$RELEASE_TAG"',
    ]);
  });

  it("G-Host: changes nothing unless the running images and SENTRY_RELEASE are the CurrentRelease's", () => {
    const host = b.slice(b.indexOf("GATE=G-Host"), b.indexOf("pass G-Host"));
    expect(host).toContain('[ "$SENTRY" = "$CUR12" ] || stop');
    expect(host).toContain('running_matches api "$PRIOR_API" || stop');
    expect(host).toContain('running_matches worker "$PRIOR_WORKER" || stop');
    expect(host).not.toMatch(/\bcp\b|\bmv\b|sed -i|docker (run|pull)|"\$DC" (run|up)/);
    // an earlier run's revert unit (armed or elapsed) would undo this run
    expect(host).toContain("--state=active,activating,reloading \\\n");
    expect(host).toContain("'rt-deploy-revert-*' </dev/null)\" || stop \"revert-unit-query-failed\"");
    expect(host).toContain('[ -z "$ARMED" ] || stop "an-earlier-auto-revert-is-armed-or-elapsed"');
    expect(host.indexOf("an-earlier-auto-revert-is-armed-or-elapsed")).toBeLessThan(host.indexOf("running_matches api"));
  });

  it("refuses an empty or malformed backup reference (narrow anchored name, 64-hex checksum)", () => {
    expect(deploy.doc.parameters.BackupSha256?.allowedPattern).toBe("^[0-9a-f]{64}$");
    expect(deploy.doc.parameters.BackupName?.allowedPattern).toBe("^rtlab-[0-9a-f]{12}-to-[0-9a-f]{12}-[0-9]{8}T[0-9]{6}Z\\.dump$");
    expect(deploy.doc.parameters.RollbackAllowed?.allowedValues).toEqual(["true", "false"]);
    // re-checked in bash: an empty value fails the same anchored match
    expect(b).toContain('BACKUP_NAME="${SSM_BackupName:-}"');
    expect(b).toContain('[[ "$BACKUP_SHA256" =~ ^[0-9a-f]{64}$ ]] || stop "BackupSha256-missing-or-invalid"');
    expect(b).toMatch(/\[\[ "\$BACKUP_NAME" =~ \^rtlab-\(\[0-9a-f\]\{12\}\)-to-\(\[0-9a-f\]\{12\}\)-/);
  });

  it("G-Host: the readiness probe must already pass on the current release, and a redirect names the contract", () => {
    const host = b.slice(b.indexOf("GATE=G-Host"), b.indexOf("pass G-Host"));
    expect(host).toContain('CODE="$(origin_ready_code)"');
    expect(host).toContain('3??) stop "origin-port-80-redirects-CADDY_SITE_ADDRESS-must-be-http-scheme"');
    expect(host).toContain('*) stop "origin-health-ready-not-200-on-the-current-release"');
    // G-Ready uses the same probe
    expect(b.slice(b.indexOf("GATE=G-Ready"))).toContain('CODE="$(origin_ready_code)"');
  });

  it("pulls every image before the revert is armed, so the start spends no revert time downloading", () => {
    const pull = b.indexOf('docker pull --quiet "$REF" </dev/null || stop "image-pull-failed"');
    expect(pull).toBeGreaterThan(b.indexOf("GATE=fetch"));
    expect(pull).toBeLessThan(b.indexOf("systemd-run --unit"));
    expect(b).toContain('for REF in "$MIGRATE_REF" "$API_REF" "$WORKER_REF" "$PSQL_IMAGE"; do');
  });

  it("G-Backup: accepts only a fresh backup of this release pair", () => {
    const gate = b.slice(b.indexOf("GATE=G-Backup"), b.indexOf("pass G-Backup"));
    expect(gate).toContain('[ "$BK_CUR" = "$CUR12" ] && [ "$BK_TGT" = "$TGT12" ] || stop');
    expect(gate).toContain('[ "$AGE" -le "$BACKUP_MAX_AGE_SECONDS" ] || stop');
  });

  it("fetches the bundle over https only, checks SHA256SUMS before unpacking, and binds release.env to the digests", () => {
    const fetch = b.slice(b.indexOf("GATE=fetch"), b.indexOf("pass fetch"));
    expect(fetch).toContain("curl -fsSL --proto '=https'");
    expect(fetch).toContain('--max-filesize "$MAX_ASSET_BYTES"');
    expectInOrder(fetch, ["sha256sum --check --strict SHA256SUMS", "bundle-holds-a-non-regular-entry", "unsafe-bundle-entry-path", "tar -xzf", "--strip-components=1"]);
    for (const [key, ref] of [["DP2_API_IMAGE", "API_REF"], ["DP2_WORKER_IMAGE", "WORKER_REF"], ["DP2_MIGRATE_IMAGE", "MIGRATE_REF"]]) {
      expect(fetch).toContain(`[ "$(env_value "$TGT_DIR/release.env" ${key})" = "$${ref}" ] || stop`);
    }
  });

  it("arms a 15-minute auto-revert before anything changes, app-only only when RollbackAllowed=true", () => {
    expect(b).toContain("REVERT_AFTER=15min");
    expect(b.indexOf("systemd-run")).toBeLessThan(b.indexOf('mv "$DC.next" "$DC"'));
    const arm = b.slice(b.indexOf("GATE=arm-revert"), b.indexOf("pass arm-revert"));
    const [allowed, blocked] = arm.split("\nelse\n");
    expect(arm).toContain('if [ "$ROLLBACK_ALLOWED" = true ]; then');
    expect(allowed).toContain('cp -p "$RUN_DIR/dc" "$DC"');
    expect(allowed).toContain('cp -p "$RUN_DIR/backend.env" "$BACKEND_ENV"');
    // after a schema change, the revert only records that an owner decision is needed
    expect(blocked).toContain("REVERT-BLOCKED");
    expect(blocked).not.toMatch(/"\$DC"|cp -p|docker/);
  });

  it("cancels the auto-revert only after readiness and the console smoke pass", () => {
    expect(b.indexOf('systemctl stop "$UNIT.timer"')).toBeGreaterThan(b.indexOf("pass console-smoke"));
    expect([...b.matchAll(/systemctl stop/g)]).toHaveLength(1);
  });

  it("never reports success over a revert that fired: window check before start, fired/ran checks at cancel", () => {
    // the start cutoff leaves room for everything after it: up + catch-up, readiness, smoke, margin
    expect(b).toContain(
      "MAX_SECONDS_BEFORE_START=$(( REVERT_SECONDS - POST_START_SECONDS - READY_TIMEOUT_SECONDS - SMOKE_SECONDS - CANCEL_MARGIN_SECONDS ))",
    );
    const num = (name: string): number => Number(new RegExp(String.raw`\n${name}=(\d+)\n`).exec(b)?.[1]);
    expect(num("REVERT_SECONDS")).toBe(15 * 60);
    expect(b).toContain("REVERT_AFTER=15min");
    // console-smoke: 8 requests of at most SMOKE_MAX_TIME (10 s) each
    const smokeRequests = [...read("deploy/console-smoke.sh").matchAll(/\$\(get /g)].length;
    expect(num("SMOKE_SECONDS")).toBeGreaterThanOrEqual(smokeRequests * 10);
    const cutoff = num("REVERT_SECONDS") - num("POST_START_SECONDS") - num("READY_TIMEOUT_SECONDS") - num("SMOKE_SECONDS") - num("CANCEL_MARGIN_SECONDS");
    expect(cutoff).toBeGreaterThan(0);
    expect(num("CANCEL_MARGIN_SECONDS")).toBeGreaterThanOrEqual(60);
    expect(b.indexOf('ARMED_AT="$(date +%s)"')).toBeLessThan(b.indexOf("too-little-revert-window-left-to-start"));
    expect(b.indexOf("too-little-revert-window-left-to-start")).toBeLessThan(b.indexOf('"$DC" up -d </dev/null ||'));
    const cancel = b.slice(b.indexOf("GATE=cancel-revert"), b.indexOf("RT_DONE"));
    expectInOrder(cancel, [
      // a fired one-shot timer stays active (sub-state elapsed): judge by sub-state and trigger time
      '[ "$(systemctl show -p SubState --value "$UNIT.timer")" = waiting ] || stop "auto-revert-already-fired"',
      '[ "$(systemctl show -p LastTriggerUSecMonotonic --value "$UNIT.timer")" = 0 ] || stop "auto-revert-already-fired"',
      'systemctl stop "$UNIT.timer"',
      '[ ! -e "$RUN_DIR/REVERT-STARTED" ] && [ ! -e "$RUN_DIR/REVERTED" ] && [ ! -e "$RUN_DIR/REVERT-BLOCKED" ] || stop "auto-revert-ran"',
      'running_matches api "$API_REF" || stop "running-api-changed-after-readiness"',
      'say "RT_REVERT cancelled',
    ]);
  });

  it("orders migrate, grants, catch-up, up, catch-up, readiness, cancel revert", () => {
    const catchups = [...b.matchAll(/psql_client sh -c 'psql -X -v ON_ERROR_STOP=1 -f docs\/operations\/sql\/erpnext-posting-resolution-catchup\.sql/g)].map((m) => m.index ?? -1);
    expect(catchups).toHaveLength(2);
    const steps = [
      b.indexOf('"$DC" run --rm migrate </dev/null'),
      b.indexOf("psql_client bash deploy/apply-domain-grants.sh"),
      catchups[0] ?? -1,
      b.indexOf('"$DC" up -d </dev/null ||'),
      catchups[1] ?? -1,
      b.indexOf("GATE=G-Ready"),
      b.indexOf('systemctl stop "$UNIT.timer"'),
    ];
    expect(steps.every((i) => i > -1)).toBe(true);
    expect(steps).toEqual([...steps].sort((x, y) => x - y));
  });

  it("a failed post-start catch-up stops before readiness, leaving the auto-revert armed", () => {
    const post = b.slice(b.indexOf("pass start"), b.indexOf("GATE=G-Ready"));
    expect(post).toMatch(/\|\| stop "post-start-catch-up-failed"/);
    // stop() exits; the only cancel is after readiness and the smoke
    expect(b).toMatch(/stop\(\) \{ [^}]*exit 1; \}/);
    expect(b.indexOf('systemctl stop "$UNIT.timer"')).toBeGreaterThan(b.indexOf("pass console-smoke"));
    expect(b).not.toMatch(/trap[^\n]*systemctl/);
  });

  it("runs the catch-up scripts before and again after the start, as README Deploy step 4 does", () => {
    const runs = [...b.matchAll(/-f docs\/operations\/sql\/erpnext-posting-resolution-catchup\.sql/g)].map((m) => m.index ?? -1);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toBeLessThan(b.indexOf('"$DC" up -d </dev/null ||'));
    expect(runs[1]).toBeGreaterThan(b.indexOf("pass start"));
    expect(runs[1]).toBeLessThan(b.indexOf("GATE=G-Ready"));
  });

  it("extracts a fetched bundle world-readable (no secrets in it; containers bind-mount its files)", () => {
    expect(b).toMatch(/\(umask 022 && mkdir "\$WORK\/extract" \\\n\s+&& tar -xzf/);
  });

  it("finishes inside the deploy role session: each poll window is its document timeout plus a minute", () => {
    const wf = read(".github/workflows/deploy-lab.yml");
    const poll = (doc: string): number => Number(new RegExp(`${doc} "\\$LIVE/\\w+-params\\.json" (\\d+)`).exec(wf)?.[1]);
    const session = Number(/role-duration-seconds: (\d+)/.exec(wf)?.[1]);
    expect(poll("RT-BackendLabBackup")).toBe(Number(backup.doc.mainSteps[0]?.inputs.timeoutSeconds) + 60);
    expect(poll("RT-BackendLabDeploy")).toBe(Number(deploy.doc.mainSteps[0]?.inputs.timeoutSeconds) + 60);
    // the claim print, credentials and node lookups need a few minutes too
    expect(poll("RT-BackendLabBackup") + poll("RT-BackendLabDeploy") + 600).toBeLessThanOrEqual(session);
  });

  it("never downgrades the database", () => {
    expect(deploy.text).not.toMatch(/migrate[^\n]*\bdown\b|\.down\.sql|pg_restore|dropdb|DROP (TABLE|SCHEMA|DATABASE)/i);
  });

  it("runs grants and catch-up in a digest-pinned psql client with the root-only migration-owner env file", () => {
    expect(b).toMatch(/PSQL_IMAGE=postgres:16-bookworm@sha256:[0-9a-f]{64}\n/);
    expect(b).toContain('docker run --rm --network host --env-file "$GRANTS_ENV" -v "$TGT_DIR:/release:ro"');
    expect(b).toContain("psql -X -v ON_ERROR_STOP=1 -f docs/operations/sql/erpnext-posting-resolution-catchup.sql");
    expect(b).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("keeps stdin off every docker and compose call, and reads only the image field from docker inspect", () => {
    // continuation lines joined, so a redirect on the last line of a command counts
    const joined = b.replace(/\\\n\s*/g, " ");
    for (const line of joined.split("\n").filter((l) => /(^|\s)(docker (run|inspect|image inspect|ps)|"\$DC" (run|up))\b/.test(l) && !l.trim().startsWith("#"))) {
      expect(line).toMatch(/<\/dev\/null/);
    }
    for (const line of b.split("\n").filter((l) => /docker (image )?inspect/.test(l) && !l.trim().startsWith("#"))) {
      expect(line).toMatch(/\| python3 -c 'import json, sys; print\(json\.load\(sys\.stdin\)\[0\]\["(Image|Id)"\]\)'$/);
    }
  });

  it("stops at the first failure: every gate step ends in stop on failure", () => {
    for (const needle of ['"$DC" run --rm migrate', "psql_client bash deploy/apply-domain-grants.sh", '"$DC" up -d </dev/null ||', "console-smoke.sh"]) {
      const line = b.split("\n").find((l) => l.includes(needle)) ?? "";
      expect({ needle, line }).toEqual({ needle, line: expect.stringMatching(/\|\| stop "[a-z-]+"$/) });
    }
  });
});
