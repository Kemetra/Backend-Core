/**
 * Test helper (RT-631): prove an app's production `instrumentation.ts`
 * exports spans over OTLP/HTTP, and report the exported resource attributes.
 *
 * Runs in a child Node process because the OTLP HTTP transport loads `http`
 * through a dynamic `import()`, which Jest's module VM cannot run. The child
 * transpiles TypeScript on the fly with the repo's own `typescript` (no new
 * dependency), loads `<appDir>/src/instrumentation.ts` exactly as `main.ts`
 * does, records one span, and flushes through `shutdownOtel()` to a local sink.
 */
"use strict";

const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const REGISTER_TS = path.join(__dirname, "register-ts.cjs");
const CHILD_TIMEOUT_MS = 20_000;

function startSink() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      if (req.url === "/v1/traces") bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, bodies, port: server.address().port }));
  });
}

function runChild(appDir, spanName, env) {
  const code = [
    'require("./src/instrumentation.ts");',
    'const shared = require("@data-pulse-2/shared");',
    `shared.trace.getTracer("rt-631").startSpan(${JSON.stringify(spanName)}).end();`,
    "shared.shutdownOtel().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-r", REGISTER_TS, "-e", code], {
      cwd: appDir,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
    child.on("error", reject);
    child.on("exit", (status) => {
      clearTimeout(timer);
      if (status === 0) resolve();
      else reject(new Error(`instrumentation probe exited ${status}: ${stderr.slice(0, 2000)}`));
    });
  });
}

function resourceOf(bodies, spanName) {
  for (const batch of bodies.flatMap((b) => b.resourceSpans ?? [])) {
    const names = (batch.scopeSpans ?? []).flatMap((s) => s.spans ?? []).map((s) => s.name);
    if (names.includes(spanName)) {
      return Object.fromEntries(
        (batch.resource?.attributes ?? []).map((a) => [a.key, a.value?.stringValue]),
      );
    }
  }
  throw new Error(`span ${spanName} was not exported`);
}

/**
 * @param {{ appDir: string, spanName: string, env?: Record<string, string> }} opts
 * @returns {Promise<Record<string, string | undefined>>} exported resource attributes
 */
async function probeExportedResource({ appDir, spanName, env = {} }) {
  const sink = await startSink();
  try {
    const childEnv = {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${sink.port}`,
      OTEL_TRACES_SAMPLER: "always_on",
      ...env,
    };
    await runChild(appDir, spanName, childEnv);
    return resourceOf(sink.bodies, spanName);
  } finally {
    await new Promise((resolve) => sink.server.close(resolve));
  }
}

module.exports = { probeExportedResource };
