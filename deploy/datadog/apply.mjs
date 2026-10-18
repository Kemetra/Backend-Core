#!/usr/bin/env node
// Apply the RT-637 (OBS-8) Datadog definitions in this directory: monitors,
// the /health/ready Synthetics test and the "Retail Tower — lab" dashboard.
//
// Idempotent: each monitor and the Synthetics test carry a `rt637-key:<key>`
// tag and the dashboard is matched by title, so a re-run updates in place.
//
// Env (never printed):
//   DD_API_KEY, DD_APP_KEY   required unless --dry-run
//   DD_SITE                  default us5.datadoghq.com
//   ALERT_RECIPIENTS         comma-separated email addresses; replaces the
//                            __ALERT_RECIPIENTS__ placeholder in messages
//
// Usage: node deploy/datadog/apply.mjs [--dry-run]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = "__ALERT_RECIPIENTS__";
const KEY_TAG = "rt637-key";
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const dryRun = process.argv.includes("--dry-run");
const site = process.env.DD_SITE || "us5.datadoghq.com";

// Log lines carry Datadog API text, so keep each on one line (no forged lines).
function oneLine(text) {
  return String(text).replaceAll(/[\r\n]+/g, " ");
}

function fail(message) {
  console.error(oneLine(`[FAIL] ${message}`));
  process.exit(1);
}

function ok(message) {
  console.log(oneLine(message));
}

function readJson(name) {
  return JSON.parse(readFileSync(join(DIR, name), "utf8"));
}

function recipientHandles() {
  const raw = (process.env.ALERT_RECIPIENTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) fail("ALERT_RECIPIENTS is empty");
  const bad = raw.filter((addr) => !EMAIL.test(addr));
  if (bad.length > 0) fail(`ALERT_RECIPIENTS has ${bad.length} malformed address(es)`);
  return raw.map((addr) => `@${addr}`).join(" ");
}

function withRecipients(message, handles) {
  if (!message.includes(PLACEHOLDER)) fail("a message is missing the recipient placeholder");
  return message.replace(PLACEHOLDER, handles);
}

function prepare(def, handles) {
  const { key, ...body } = def;
  if (!key) fail(`definition "${def.name}" has no key`);
  return {
    key,
    body: {
      ...body,
      message: withRecipients(body.message, handles),
      tags: [...body.tags.filter((t) => !t.startsWith(`${KEY_TAG}:`)), `${KEY_TAG}:${key}`],
    },
  };
}

async function api(method, path, body) {
  const res = await fetch(`https://api.${site}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "DD-API-KEY": process.env.DD_API_KEY,
      "DD-APPLICATION-KEY": process.env.DD_APP_KEY,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`${method} ${path} -> ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function upsertMonitor({ key, body }) {
  const keyTag = encodeURIComponent(`${KEY_TAG}:${key}`);
  const found = await api("GET", `/api/v1/monitor?monitor_tags=${keyTag}`);
  if (found.length > 1) fail(`${found.length} monitors carry ${KEY_TAG}:${key}`);
  if (found.length === 1) {
    await api("PUT", `/api/v1/monitor/${found[0].id}`, body);
    return `updated monitor ${found[0].id}`;
  }
  const created = await api("POST", "/api/v1/monitor", body);
  return `created monitor ${created.id}`;
}

async function upsertSynthetic({ key, body }) {
  const { tests = [] } = await api("GET", "/api/v1/synthetics/tests");
  const found = tests.filter((t) => (t.tags || []).includes(`${KEY_TAG}:${key}`));
  if (found.length > 1) fail(`${found.length} synthetics tests carry ${KEY_TAG}:${key}`);
  if (found.length === 1) {
    await api("PUT", `/api/v1/synthetics/tests/api/${found[0].public_id}`, body);
    return `updated synthetics test ${found[0].public_id} (monitor ${found[0].monitor_id})`;
  }
  const created = await api("POST", "/api/v1/synthetics/tests/api", body);
  return `created synthetics test ${created.public_id} (monitor ${created.monitor_id})`;
}

async function upsertDashboard(body) {
  const { dashboards = [] } = await api("GET", "/api/v1/dashboard?filter[shared]=false");
  const found = dashboards.filter((d) => d.title === body.title);
  if (found.length > 1) fail(`${found.length} dashboards are titled "${body.title}"`);
  if (found.length === 1) {
    await api("PUT", `/api/v1/dashboard/${found[0].id}`, body);
    return `updated dashboard ${found[0].id}`;
  }
  const created = await api("POST", "/api/v1/dashboard", body);
  return `created dashboard ${created.id} ${created.url}`;
}

async function main() {
  const handles = dryRun ? "@alerts@example.invalid" : recipientHandles();
  const monitors = readJson("monitors.json").map((m) => prepare(m, handles));
  const synthetic = prepare(readJson("synthetics-api-health.json"), handles);
  const dashboard = readJson("dashboard-retail-tower-lab.json");

  if (dryRun) {
    for (const m of monitors) ok(`[DRY] monitor ${m.key}: ${m.body.name}`);
    ok(`[DRY] synthetics ${synthetic.key}: ${synthetic.body.name}`);
    ok(`[DRY] dashboard: ${dashboard.title} (${dashboard.widgets.length} groups)`);
    return;
  }
  if (!process.env.DD_API_KEY || !process.env.DD_APP_KEY) fail("DD_API_KEY and DD_APP_KEY are required");

  // Log each monitor as soon as it is applied, so a later failure still leaves
  // a record of what already changed in Datadog.
  await Promise.all(
    monitors.map(async (m) => {
      const result = await upsertMonitor(m);
      ok(`[OK] ${m.key}: ${result}`);
    }),
  );
  ok(`[OK] ${synthetic.key}: ${await upsertSynthetic(synthetic)}`);
  ok(`[OK] dashboard: ${await upsertDashboard(dashboard)}`);
}

try {
  await main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
