// loadtests/k6/smoke.js
//
// Track A first-slice SMOKE test (T425).
//
// Goal: run one auth + tenant-context flow at ~5 RPS for 30s. Verify the
// load harness itself is healthy. NO latency gating — this is a sanity
// check, not a release gate.
//
// Pass condition: zero unexpected status codes (everything 2xx / 3xx).
//
// Usage (Docker, recommended):
//   docker run --rm -v "$PWD/loadtests/k6:/scripts" \
//     -e BASE_URL=http://host.docker.internal:3000 \
//     -e LOAD_USER_A_EMAIL=... -e LOAD_USER_A_PASSWORD=... \
//     grafana/k6:0.50.0 run /scripts/smoke.js
//
// Usage (bare CLI):
//   BASE_URL=http://localhost:3000 k6 run loadtests/k6/smoke.js

import { sleep } from "k6";
import { signIn, signOut, SYNTHETIC_TENANTS } from "./lib/auth.js";
import { establishContext, pickTenantForVu } from "./lib/tenants.js";

export const options = {
  // ~5 RPS sustained for 30s = ~150 iterations across a small VU pool.
  scenarios: {
    smoke: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 3,
      maxVUs: 6,
    },
  },
  // NO threshold gating in smoke. Track A treats smoke as a harness sanity
  // check; release gating starts at baseline.
  thresholds: {},
};

export default function () {
  const tenantSlug = pickTenantForVu(__VU, SYNTHETIC_TENANTS);

  const signin = signIn(tenantSlug);
  if (!signin.ok) {
    // Treat as configuration error, not a load-test failure. k6's summary
    // will still report the failed check.
    return;
  }

  establishContext(tenantSlug);

  // Small think-time so the constant-arrival-rate scheduler hands work
  // back to other VUs instead of bunching all calls on one VU.
  sleep(0.2);

  signOut();
}
