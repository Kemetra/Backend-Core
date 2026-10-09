/**
 * RT-336 — the public Caddy edge serves the Admin Console SPA and the API on
 * one HTTPS origin (owner decision 2026-10-09, RT-315): `/api` and `/api/*`
 * reach the API untouched; everything else is the pinned Console bundle.
 * Runtime behavior is proven by `deploy/console-smoke.sh` against a running
 * Caddy; these checks keep the template from drifting.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const caddyfile = readFileSync(resolve(repoRoot, "Caddyfile"), "utf8");
const compose = readFileSync(resolve(repoRoot, "docker-compose.prod.yml"), "utf8");

/** The `{ ... }` body that follows the first occurrence of `opener`. */
function blockAfter(source: string, opener: string): string {
  const start = source.indexOf(opener);
  if (start < 0) throw new Error(`"${opener}" not found`);
  const open = source.indexOf("{", start + opener.length - 1);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced block after "${opener}"`);
}

describe("Caddyfile same-origin gateway", () => {
  const site = blockAfter(caddyfile, "{$CADDY_SITE_ADDRESS:api.example.test} {");

  it("takes the public hostname from the host environment, keeping the placeholder default", () => {
    expect(caddyfile).toContain("{$CADDY_SITE_ADDRESS:api.example.test} {");
  });

  it("routes /api and /api/* to the API before any Console handling", () => {
    expect(site).toContain("@api path /api /api/*");
    const api = blockAfter(site, "handle @api {");
    expect(api.trim()).toBe("reverse_proxy api:3000");
    expect(site.indexOf("handle @api {")).toBeLessThan(site.indexOf("handle {"));
  });

  it("serves the current Console release with an SPA fallback to index.html", () => {
    const consoleBlock = blockAfter(site, "handle {");
    expect(consoleBlock).toContain("root * /srv/console/current");
    const pages = blockAfter(consoleBlock, "handle {");
    expect(pages).toContain("try_files {path} /index.html");
    expect(pages).toContain("file_server");
  });

  it("caches only hashed assets as immutable and never falls back to index.html for them", () => {
    const consoleBlock = blockAfter(site, "handle {");
    const assets = blockAfter(consoleBlock, "handle /assets/* {");
    expect(assets).toContain('Cache-Control "public, max-age=31536000, immutable"');
    expect(assets).toContain("file_server");
    expect(assets).not.toContain("try_files");

    const pages = blockAfter(consoleBlock, "handle {");
    expect(pages).toContain('Cache-Control "no-cache"');
  });

  it("sends security headers on Console responses only", () => {
    const consoleBlock = blockAfter(site, "handle {");
    expect(consoleBlock).toMatch(/Content-Security-Policy ".*default-src 'self'.*"/);
    expect(consoleBlock).toMatch(/Content-Security-Policy ".*connect-src 'self'.*"/);
    expect(consoleBlock).toMatch(/Content-Security-Policy ".*frame-ancestors 'none'.*"/);
    expect(consoleBlock).toContain('Strict-Transport-Security "max-age=31536000"');
    expect(consoleBlock).toContain('X-Content-Type-Options "nosniff"');
    expect(consoleBlock).toContain('Referrer-Policy "strict-origin-when-cross-origin"');

    const api = blockAfter(site, "handle @api {");
    expect(api).not.toContain("header");
  });
});

describe("production compose for the same-origin gateway", () => {
  const services = compose.slice(compose.indexOf("services:"), compose.indexOf("\nnetworks:"));
  const caddy = compose.slice(compose.indexOf("  caddy:"), compose.indexOf("\nnetworks:"));

  it("adds no new service, container or VM", () => {
    const names = [...services.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
    expect(names).toEqual(["redis", "migrate", "api", "worker", "caddy"]);
  });

  it("mounts the pinned Console releases directory read-only and requires it to be set", () => {
    expect(caddy).toContain(
      "${CONSOLE_RELEASES_DIR:?CONSOLE_RELEASES_DIR required (pinned Admin Console releases + current symlink)}:/srv/console:ro",
    );
  });

  it("passes the public hostname to Caddy without hard-coding a real domain", () => {
    expect(caddy).toContain("CADDY_SITE_ADDRESS: ${CADDY_SITE_ADDRESS:-api.example.test}");
  });

  it("keeps the API behind exactly one trusted proxy hop with CORS off", () => {
    const api = compose.slice(compose.indexOf("  api:"), compose.indexOf("  worker:"));
    expect(api).toContain('TRUST_PROXY: "1"');
    expect(api).not.toContain("ALLOWED_ORIGINS");
  });
});
