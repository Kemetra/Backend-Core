// loadtests/k6/lib/auth.js
//
// Shared auth helper for k6 scripts (Track A, T429).
//
// Signs into the SaaS API at POST /api/v1/auth/signin using synthetic-tenant
// credentials and returns whatever the server returns (status, response body,
// and the session cookie if Set-Cookie was issued).
//
// IMPORTANT (FR-A-010): this helper MUST NOT bypass AuthGuard,
// TenantContextGuard, or RolesGuard. It exercises the real public auth path
// exactly as a dashboard client would. There is no test-only short-circuit.
//
// Credentials are read from environment variables on the operator's host:
//
//   LOAD_USER_A_EMAIL / LOAD_USER_A_PASSWORD
//   LOAD_USER_B_EMAIL / LOAD_USER_B_PASSWORD
//   LOAD_USER_C_EMAIL / LOAD_USER_C_PASSWORD
//
// They are NOT checked into source. See ../fixtures/synthetic-tenants.md
// and ../README.md for the operator setup contract.

import http from "k6/http";
import { check } from "k6";
import { baseUrl, jsonHeaders } from "./util.js";

// Synthetic tenant identifiers used across all scripts. These names match
// the documented fixture profile in fixtures/synthetic-tenants.md.
export const SYNTHETIC_TENANTS = ["tenant-load-A", "tenant-load-B", "tenant-load-C"];

// Pull credentials for a given synthetic tenant from environment. Falls back
// to obvious placeholders when missing so that the script can still start
// (sign-in will then 401, which Track A treats as a configuration error,
// not a load-test failure).
export function credentialsFor(tenantSlug) {
  const letter = tenantSlug.slice(-1).toUpperCase(); // A | B | C
  const emailKey = "LOAD_USER_" + letter + "_EMAIL";
  const passKey = "LOAD_USER_" + letter + "_PASSWORD";
  return {
    email: __ENV[emailKey] || "load-" + letter.toLowerCase() + "@example.invalid",
    password: __ENV[passKey] || "PLACEHOLDER-SET-IN-OPERATOR-ENV",
  };
}

// Sign in. Returns:
//   {
//     ok:       boolean        — true if status was 200
//     status:   number         — HTTP status from the server
//     body:     object | null  — parsed JSON response if available
//     cookies:  object         — jar.cookiesForURL() result for BASE_URL,
//                                useful for subsequent context.switch calls
//     setCookie: string | null — raw Set-Cookie header (for debugging)
//   }
//
// Cookie-based sessions are kept inside k6's per-VU cookie jar (the http
// module does this automatically); subsequent requests in the same VU
// re-use the session.
export function signIn(tenantSlug, opts) {
  const creds = credentialsFor(tenantSlug);
  const url = baseUrl() + "/api/v1/auth/signin";
  const payload = JSON.stringify({ email: creds.email, password: creds.password });
  const params = {
    headers: jsonHeaders(),
    tags: { flow: "auth_signin", tenant: tenantSlug },
  };
  const res = http.post(url, payload, params);

  const ok = check(res, {
    "signin status is 200": (r) => r.status === 200,
  });

  let body = null;
  try {
    body = res.json();
  } catch (_e) {
    body = null;
  }

  const jar = http.cookieJar();
  const cookies = jar.cookiesForURL(baseUrl());

  return {
    ok,
    status: res.status,
    body,
    cookies,
    setCookie: res.headers["Set-Cookie"] || null,
    _raw: opts && opts.includeRaw ? res : null,
  };
}

// Sign out. Returns the raw k6 response so the caller can decide how to
// react. Sign-out is best-effort in load runs — failures do not abort.
export function signOut() {
  const url = baseUrl() + "/api/v1/auth/signout";
  return http.post(url, null, {
    headers: jsonHeaders(),
    tags: { flow: "auth_signout" },
  });
}

// Refresh the current sliding session. Used by baseline scenario #2.
export function refreshSession() {
  const url = baseUrl() + "/api/v1/auth/refresh";
  return http.post(url, null, {
    headers: jsonHeaders(),
    tags: { flow: "auth_refresh" },
  });
}
