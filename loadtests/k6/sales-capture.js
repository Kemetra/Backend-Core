// loadtests/k6/sales-capture.js
//
// 008-POLISH T090 — sale-capture performance scenario (SC-010).
//
// Measures inline single-sale capture latency at the SaaS boundary:
//   POST /api/pos/v1/sales  (operationId captureSale)
// against the SC-010 release gate: p95 <= 500 ms, p99 <= 1 s.
//
// ── REPORT-ONLY STATUS (read before running) ─────────────────────────────────
// Per the 008-POLISH slice stop condition ("report SC-010 as report-only if perf
// cannot be measured in a real env", 005 T560 precedent), this scenario is
// authored but NOT executed in CI and NOT asserted as a release gate yet,
// because two prerequisites are not satisfied in the current environment:
//
//   1. No dedicated perf environment. Latency numbers off a dev box / shared
//      runner are not representative; SC-010 must be measured against a
//      production-like deployment. Do NOT weaken the threshold to make a dev
//      box pass — that defeats the gate.
//   2. The sale endpoint authenticates a POS DEVICE principal (opaque bearer
//      token, `clerkJwt` per the contract), NOT the dashboard human session
//      that lib/auth.js establishes. This harness has no POS-device token
//      source yet. Provide a token via LOAD_POS_TOKEN (single) or
//      LOAD_POS_TOKEN_A/_B/_C (per synthetic tenant) when a POS-auth seam
//      exists in the load environment.
//
// When both prerequisites are met, this scenario runs as-is and emits the
// SC-010 thresholds below. Until then it exits early with a clear skip notice
// (no synthetic/faked measurement is ever recorded).
//
// Usage (Docker, once a perf env + POS token exist):
//   docker run --rm -v "$PWD/loadtests/k6:/scripts" \
//     -e BASE_URL=https://perf.example.com \
//     -e LOAD_POS_TOKEN_A=... -e LOAD_POS_TOKEN_B=... -e LOAD_POS_TOKEN_C=... \
//     -e LOAD_TENANT_A_ID=... -e LOAD_STORE_A_ID=... (etc.) \
//     grafana/k6:0.50.0 run /scripts/sales-capture.js \
//     --summary-export /scripts/last-sales-capture.json

import http from "k6/http";
import { check } from "k6";
import { SYNTHETIC_TENANTS } from "./lib/auth.js";
import { pickTenantForVu } from "./lib/tenants.js";
import { baseUrl, uuidv4, sleepJitter } from "./lib/util.js";

const DURATION = __ENV.LOAD_DURATION || "10m";
const VUS = parseInt(__ENV.LOAD_VUS || "20", 10);

export const options = {
  scenarios: {
    sales_capture: {
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
  // SC-010 release gate — the inline single-sale capture budget at the SaaS
  // boundary. These are the assertions; report-only until a perf env exists.
  thresholds: {
    "http_req_duration{flow:sales_capture}": ["p(95)<500", "p(99)<1000"],
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

// A faithful CaptureSaleRequest body (contract: CaptureSaleRequest). All money
// is exact-decimal string (no float); lines sum to posTotal so no advisory
// mismatch flag is raised. tenant_id/store_id/created_by are NEVER sent — they
// resolve server-side from the POS principal (FR-061).
function captureBody() {
  const ext = "perf-" + uuidv4();
  return JSON.stringify({
    sourceSystem: "k6-perf",
    externalId: ext,
    currencyCode: "USD",
    posTotal: "100.00",
    occurredAt: new Date().toISOString(),
    lines: [
      {
        lineName: "perf-line-a",
        unitPrice: "40.00",
        currencyCode: "USD",
        quantity: "1",
        lineAmount: "40.00",
        unit: "each",
      },
      {
        lineName: "perf-line-b",
        unitPrice: "60.00",
        currencyCode: "USD",
        quantity: "1",
        lineAmount: "60.00",
        unit: "each",
      },
    ],
  });
}

export function setup() {
  // Fail fast (report-only) if the POS-auth prerequisite is unmet, rather than
  // hammering the endpoint with unauthenticated 401s and reporting noise.
  const anyToken = SYNTHETIC_TENANTS.some((t) => posTokenFor(t) !== null);
  if (!anyToken) {
    // eslint-disable-next-line no-console
    console.warn(
      "[sales-capture] SKIP: no LOAD_POS_TOKEN[_A/_B/_C] provided — the sale " +
        "endpoint needs a POS-device bearer token. Report-only per SC-010 / " +
        "008-POLISH T090. See header for prerequisites.",
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
  if (!token) {
    return;
  }

  const url = baseUrl() + "/api/pos/v1/sales";
  const res = http.post(url, captureBody(), {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer " + token,
      // captureSale REQUIRES Idempotency-Key (contract FR-051). A fresh key per
      // request measures the create path (not the replay short-circuit).
      "Idempotency-Key": uuidv4(),
    },
    tags: { flow: "sales_capture", tenant: tenantSlug },
  });

  check(
    res,
    { "capture 201": (r) => r.status === 201 },
    { kind: "no_5xx" },
  );

  sleepJitter(0.5);
}
