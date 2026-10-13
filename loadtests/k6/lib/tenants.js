// loadtests/k6/lib/tenants.js
//
// Shared tenant/store context helper for k6 scripts (Track A, T430).
//
// Establishes an active tenant (and optionally an active store) for the
// current authenticated session by calling the real context endpoints.
// Concurrent runs across at least three synthetic tenants are required
// (FR-A-009) — see SYNTHETIC_TENANTS in lib/auth.js.
//
// All requests go through the real guard chain. There is no bypass.
//
// Tenant/store IDs are read from operator env vars (NOT checked in):
//
//   LOAD_TENANT_A_ID / LOAD_TENANT_B_ID / LOAD_TENANT_C_ID
//   LOAD_STORE_A_ID  / LOAD_STORE_B_ID  / LOAD_STORE_C_ID
//
// Missing IDs cause the helper to fall back to the first tenant/store
// returned by the /context/me probe.

import http from "k6/http";
import { check } from "k6";
import { baseUrl, jsonHeaders } from "./util.js";

export function getActiveContext() {
  const url = baseUrl() + "/api/v1/context/me";
  const res = http.get(url, {
    headers: jsonHeaders(),
    tags: { flow: "context_get_me" },
  });
  let body = null;
  try {
    body = res.json();
  } catch (_e) {
    body = null;
  }
  return { status: res.status, body, _raw: res };
}

export function tenantIdFor(tenantSlug) {
  const letter = tenantSlug.slice(-1).toUpperCase();
  return __ENV["LOAD_TENANT_" + letter + "_ID"] || null;
}

export function storeIdFor(tenantSlug) {
  const letter = tenantSlug.slice(-1).toUpperCase();
  return __ENV["LOAD_STORE_" + letter + "_ID"] || null;
}

// Switch the active tenant for the current session.
// If tenantId is null, probes /context/me to find an available membership.
export function switchTenant(tenantSlug, opts) {
  let tenantId = (opts && opts.tenantId) || tenantIdFor(tenantSlug);

  if (!tenantId) {
    const ctx = getActiveContext();
    if (ctx.status === 200 && ctx.body && Array.isArray(ctx.body.memberships) && ctx.body.memberships.length > 0) {
      tenantId = ctx.body.memberships[0].tenant_id;
    }
  }

  if (!tenantId) {
    return { ok: false, status: 0, body: null, error: "no_tenant_id_available" };
  }

  const url = baseUrl() + "/api/v1/context/tenant";
  const res = http.post(url, JSON.stringify({ tenant_id: tenantId }), {
    headers: jsonHeaders(),
    tags: { flow: "context_switch_tenant", tenant: tenantSlug },
  });
  const ok = check(res, {
    "switch tenant 200": (r) => r.status === 200,
  });
  let body = null;
  try {
    body = res.json();
  } catch (_e) {
    body = null;
  }
  return { ok, status: res.status, body, tenantId };
}

// Switch the active store within the active tenant.
// If storeId is null, probes the current context for accessible_store_ids.
export function switchStore(tenantSlug, opts) {
  let storeId = (opts && opts.storeId) || storeIdFor(tenantSlug);

  if (!storeId) {
    const ctx = getActiveContext();
    if (ctx.status === 200 && ctx.body && Array.isArray(ctx.body.memberships)) {
      for (const m of ctx.body.memberships) {
        if (Array.isArray(m.accessible_store_ids) && m.accessible_store_ids.length > 0) {
          storeId = m.accessible_store_ids[0];
          break;
        }
      }
    }
  }

  if (!storeId) {
    return { ok: false, status: 0, body: null, error: "no_store_id_available" };
  }

  const url = baseUrl() + "/api/v1/context/store";
  const res = http.post(url, JSON.stringify({ store_id: storeId }), {
    headers: jsonHeaders(),
    tags: { flow: "context_switch_store", tenant: tenantSlug },
  });
  const ok = check(res, {
    "switch store 200": (r) => r.status === 200,
  });
  let body = null;
  try {
    body = res.json();
  } catch (_e) {
    body = null;
  }
  return { ok, status: res.status, body, storeId };
}

// Convenience: sign-in is the caller's responsibility (see lib/auth.js);
// this helper just establishes tenant + store on top of an existing session.
export function establishContext(tenantSlug, opts) {
  const t = switchTenant(tenantSlug, opts);
  if (!t.ok) return { ok: false, stage: "tenant", tenant: t };
  const s = switchStore(tenantSlug, opts);
  // Store is optional: many flows operate at the tenant level only. Caller
  // can treat a store-switch failure as soft.
  return { ok: true, tenant: t, store: s };
}

// Pick a tenant slug for this VU. With ≥3 synthetic tenants in the pool
// and VU IDs spanning many integers, modulo-3 gives concurrent coverage
// across all three (FR-A-009).
export function pickTenantForVu(vuId, pool) {
  const p = pool || ["tenant-load-A", "tenant-load-B", "tenant-load-C"];
  return p[(vuId - 1) % p.length];
}
