// loadtests/k6/catalog-read-down.js
//
// 010-POLISH T091 — POS catalogue read-down performance scenario (R8).
//
// Measures the snapshot + delta read latency at the SaaS boundary:
//   GET /api/pos/v1/catalog/snapshot  (operationId posGetCatalogSnapshot)
//   GET /api/pos/v1/catalog/deltas    (operationId posGetCatalogDeltas)
// against a ~50k-product store (the scale POS-Pulse 009 T054 measured, R8).
//
// ── REPORT-ONLY STATUS (read before running) ─────────────────────────────────
// Per the 010-POLISH stop condition + the 005 T560 / 008 SC-010 / 009 T100
// precedent: perf is REPORT-ONLY in v1 — there is no dedicated perf environment,
// so this scenario is authored but NOT executed in CI and NOT a release gate.
// Latency off a dev box / shared runner is not representative; the budget must
// be measured against a production-like, ~50k-product-seeded deployment. Do NOT
// weaken the thresholds to make a dev box pass.
//
// Read-down is a POS DEVICE-AUTH route (clerkJwt per the contract) — it needs a
// POS-device bearer token, NOT the dashboard human session. The harness has no
// POS-token source yet; provide one via LOAD_POS_TOKEN (single) or
// LOAD_POS_TOKEN_{A,B,C} (per-tenant). Until then the scenario skips cleanly
// rather than reporting noise — exactly the 008 sales-capture idiom.
//
// R8: snapshot/delta are latency-TOLERANT bulk reads (the offline replica
// absorbs latency; not the per-scan path). The budget below is a reasonable
// bulk-read target, not a per-scan SLA — pinned here for when a perf env exists.
//
// Usage (Docker, once a perf env + POS token exist):
//   docker run --rm -v "$PWD/loadtests/k6:/scripts" \
//     -e BASE_URL=https://perf.example.com \
//     -e LOAD_POS_TOKEN_A=... -e LOAD_POS_TOKEN_B=... \
//     grafana/k6:0.50.0 run /scripts/catalog-read-down.js \
//     --summary-export /scripts/last-catalog-read-down.json

import http from "k6/http";
import { check } from "k6";
import { SYNTHETIC_TENANTS } from "./lib/auth.js";
import { pickTenantForVu } from "./lib/tenants.js";
import { baseUrl, sleepJitter } from "./lib/util.js";

const DURATION = __ENV.LOAD_DURATION || "10m";
const VUS = parseInt(__ENV.LOAD_VUS || "20", 10);

export const options = {
  scenarios: {
    catalog_read_down: {
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
  // R8 bulk-read budget — the assertions; report-only until a perf env exists.
  // Snapshot is the heavier (paginated full-catalogue) read; delta is lighter.
  thresholds: {
    "http_req_duration{flow:catalog_snapshot}": ["p(95)<1000", "p(99)<2000"],
    "http_req_duration{flow:catalog_deltas}": ["p(95)<500", "p(99)<1000"],
    http_req_failed: ["rate<0.01"],
    "checks{kind:no_5xx}": ["rate>0.99"],
  },
};

// POS-device bearer token for the tenant assigned to this VU. Single token via
// LOAD_POS_TOKEN, or per-tenant via LOAD_POS_TOKEN_{A,B,C}.
function posTokenFor(tenantSlug) {
  const letter = tenantSlug.slice(-1).toUpperCase();
  return __ENV["LOAD_POS_TOKEN_" + letter] || __ENV.LOAD_POS_TOKEN || null;
}

export function setup() {
  // Fail fast (report-only) if the POS-auth prerequisite is unmet, rather than
  // hammering the endpoint with unauthenticated 401s and reporting noise.
  const anyToken = SYNTHETIC_TENANTS.some((t) => posTokenFor(t) !== null);
  if (!anyToken) {
    // eslint-disable-next-line no-console
    console.warn(
      "[catalog-read-down] SKIP: no LOAD_POS_TOKEN[_A/_B/_C] provided — the " +
        "read-down endpoints need a POS-device bearer token. Report-only per " +
        "010-POLISH T091 / R8. See header for prerequisites.",
    );
    return { enabled: false };
  }
  return { enabled: true };
}

export default function (data) {
  if (!data || !data.enabled) {
    // Prerequisite unmet — do not generate synthetic load or fake measurements.
    return;
  }

  const tenantSlug = pickTenantForVu(__VU, SYNTHETIC_TENANTS);
  const token = posTokenFor(tenantSlug);
  if (!token) return;

  const headers = {
    Accept: "application/json",
    Authorization: "Bearer " + token,
  };

  // 1) Snapshot — the full resolved sellable catalogue at a server cursor. The
  //    cursor is returned for the follow-on delta read (mirrors a terminal's
  //    baseline-then-advance flow).
  const snapRes = http.get(`${baseUrl()}/api/pos/v1/catalog/snapshot`, {
    headers,
    tags: { flow: "catalog_snapshot", tenant: tenantSlug },
  });
  check(snapRes, { "snapshot 200": (r) => r.status === 200 }, { flow: "catalog_snapshot" });
  check(snapRes, { "no 5xx": (r) => r.status < 500 }, { kind: "no_5xx" });

  // 2) Delta — advance from the snapshot cursor (the steady-state per-change read).
  let cursor = null;
  try {
    cursor = snapRes.json("cursor");
  } catch (_e) {
    cursor = null;
  }
  if (cursor) {
    const deltaRes = http.get(
      `${baseUrl()}/api/pos/v1/catalog/deltas?since=${encodeURIComponent(cursor)}`,
      { headers, tags: { flow: "catalog_deltas", tenant: tenantSlug } },
    );
    check(deltaRes, { "deltas 200": (r) => r.status === 200 }, { flow: "catalog_deltas" });
    check(deltaRes, { "no 5xx": (r) => r.status < 500 }, { kind: "no_5xx" });
  }

  sleepJitter(1);
}
