// loadtests/k6/stress.js
//
// Track A first-slice STRESS test (T427).
//
// Same six flows as baseline.js, ramped beyond expected production load
// until the platform's first failure signal (latency cliff, 5xx surge,
// pool exhaustion). On-demand only — NOT a release gate. Produces a
// breakpoint report.
//
// What "breakpoint" means in this script:
//   - VUs ramp from 0 to LOAD_STRESS_MAX_VUS (default 300) over
//     LOAD_STRESS_RAMP (default 10m).
//   - Plateau at peak for LOAD_STRESS_PLATEAU (default 5m).
//   - Ramp down over 1m.
//   - k6 reports per-flow p95/p99 and 4xx/5xx rates; operator inspects the
//     summary JSON to identify the inflection point.
//
// NO thresholds — stress runs are observational, not pass/fail.
//
// Usage (Docker):
//   docker run --rm -v "$PWD/loadtests/k6:/scripts" \
//     -e BASE_URL=http://host.docker.internal:3000 \
//     -e LOAD_STRESS_MAX_VUS=300 -e LOAD_STRESS_RAMP=10m -e LOAD_STRESS_PLATEAU=5m \
//     grafana/k6:0.50.0 run /scripts/stress.js \
//     --summary-export /scripts/last-stress.json

import http from "k6/http";
import { check, sleep } from "k6";
import { signIn, refreshSession, signOut, SYNTHETIC_TENANTS } from "./lib/auth.js";
import {
  establishContext,
  getActiveContext,
  pickTenantForVu,
  tenantIdFor,
} from "./lib/tenants.js";
import { baseUrl, jsonHeaders, jsonPostHeaders, uuidv4 } from "./lib/util.js";

const MAX_VUS = parseInt(__ENV.LOAD_STRESS_MAX_VUS || "300", 10);
const RAMP = __ENV.LOAD_STRESS_RAMP || "10m";
const PLATEAU = __ENV.LOAD_STRESS_PLATEAU || "5m";

export const options = {
  scenarios: {
    stress: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: RAMP, target: MAX_VUS },
        { duration: PLATEAU, target: MAX_VUS },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  // NO thresholds. Stress is observational.
  thresholds: {},
};

function listMembers(tenantId) {
  if (!tenantId) return null;
  return http.get(baseUrl() + "/api/v1/tenants/" + tenantId + "/members", {
    headers: jsonHeaders(),
    tags: { flow: "list_members" },
  });
}

function createInvitation() {
  const email = "invitee-" + uuidv4() + "@example.invalid";
  return http.post(
    baseUrl() + "/api/v1/memberships/invite",
    JSON.stringify({
      email: email,
      role_code: "viewer",
      store_access_kind: "all",
    }),
    { headers: jsonPostHeaders(), tags: { flow: "create_invitation" } }
  );
}

function updateOneMembership(tenantId) {
  if (!tenantId) return null;
  const list = listMembers(tenantId);
  if (!list || list.status !== 200) return null;
  let members;
  try {
    members = list.json();
  } catch (_e) {
    return null;
  }
  const arr = Array.isArray(members) ? members : (members && members.data) || [];
  if (!arr.length) return null;
  const target = arr[Math.floor(Math.random() * arr.length)];
  if (!target || !target.id) return null;
  return http.patch(
    baseUrl() + "/api/v1/memberships/" + target.id,
    JSON.stringify({ role_code: target.role_code || "viewer" }),
    { headers: jsonPostHeaders(), tags: { flow: "update_membership" } }
  );
}

export default function () {
  const tenantSlug = pickTenantForVu(__VU, SYNTHETIC_TENANTS);
  const tenantId = tenantIdFor(tenantSlug);

  const signin = signIn(tenantSlug);
  if (!signin.ok) {
    sleep(0.5);
    return;
  }

  establishContext(tenantSlug);
  getActiveContext();
  refreshSession();

  if (tenantId) listMembers(tenantId);

  createInvitation();
  updateOneMembership(tenantId);

  signOut();
}
