// loadtests/k6/lib/util.js
//
// Shared helpers for k6 scripts:
//   - BASE_URL resolver (reads __ENV.BASE_URL, defaults to http://localhost:3000)
//   - uuidv4()         — RFC 4122 v4 generator used for Idempotency-Key headers
//   - jsonHeaders()    — base headers for JSON requests (forward-compat
//                        Idempotency-Key included on POST flows where it
//                        helps Track D adoption later)
//   - sleepJitter()    — small randomized think-time
//
// k6 stdlib only — no npm imports.

import { sleep } from "k6";
import crypto from "k6/crypto";

export function baseUrl() {
  return stripTrailingSlashes(__ENV.BASE_URL || "http://localhost:3000");
}

// A linear scan, not /\/+$/ — that regex backtracks quadratically (S8786).
function stripTrailingSlashes(url) {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

// k6/crypto.randomBytes is a CSPRNG available in every supported k6 release
// (the pinned runtime is grafana/k6:0.50.0), so there is no Math.random fallback.
export function uuidv4() {
  const bytes = new Uint8Array(crypto.randomBytes(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuidBytes(bytes);
}

function formatUuidBytes(bytes) {
  const hex = [];
  for (let i = 0; i < 16; i++) {
    hex.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

export function jsonHeaders(extra) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (extra) {
    for (const k in extra) headers[k] = extra[k];
  }
  return headers;
}

// Headers for POST flows. Includes an Idempotency-Key by default so that
// when Track D enables per-endpoint policy on these routes the load harness
// will already exercise the replay/conflict/425 paths instead of all-new
// keys. Pass { idempotencyKey: false } to omit.
export function jsonPostHeaders(opts) {
  const o = opts || {};
  const h = jsonHeaders(o.extra);
  if (o.idempotencyKey !== false) {
    h["Idempotency-Key"] = o.key || uuidv4();
  }
  return h;
}

export function sleepJitter(maxSeconds) {
  const m = typeof maxSeconds === "number" ? maxSeconds : 1;
  sleep(Math.random() * m);
}
