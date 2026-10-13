// loadtests/k6/inventory-movement.js
//
// 009-POLISH T100 — inventory movement-creation performance scenario (plan §1.4).
//
// Measures manual movement-append latency at the SaaS boundary:
//   POST /api/inventory/v1/stores/{storeId}/movements  (operationId createStockMovement)
// against the plan §1.4 budget: p95 <= 400 ms.
//
// ── REPORT-ONLY STATUS (read before running) ─────────────────────────────────
// Per the 009-POLISH slice stop condition ("perf is report-only in v1 — no perf
// env; 005 T560 / 008 T090 precedent"), this scenario is authored but NOT
// executed in CI and NOT asserted as a release gate, because there is no
// dedicated perf environment. Latency off a dev box / shared runner is not
// representative; measure against a production-like deployment. Do NOT weaken
// the threshold to make a dev box pass. This is a DASHBOARD cookieAuth route, so
// lib/auth.js's session establishes auth; the only missing prerequisite is the
// perf env itself.
//
// Each request carries a unique Idempotency-Key (a fresh append per iteration —
// the interceptor is exercised on the happy path, not the replay path). Movement
// bodies are inbound + positive so they never drive on-hand negative; tenant /
// store / actor are NEVER sent (resolved server-side, FR-052).
//
// Usage (Docker, once a perf env exists):
//   docker run --rm -v "$PWD/loadtests/k6:/scripts" \
//     -e BASE_URL=https://perf.example.com \
//     -e LOAD_STORE_A_ID=... -e LOAD_PRODUCT_A_ID=... (etc.) \
//     grafana/k6:0.50.0 run /scripts/inventory-movement.js \
//     --summary-export /scripts/last-inventory-movement.json

import http from "k6/http";
import { check } from "k6";
import { SYNTHETIC_TENANTS, signIn } from "./lib/auth.js";
import { pickTenantForVu } from "./lib/tenants.js";
import { baseUrl, uuidv4, jsonPostHeaders, sleepJitter } from "./lib/util.js";

const DURATION = __ENV.LOAD_DURATION || "10m";
const VUS = parseInt(__ENV.LOAD_VUS || "20", 10);

export const options = {
  scenarios: {
    inventory_movement: {
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
  // plan §1.4 movement-create budget — the assertion; report-only until a perf env.
  thresholds: {
    "http_req_duration{flow:inventory_movement}": ["p(95)<400"],
    http_req_failed: ["rate<0.01"],
    "checks{kind:no_5xx}": ["rate>0.99"],
  },
};

function targetFor(tenantSlug) {
  const letter = tenantSlug.slice(-1).toUpperCase();
  const storeId = __ENV["LOAD_STORE_" + letter + "_ID"] || __ENV.LOAD_STORE_ID;
  const productId =
    __ENV["LOAD_PRODUCT_" + letter + "_ID"] || __ENV.LOAD_PRODUCT_ID;
  return { storeId, productId };
}

// A faithful CreateStockMovementCommand body. Inbound + positive so on-hand
// never goes negative; reason carries no PII. tenant/store/actor NEVER sent.
function movementBody(productId) {
  return JSON.stringify({
    movementType: "inbound",
    quantity: "1.0000",
    stockingUnit: "ea",
    tenantProductRef: productId,
    reason: "k6-perf inbound",
  });
}

export default function () {
  const tenantSlug = pickTenantForVu(__VU, SYNTHETIC_TENANTS);
  const session = signIn(tenantSlug);
  if (!session || !session.cookies) {
    return;
  }
  const { storeId, productId } = targetFor(tenantSlug);
  if (!storeId || !productId) {
    return;
  }

  // Unique Idempotency-Key per iteration → a fresh append (happy path), not a
  // replay. The interceptor requires the header on this route.
  const headers = jsonPostHeaders();
  headers["Idempotency-Key"] = uuidv4();

  const res = http.post(
    `${baseUrl()}/api/inventory/v1/stores/${storeId}/movements`,
    movementBody(productId),
    { headers, tags: { flow: "inventory_movement" } },
  );
  check(res, { "status is 201": (r) => r.status === 201 }, { flow: "inventory_movement" });
  check(res, { "no 5xx": (r) => r.status < 500 }, { kind: "no_5xx" });

  sleepJitter(1);
}
