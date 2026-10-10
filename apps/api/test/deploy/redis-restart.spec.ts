/**
 * RT-344 — the prod Redis service must come back after a container restart
 * (host reboot, Docker daemon restart, crash), not only on its first start.
 *
 * The service writes its `requirepass` config file at start (RT-143). On a
 * host with `fs.protected_regular >= 1` (Ubuntu's default), root inside the
 * container cannot re-open that file for writing once it belongs to `redis`
 * in the sticky, world-writable /tmp, so the restarted container crash-loops.
 *
 * This runs the exact `command` and healthcheck from docker-compose.prod.yml
 * in a throwaway container through the Docker CLI, restarts it, and checks it
 * is healthy again, while the RT-143 secret-handling properties still hold.
 * Needs Docker (db-integration CI job).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

interface RedisService {
  image: string;
  command: string[];
  healthcheck: { test: string[] };
}

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const compose = load(readFileSync(resolve(repoRoot, "docker-compose.prod.yml"), "utf8")) as {
  services: { redis: RedisService };
};
const redis = compose.services.redis;

/** Compose turns `$$` into a literal `$` before the container sees it. */
const unescape = (value: string): string => value.replace(/\$\$/g, "$");

function required(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`docker-compose.prod.yml redis: missing ${what}`);
  return value;
}

const command = redis.command.map(unescape);
const healthKind = redis.healthcheck.test[0];
const healthScript = required(redis.healthcheck.test[1], "healthcheck script");
const password = randomBytes(18).toString("hex");
const name = `rt344-redis-${randomBytes(4).toString("hex")}`;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function healthy(): boolean {
  try {
    docker("exec", name, "sh", "-c", unescape(healthScript));
    return true;
  } catch {
    return false;
  }
}

async function waitUntilHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (healthy()) return true;
    await new Promise((done) => setTimeout(done, 500));
  }
  return false;
}

function logs(): string {
  try {
    return execFileSync("docker", ["logs", "--tail", "20", name], { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    return String(err);
  }
}

describe("prod Redis survives a container restart (RT-344)", () => {
  beforeAll(() => {
    expect(healthKind).toBe("CMD-SHELL");
    try {
      docker("image", "inspect", redis.image);
    } catch {
      docker("pull", "--quiet", redis.image);
    }
    docker("run", "-d", "--name", name, "-e", `REDIS_PASSWORD=${password}`, redis.image, ...command);
  }, 120_000);

  afterAll(() => {
    try {
      docker("rm", "-f", name);
    } catch {
      // already gone
    }
  });

  it("is healthy on its first start", async () => {
    expect(await waitUntilHealthy(30_000)).toBe(true);
  }, 40_000);

  it("is healthy again after `docker restart`", async () => {
    const protectedRegular = docker("exec", name, "cat", "/proc/sys/fs/protected_regular").trim();
    // The pre-fix failure only reproduces when this is >= 1; log it so a CI
    // run shows whether it exercised the RT-344 case.
    console.info(`RT-344 restart check: host fs.protected_regular=${protectedRegular}`);
    docker("restart", name);
    const ok = await waitUntilHealthy(30_000);
    if (!ok) {
      throw new Error(
        `redis did not recover after restart (fs.protected_regular=${protectedRegular}):\n${logs()}`,
      );
    }
  }, 60_000);

});

/**
 * The RT-143 secret handling is guarded on the template, not at runtime:
 * redis-server rewrites its process title (masking /proc/1/cmdline and
 * environ), and the file was observed at mode 600 even with the umask removed,
 * so runtime probes would pass even if the template regressed.
 */
describe("prod Redis command keeps the RT-143 secret handling", () => {
  const script = required(redis.command[2], "startup script");

  it("runs the startup script through sh -c", () => {
    expect(redis.command.slice(0, 2)).toEqual(["sh", "-c"]);
  });

  it("creates the config file privately and hands it to redis", () => {
    expect(script).toContain("umask 077 && printf 'requirepass %s\\n' \"$$REDIS_PASSWORD\" > /tmp/redis-auth.conf");
    expect(script).toContain("chown redis:redis /tmp/redis-auth.conf");
  });

  it("drops the password from the environment before exec'ing redis-server with the file", () => {
    expect(script).toMatch(
      /unset REDIS_PASSWORD && exec docker-entrypoint\.sh redis-server \/tmp\/redis-auth\.conf --appendonly yes$/,
    );
  });

  it("never passes the password as an argument or interpolates it in compose", () => {
    expect(script).not.toMatch(/--requirepass|\s-a\s/);
    expect(script.match(/\$\$REDIS_PASSWORD/g)).toHaveLength(1);
    expect(script).not.toMatch(/(^|[^$])\$\{?REDIS_PASSWORD/);
  });
});
