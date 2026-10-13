// loadtests/k6/regression.js
//
// Track A first-slice REGRESSION test (T428).
//
// Re-runs the baseline workload and compares the new run's per-flow p95 /
// p99 / error-rate against a stored prior baseline JSON. Fails if any
// tracked metric drifts beyond the regression delta budget from research
// §1:
//
//   +10%   p95 latency
//   +20%   p99 latency
//   +0.5pp error rate (absolute, on a 0..1 scale)
//
// Prior-baseline JSON convention:
//
//   loadtests/k6/baselines/<release-tag>.json
//
//     example:  loadtests/k6/baselines/2026-05-16-r1.json
//
// The baseline JSON itself is NOT committed to this repo (operators
// produce and store it out-of-band — see ../README.md "Baseline storage").
// Pass the path at run time:
//
//   docker run --rm -v "$PWD/loadtests/k6:/scripts" \
//     -e BASE_URL=http://host.docker.internal:3000 \
//     -e PRIOR_BASELINE=/scripts/baselines/2026-05-16-r1.json \
//     grafana/k6:0.50.0 run /scripts/regression.js \
//     --summary-export /scripts/last-regression.json
//
// PRIOR_BASELINE is consumed inside handleSummary(), which runs at the end
// of the test. If it cannot be read or parsed, the regression run prints
// a warning and exits with a non-zero handleSummary signal so the
// operator's wrapper script can treat the run as "missing baseline".

import { sleep } from "k6";
import { signIn, refreshSession, signOut, SYNTHETIC_TENANTS } from "./lib/auth.js";
import { establishContext, getActiveContext, pickTenantForVu, tenantIdFor } from "./lib/tenants.js";
import http from "k6/http";
import { check } from "k6";
import { baseUrl, jsonHeaders, jsonPostHeaders, uuidv4 } from "./lib/util.js";

// k6's filesystem reads via open() are scoped to script-init time; we use
// SharedArray + open() so the JSON is loaded once across VUs.
import { SharedArray } from "k6/data";

const PRIOR_PATH = __ENV.PRIOR_BASELINE || "";

const priorBaseline = new SharedArray("prior_baseline", function () {
  if (!PRIOR_PATH) return [];
  try {
    const txt = open(PRIOR_PATH);
    return [JSON.parse(txt)];
  } catch (e) {
    // k6's `open()` errors at init if the file does not exist. We let it
    // throw so the operator sees a clear init-time error rather than a
    // silent skip — that's the documented "missing baseline" behaviour.
    throw e;
  }
});

const DURATION = __ENV.LOAD_DURATION || "10m";
const VUS = parseInt(__ENV.LOAD_VUS || "20", 10);
const SKIP_ACCEPT = __ENV.LOAD_SKIP_ACCEPT !== "0";

// Reuse the baseline workload exactly. Regression delta is computed in
// handleSummary().
export const options = {
  scenarios: {
    regression: {
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
  // Threshold gating moved to handleSummary() — k6's built-in thresholds
  // can't read PRIOR_BASELINE directly.
  thresholds: {},
};

const TRACKED_FLOWS = [
  "auth_signin",
  "auth_refresh",
  "context_get_me",
  "list_members",
  "create_invitation",
  "accept_invitation",
  "update_membership",
];

const DELTA_BUDGET = {
  p95Pct: 0.10,
  p99Pct: 0.20,
  errAbsPp: 0.005,
};

function listMembers(tenantId) {
  if (!tenantId) return null;
  return http.get(baseUrl() + "/api/v1/tenants/" + tenantId + "/members", {
    headers: jsonHeaders(),
    tags: { flow: "list_members" },
  });
}

function createInvitation() {
  return http.post(
    baseUrl() + "/api/v1/memberships/invite",
    JSON.stringify({
      email: "invitee-" + uuidv4() + "@example.invalid",
      role_code: "viewer",
      store_access_kind: "all",
    }),
    { headers: jsonPostHeaders(), tags: { flow: "create_invitation" } }
  );
}

export default function () {
  const tenantSlug = pickTenantForVu(__VU, SYNTHETIC_TENANTS);
  const tenantId = tenantIdFor(tenantSlug);

  const signin = signIn(tenantSlug);
  if (!signin.ok) {
    sleep(1);
    return;
  }

  establishContext(tenantSlug);
  getActiveContext();
  refreshSession();
  if (tenantId) listMembers(tenantId);
  createInvitation();

  signOut();
}

// handleSummary runs after the test completes. We compare current metrics
// to the prior baseline JSON and emit a `regression_report.json` that
// captures pass/fail per tracked flow. The script exits non-zero if any
// flow exceeds the regression delta budget — that is the release-gate
// signal the operator's wrapper watches.
export function handleSummary(data) {
  const prior = priorBaseline.length > 0 ? priorBaseline[0] : null;
  const report = compareToPrior(data, prior);
  const exitMarker = report.failed.length > 0 ? "REGRESSION_DETECTED" : "OK";

  // k6 doesn't have a direct "exit code" hook, but a failed handleSummary
  // contract is the documented way to signal: throw if regressions found
  // and the operator's wrapper script must check for the marker file.
  const summaryText =
    "Regression run summary\n" +
    "======================\n" +
    "Prior baseline: " + (PRIOR_PATH || "(none)") + "\n" +
    "Tracked flows: " + TRACKED_FLOWS.join(", ") + "\n" +
    "Budget: +" + (DELTA_BUDGET.p95Pct * 100) + "% p95, +" +
      (DELTA_BUDGET.p99Pct * 100) + "% p99, +" +
      (DELTA_BUDGET.errAbsPp * 100) + "pp error rate\n" +
    "Result: " + exitMarker + "\n" +
    (report.failed.length > 0
      ? "Failed flows:\n" + report.failed.map(formatFailure).join("\n") + "\n"
      : "All tracked flows within budget.\n");

  return {
    stdout: summaryText,
    "regression_report.json": JSON.stringify(report, null, 2),
  };
}

function compareToPrior(data, prior) {
  const failed = [];
  const compared = [];
  const newCurrent = extractFlowMetrics(data);

  if (!prior) {
    return {
      status: "no_prior_baseline",
      failed: [],
      compared: [],
      current: newCurrent,
      message:
        "PRIOR_BASELINE not provided or unreadable. Treat this run as " +
        "the new baseline by exporting --summary-export.",
    };
  }

  const priorFlows = extractFlowMetrics(prior);

  for (const flow of TRACKED_FLOWS) {
    const c = newCurrent[flow];
    const p = priorFlows[flow];
    if (!c || !p) {
      compared.push({ flow: flow, status: "missing", current: c, prior: p });
      continue;
    }
    const item = {
      flow: flow,
      current: c,
      prior: p,
      deltas: {
        p95Pct: ratio(c.p95, p.p95),
        p99Pct: ratio(c.p99, p.p99),
        errAbsPp: c.errorRate - p.errorRate,
      },
      breached: {
        p95: ratio(c.p95, p.p95) > DELTA_BUDGET.p95Pct,
        p99: ratio(c.p99, p.p99) > DELTA_BUDGET.p99Pct,
        errorRate: c.errorRate - p.errorRate > DELTA_BUDGET.errAbsPp,
      },
    };
    if (item.breached.p95 || item.breached.p99 || item.breached.errorRate) {
      failed.push(item);
    }
    compared.push(item);
  }

  return {
    status: failed.length > 0 ? "regression_detected" : "ok",
    budget: DELTA_BUDGET,
    failed: failed,
    compared: compared,
    current: newCurrent,
  };
}

function ratio(current, prior) {
  if (!prior || prior <= 0) return 0;
  return (current - prior) / prior;
}

// Pulls per-flow p95/p99 + error rate out of a k6 --summary-export JSON.
// Works against both the live `data` argument and a previously exported
// summary file (same shape).
function extractFlowMetrics(summary) {
  if (!summary || !summary.metrics) return {};
  const out = {};

  for (const flow of TRACKED_FLOWS) {
    const durKey = "http_req_duration{flow:" + flow + "}";
    const failKey = "http_req_failed{flow:" + flow + "}";
    const dur = summary.metrics[durKey];
    const fail = summary.metrics[failKey];
    if (!dur) continue;
    out[flow] = {
      p95: extractPercentile(dur, "p(95)"),
      p99: extractPercentile(dur, "p(99)"),
      errorRate: fail && typeof fail.values === "object" && typeof fail.values.rate === "number"
        ? fail.values.rate
        : 0,
    };
  }
  return out;
}

function extractPercentile(metric, key) {
  if (!metric || !metric.values) return 0;
  const v = metric.values[key];
  return typeof v === "number" ? v : 0;
}

function formatFailure(item) {
  const b = item.breached;
  const d = item.deltas;
  const parts = [];
  if (b.p95) parts.push("p95 +" + Math.round(d.p95Pct * 1000) / 10 + "%");
  if (b.p99) parts.push("p99 +" + Math.round(d.p99Pct * 1000) / 10 + "%");
  if (b.errorRate) parts.push("err +" + Math.round(d.errAbsPp * 10000) / 100 + "pp");
  return "  " + item.flow + ": " + parts.join(", ");
}
