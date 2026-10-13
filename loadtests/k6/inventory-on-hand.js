// loadtests/k6/inventory-on-hand.js
//
// 009-POLISH T100 — inventory on-hand read performance scenario (plan §1.4).
//
// Measures the compute-on-read on-hand latency at the SaaS boundary:
//   GET /api/inventory/v1/on-hand/{storeId}/{productId}  (operationId getOnHand)
// against the plan §1.4 budget: p95 <= 300 ms.
//
// ── REPORT-ONLY STATUS (read before running) ─────────────────────────────────
// Per the 009-POLISH slice stop condition ("perf is report-only in v1 — no perf
// env; 005 T560 / 008 T090 precedent"), this scenario is authored but NOT
// executed in CI and NOT asserted as a release gate, because there is no
// dedicated perf environment. Latency numbers off a dev box / shared runner are
// not representative; the budget must be measured against a production-like
// deployment. Do NOT weaken the threshold to make a dev box pass — that defeats
// the purpose. Unlike the 008 POS-capture scenario, the inventory read is a
// DASHBOARD cookieAuth route, so lib/auth.js's session establishes auth (no POS
// token needed) — the only missing prerequisite is the perf env itself.
//
// When a perf env exists, this runs as-is and emits the threshold below.
//
// Usage (Docker, once a perf env exists):
//   docker run --rm -v "$PWD/loadtests/k6:/scripts" \
//     -e BASE_URL=https://perf.example.com \
//     -e LOAD_TENANT_A_ID=... -e LOAD_STORE_A_ID=... -e LOAD_PRODUCT_A_ID=... (etc.) \
//     grafana/k6:0.50.0 run /scripts/inventory-on-hand.js \
//     --summary-export /scripts/last-inventory-on-hand.json

import http from "k6/http";
import { check } from "k6";
import { SYNTHETIC_TENANTS, signIn } from "./lib/auth.js";
import { pickTenantForVu } from "./lib/tenants.js";
import { baseUrl, sleepJitter } from "./lib/util.js";

const DURATION = __ENV.LOAD_DURATION || "10m";
const VUS = parseInt(__ENV.LOAD_VUS || "20", 10);

export const options = {
  scenarios: {
    inventory_on_hand: {
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
  // plan §1.4 on-hand read budget — the assertion; report-only until a perf env.
  thresholds: {
    "http_req_duration{flow:inventory_on_hand}": ["p(95)<300"],
    http_req_failed: ["rate<0.01"],
    "checks{kind:no_5xx}": ["rate>0.99"],
  },
};

// Per-tenant on-hand target — a (store, product) seeded in the perf env. Sent
// as path params; tenant resolves server-side from the dashboard session.
function targetFor(tenantSlug) {
  const letter = tenantSlug.slice(-1).toUpperCase();
  const storeId = __ENV["LOAD_STORE_" + letter + "_ID"] || __ENV.LOAD_STORE_ID;
  const productId =
    __ENV["LOAD_PRODUCT_" + letter + "_ID"] || __ENV.LOAD_PRODUCT_ID;
  return { storeId, productId };
}

export default function () {
  const tenantSlug = pickTenantForVu(__VU, SYNTHETIC_TENANTS);
  const session = signIn(tenantSlug);
  if (!session || !session.cookies) {
    // No dashboard session → cannot measure; skip without faking a number.
    return;
  }
  const { storeId, productId } = targetFor(tenantSlug);
  if (!storeId || !productId) {
    // Perf env not provisioned with a seeded (store, product) — skip cleanly.
    return;
  }

  const res = http.get(
    `${baseUrl()}/api/inventory/v1/on-hand/${storeId}/${productId}`,
    { tags: { flow: "inventory_on_hand" } },
  );
  check(res, { "status is 200": (r) => r.status === 200 }, { flow: "inventory_on_hand" });
  check(res, { "no 5xx": (r) => r.status < 500 }, { kind: "no_5xx" });

  sleepJitter(1);
}
