// loadtests/k6/erpnext-reconciliation.js
//
// 017-POLISH (T091) — ERPNext reconciliation backlog performance scenario (report-only).
//
// Measures the operator backlog list at the SaaS boundary:
//   GET /api/v1/catalog/erpnext-reconciliation/postings/backlog (listPostingBacklog)
// the read-projection over the 015 permanently_rejected posting dead-letters.
//
// ── REPORT-ONLY STATUS (read before running) ─────────────────────────────────
// Per the 017-POLISH stop condition ("report perf as report-only if it cannot be
// measured in a real env"; the 005 T560 / 008 / 009 / 010 / 015 precedent), this
// scenario is authored but NOT executed in CI and NOT asserted as a release gate,
// because two prerequisites are unmet:
//
//   1. No dedicated perf environment. Latency off a dev box / shared runner is not
//      representative. Do NOT weaken the thresholds to make a dev box pass.
//   2. The surface authenticates a HUMAN dashboard session (cookieAuth dp2_session)
//      — provide a session cookie via LOAD_SESSION_COOKIE (single) or
//      LOAD_SESSION_COOKIE_{A,B,C} (per synthetic tenant) once a dashboard-session
//      seam exists in the load env.
//
// When both prerequisites are met, this scenario runs as-is and emits the
// thresholds below. Until then it exits early with a clear skip notice.
//
// Usage (Docker, once a perf env + session exist):
//   docker run --rm -v "$PWD/loadtests/k6:/scripts" \
//     -e BASE_URL=https://perf.example.com \
//     -e LOAD_SESSION_COOKIE_A=... -e LOAD_SESSION_COOKIE_B=... \
//     grafana/k6:0.50.0 run /scripts/erpnext-reconciliation.js \
//     --summary-export /scripts/last-erpnext-reconciliation.json

import http from "k6/http";
import { check } from "k6";
import { SYNTHETIC_TENANTS } from "./lib/auth.js";
import { pickTenantForVu } from "./lib/tenants.js";
import { baseUrl, sleepJitter } from "./lib/util.js";

const DURATION = __ENV.LOAD_DURATION || "10m";
const VUS = parseInt(__ENV.LOAD_VUS || "20", 10);

export const options = {
  scenarios: {
    reconciliation_backlog: {
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
  // The operator backlog read budget. Report-only until a perf env + session seam
  // exist; the list is index-assisted (provenance) over a small dead-letter set.
  thresholds: {
    "http_req_duration{flow:reconciliation_backlog}": ["p(95)<400", "p(99)<800"],
    http_req_failed: ["rate<0.01"],
    "checks{kind:no_5xx}": ["rate>0.99"],
  },
};

function sessionCookieFor(tenantSlug) {
  const letter = tenantSlug.slice(-1).toUpperCase();
  return (
    __ENV["LOAD_SESSION_COOKIE_" + letter] || __ENV.LOAD_SESSION_COOKIE || null
  );
}

export function setup() {
  const anyCookie = SYNTHETIC_TENANTS.some((t) => sessionCookieFor(t) !== null);
  if (!anyCookie) {
    // eslint-disable-next-line no-console
    console.warn(
      "[erpnext-reconciliation] SKIP: no LOAD_SESSION_COOKIE[_A/_B/_C] provided — " +
        "the backlog needs a dashboard session cookie. Report-only per 017-POLISH " +
        "T091. See header for prerequisites.",
    );
    return { enabled: false };
  }
  return { enabled: true };
}

export default function (data) {
  if (!data || !data.enabled) {
    return; // Prerequisite unmet — no synthetic load, no faked measurement.
  }
  const tenantSlug = pickTenantForVu(__VU, SYNTHETIC_TENANTS);
  const cookie = sessionCookieFor(tenantSlug);
  if (!cookie) return;

  const url = baseUrl() + "/api/v1/catalog/erpnext-reconciliation/postings/backlog?limit=100";
  const res = http.get(url, {
    headers: { cookie: "dp2_session=" + cookie },
    tags: { flow: "reconciliation_backlog" },
  });
  check(res, { "backlog 200": (r) => r.status === 200 }, { kind: "no_5xx" });
  sleepJitter();
}
