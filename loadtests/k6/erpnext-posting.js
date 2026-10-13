// loadtests/k6/erpnext-posting.js
//
// 015-POLISH (T091) — ERPNext posting-feed performance scenario (report-only).
//
// Measures the connector PULL feed latency at the SaaS boundary:
//   GET /api/connector/v1/erpnext/postings  (operationId connectorPullPostings)
// the cursor-paginated feed of pending posting work-items the connector drains.
//
// ── REPORT-ONLY STATUS (read before running) ─────────────────────────────────
// Per the 015-POLISH stop condition ("report perf as report-only if it cannot be
// measured in a real env"; the 005 T560 / 008 / 009 / 010 precedent), this
// scenario is authored but NOT executed in CI and NOT asserted as a release gate,
// because two prerequisites are unmet in the current environment:
//
//   1. No dedicated perf environment. Latency off a dev box / shared runner is
//      not representative. Do NOT weaken the thresholds to make a dev box pass —
//      that defeats the gate.
//   2. The feed authenticates a MACHINE CONNECTOR principal (the opaque revocable
//      `connectorBearer`, 012), NOT a human dashboard session and NOT a POS
//      device. This harness has no connector-token source yet. Provide one via
//      LOAD_CONNECTOR_TOKEN (single) or LOAD_CONNECTOR_TOKEN_{A,B,C} (per
//      synthetic tenant) once a connector-auth seam exists in the load env.
//
// When both prerequisites are met, this scenario runs as-is and emits the
// thresholds below. Until then it exits early with a clear skip notice (no
// synthetic / faked measurement is ever recorded).
//
// Usage (Docker, once a perf env + connector token exist):
//   docker run --rm -v "$PWD/loadtests/k6:/scripts" \
//     -e BASE_URL=https://perf.example.com \
//     -e LOAD_CONNECTOR_TOKEN_A=... -e LOAD_CONNECTOR_TOKEN_B=... \
//     grafana/k6:0.50.0 run /scripts/erpnext-posting.js \
//     --summary-export /scripts/last-erpnext-posting.json

import http from "k6/http";
import { check } from "k6";
import { SYNTHETIC_TENANTS } from "./lib/auth.js";
import { pickTenantForVu } from "./lib/tenants.js";
import { baseUrl, sleepJitter } from "./lib/util.js";

const DURATION = __ENV.LOAD_DURATION || "10m";
const VUS = parseInt(__ENV.LOAD_VUS || "20", 10);
const PAGE_LIMIT = __ENV.LOAD_PAGE_LIMIT || "100";

export const options = {
  scenarios: {
    posting_feed_pull: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "1m", target: VUS },
        { duration: DURATION, target: VUS },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  // The connector-feed read budget at the SaaS boundary. These are the
  // assertions; report-only until a perf env + connector-auth seam exist.
  // The feed is a cursor-paginated read backed by the partial index
  // idx_erpnext_posting_status_pending, so it should be well within these.
  thresholds: {
    "http_req_duration{flow:posting_feed_pull}": ["p(95)<400", "p(99)<800"],
    http_req_failed: ["rate<0.01"],
    "checks{kind:no_5xx}": ["rate>0.99"],
  },
};

// Machine connector bearer token for the tenant assigned to this VU. Single
// token via LOAD_CONNECTOR_TOKEN, or per-tenant via LOAD_CONNECTOR_TOKEN_{A,B,C}.
function connectorTokenFor(tenantSlug) {
  const letter = tenantSlug.slice(-1).toUpperCase();
  return (
    __ENV["LOAD_CONNECTOR_TOKEN_" + letter] ||
    __ENV.LOAD_CONNECTOR_TOKEN ||
    null
  );
}

export function setup() {
  // Fail fast (report-only) if the connector-auth prerequisite is unmet, rather
  // than hammering the endpoint with unauthenticated 401s and reporting noise.
  const anyToken = SYNTHETIC_TENANTS.some(
    (t) => connectorTokenFor(t) !== null,
  );
  if (!anyToken) {
    // eslint-disable-next-line no-console
    console.warn(
      "[erpnext-posting] SKIP: no LOAD_CONNECTOR_TOKEN[_A/_B/_C] provided — the " +
        "posting feed needs a machine connectorBearer token. Report-only per " +
        "015-POLISH T091. See header for prerequisites.",
    );
    return { enabled: false };
  }
  return { enabled: true };
}

// A connector drains the feed by following the cursor. Each VU keeps a local
// cursor and pages forward; on an empty/stable page it re-baselines from start
// (the connector's steady-state poll). Scope (tenant) comes from the token, so
// no query scope is ever sent (§XII).
export default function (data) {
  if (!data || !data.enabled) {
    // Prerequisite unmet — do not generate synthetic load or fake measurements.
    return;
  }

  const tenantSlug = pickTenantForVu(__VU, SYNTHETIC_TENANTS);
  const token = connectorTokenFor(tenantSlug);
  if (!token) {
    return;
  }

  const since = __ENV.__K6_CURSOR; // unset on first iter → from start
  const qs =
    "?limit=" + PAGE_LIMIT + (since ? "&since=" + encodeURIComponent(since) : "");
  const url = baseUrl() + "/api/connector/v1/erpnext/postings" + qs;
  const res = http.get(url, {
    headers: { authorization: "Bearer " + token },
    tags: { flow: "posting_feed_pull" },
  });

  check(
    res,
    { "feed 200": (r) => r.status === 200 },
    { kind: "no_5xx" },
  );

  // Advance the local cursor when the page carried one; otherwise re-baseline.
  try {
    const body = res.json();
    __ENV.__K6_CURSOR = body && body.next_page_token ? body.cursor : "";
  } catch (_e) {
    __ENV.__K6_CURSOR = "";
  }

  sleepJitter();
}
