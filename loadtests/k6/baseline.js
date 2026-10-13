// loadtests/k6/baseline.js
//
// Track A first-slice BASELINE test (T426).
//
// Runs the six candidate first-slice flows from plan §3.1.3 at expected
// production load for 5–15 minutes. Emits p95/p99/error-rate thresholds via
// options.thresholds — these are the release-gate signals for HTTP-side
// measurements. (DB / Redis / BullMQ / worker measures come from Track B
// signals, not from k6.)
//
// Six flows:
//   1. signIn                — POST /api/v1/auth/signin
//   2. refreshSession        — POST /api/v1/auth/refresh
//   3. getActiveContext      — GET  /api/v1/context/me
//   4. listMembers           — GET  /api/v1/tenants/{tenant_id}/members
//                              (audit-heavy tenant-scoped read)
//   5. createInvitation +
//      acceptInvitation      — POST /api/v1/memberships/invite +
//                              POST /api/v1/invitations/accept
//   6. updateMembership      — PATCH /api/v1/memberships/{membership_id}
//                              (governance / role grant-revoke)
//
// The acceptance leg of flow 5 requires an invitation token that the API
// returns via email side channel in production. The load harness MAY:
//   - capture the token from the createInvitation response when the load
//     environment is configured to return it (test-only behaviour); or
//   - skip the accept leg with LOAD_SKIP_ACCEPT=1 so baseline still covers
//     the invite-create path (default in this script).
//
// Usage (Docker):
//   docker run --rm -v "$PWD/loadtests/k6:/scripts" \
//     -e BASE_URL=http://host.docker.internal:3000 \
//     -e LOAD_USER_A_EMAIL=... -e LOAD_USER_A_PASSWORD=... \
//     -e LOAD_USER_B_EMAIL=... -e LOAD_USER_B_PASSWORD=... \
//     -e LOAD_USER_C_EMAIL=... -e LOAD_USER_C_PASSWORD=... \
//     grafana/k6:0.50.0 run /scripts/baseline.js \
//     --summary-export /scripts/last-baseline.json

import http from "k6/http";
import { check, group, sleep } from "k6";
import { signIn, refreshSession, signOut, SYNTHETIC_TENANTS } from "./lib/auth.js";
import {
  establishContext,
  getActiveContext,
  pickTenantForVu,
  tenantIdFor,
} from "./lib/tenants.js";
import { baseUrl, jsonHeaders, jsonPostHeaders, sleepJitter, uuidv4 } from "./lib/util.js";

const DURATION = __ENV.LOAD_DURATION || "10m";
const VUS = parseInt(__ENV.LOAD_VUS || "20", 10);
const SKIP_ACCEPT = __ENV.LOAD_SKIP_ACCEPT === "1";

export const options = {
  scenarios: {
    baseline: {
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
  // HTTP-side release gates. Adjust per release in the operator's run
  // wrapper via __ENV.* overrides if needed — defaults are intentionally
  // conservative for a first-slice baseline.
  thresholds: {
    "http_req_duration{flow:auth_signin}":         ["p(95)<800", "p(99)<2000"],
    "http_req_duration{flow:auth_refresh}":        ["p(95)<300", "p(99)<800"],
    "http_req_duration{flow:context_get_me}":      ["p(95)<300", "p(99)<800"],
    "http_req_duration{flow:list_members}":        ["p(95)<800", "p(99)<2000"],
    "http_req_duration{flow:create_invitation}":   ["p(95)<1000", "p(99)<2500"],
    "http_req_duration{flow:accept_invitation}":   ["p(95)<1500", "p(99)<3000"],
    "http_req_duration{flow:update_membership}":   ["p(95)<800", "p(99)<2000"],
    // Aggregate error rate under 1%
    http_req_failed: ["rate<0.01"],
    // No 5xx allowed at baseline (rate of 5xx-tagged requests).
    "checks{kind:no_5xx}": ["rate>0.99"],
  },
};

function listMembers(tenantId) {
  if (!tenantId) return null;
  const url = baseUrl() + "/api/v1/tenants/" + tenantId + "/members";
  const res = http.get(url, {
    headers: jsonHeaders(),
    tags: { flow: "list_members" },
  });
  check(res, { "list members 200": (r) => r.status === 200 }, { kind: "no_5xx" });
  return res;
}

function createInvitation() {
  const email = "invitee-" + uuidv4() + "@example.invalid";
  const payload = JSON.stringify({
    email: email,
    role_code: "viewer",
    store_access_kind: "all",
  });
  const url = baseUrl() + "/api/v1/memberships/invite";
  const res = http.post(url, payload, {
    headers: jsonPostHeaders(),
    tags: { flow: "create_invitation" },
  });
  check(
    res,
    { "create invitation 201 or 409": (r) => r.status === 201 || r.status === 409 },
    { kind: "no_5xx" }
  );

  // Some load-environment configurations return the invite token in the
  // response body to enable load-test acceptance. Otherwise, we skip accept.
  let token = null;
  try {
    const body = res.json();
    token = body && (body.token || (body.invitation && body.invitation.token)) || null;
  } catch (_e) {
    token = null;
  }
  return { res, token };
}

function acceptInvitation(token) {
  if (!token) return null;
  const url = baseUrl() + "/api/v1/invitations/accept";
  const res = http.post(
    url,
    JSON.stringify({
      token: token,
      password: "Load-Test-Password-" + uuidv4(),
      display_name: "Load Invitee",
    }),
    {
      headers: jsonPostHeaders(),
      tags: { flow: "accept_invitation" },
    }
  );
  check(res, { "accept invitation 200": (r) => r.status === 200 }, { kind: "no_5xx" });
  return res;
}

function updateMembershipFromContext() {
  // Pick a membership id from /context/me if available; otherwise skip.
  const ctx = getActiveContext();
  if (ctx.status !== 200 || !ctx.body) return null;

  // Membership IDs aren't exposed in /context/me memberships (only tenant_id).
  // The list-members response from earlier in this iteration carries them.
  // For first-slice baseline we accept that this flow may be skipped when
  // the load env doesn't expose membership IDs to the calling user — the
  // skip is reported by k6 as a zero-count metric for the flow.
  if (!ctx.body.active_tenant) return null;
  const tenantId = ctx.body.active_tenant.id;
  const list = listMembers(tenantId);
  if (!list || list.status !== 200) return null;
  let members = null;
  try {
    members = list.json();
  } catch (_e) {
    return null;
  }
  // members might be { data: [...] } or [...] depending on envelope; try both.
  const arr = Array.isArray(members) ? members : (members && members.data) || [];
  if (!arr.length) return null;
  const target = arr[Math.floor(Math.random() * arr.length)];
  if (!target || !target.id) return null;

  const url = baseUrl() + "/api/v1/memberships/" + target.id;
  const res = http.patch(
    url,
    JSON.stringify({ role_code: target.role_code || "viewer" }),
    {
      headers: jsonPostHeaders(),
      tags: { flow: "update_membership" },
    }
  );
  check(res, { "update membership 2xx": (r) => r.status >= 200 && r.status < 300 }, { kind: "no_5xx" });
  return res;
}

export default function () {
  const tenantSlug = pickTenantForVu(__VU, SYNTHETIC_TENANTS);
  const tenantId = tenantIdFor(tenantSlug);

  // Flow 1 — sign in
  const signin = signIn(tenantSlug);
  if (!signin.ok) {
    sleep(1);
    return;
  }

  // Flow 3 — establish active context (uses /context/me + switch tenant)
  group("context", function () {
    establishContext(tenantSlug);
    getActiveContext();
  });

  // Flow 2 — refresh session
  refreshSession();

  // Flow 4 — list members (tenant-scoped read with RLS)
  if (tenantId) {
    listMembers(tenantId);
  }

  // Flow 5 — create invitation (+ optional accept)
  const inv = createInvitation();
  if (!SKIP_ACCEPT && inv.token) {
    acceptInvitation(inv.token);
  }

  // Flow 6 — update membership (audit-heavy governance write)
  updateMembershipFromContext();

  sleepJitter(0.5);
  signOut();
}
