/**
 * RT-430 — Origin check for cookie-authenticated unsafe requests (CSRF).
 *
 * The `dp2_session` cookie is `SameSite=Lax`, so a browser does not send it
 * on a cross-site POST. Same-site sibling origins (other subdomains of the
 * same registrable domain) still send it, and Nest's default `urlencoded`
 * body parser lets a plain HTML form POST reach a handler without a CORS
 * preflight. So an unsafe request (`POST`, `PUT`, `PATCH`, `DELETE`)
 * authenticated by the cookie must carry an `Origin` that is either the
 * API's own origin or listed in `ALLOWED_ORIGINS`; otherwise it is refused
 * with 403 `origin_rejected`.
 *
 * Owner decision on RT-430 (2026-10-12):
 *   - mechanism (a): an `Origin` check, the same rule as RT-414 decision 5,
 *     so this module is the one implementation both use;
 *   - a missing `Origin` is refused (browsers always send it on these
 *     methods; non-browser cookie clients must send it);
 *   - the API's own origin is derived from the request `Host` header, which
 *     a browser attacker cannot set. The scheme is `https` wherever the
 *     session cookie is `Secure`, so it does not depend on `TRUST_PROXY`;
 *   - sign-in refuses a foreign `Origin` but admits a missing one, since it
 *     carries no ambient credential.
 *
 * Bearer, POS device-token and operator-envelope requests are not checked:
 * they are not ambient credentials.
 */
import { ForbiddenException } from "@nestjs/common";
import type { Request } from "express";

export const ORIGIN_REJECTED = "origin_rejected";

/** Methods that must carry a trusted `Origin` when cookie-authenticated. */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isUnsafeMethod(method: string | undefined): boolean {
  return typeof method === "string" && UNSAFE_METHODS.has(method.toUpperCase());
}

/**
 * Whether the session cookie carries `Secure`. Outside `test` and
 * `development` it does, so the API is only reachable with the cookie over
 * HTTPS and its own origin's scheme is `https`.
 */
export function sessionCookieSecure(): boolean {
  const env = process.env["NODE_ENV"];
  return env !== "test" && env !== "development";
}

export type OriginVerdict = "trusted" | "missing" | "foreign";

type OriginRequest = Pick<Request, "headers"> & { protocol?: string };

export function checkRequestOrigin(request: OriginRequest): OriginVerdict {
  const header = request.headers["origin"];
  if (typeof header !== "string" || header.trim().length === 0) return "missing";

  const origin = serializeOrigin(header.trim());
  if (origin === null) return "foreign";
  if (allowedOrigins().has(origin)) return "trusted";
  return origin === ownOrigin(request) ? "trusted" : "foreign";
}

/**
 * Throws 403 `origin_rejected` unless the request's `Origin` is trusted.
 * `allowMissing` admits a request with no `Origin` (sign-in only).
 */
export function assertTrustedOrigin(
  request: OriginRequest,
  options: { allowMissing?: boolean } = {},
): void {
  const verdict = checkRequestOrigin(request);
  if (verdict === "trusted") return;
  if (verdict === "missing" && options.allowMissing === true) return;
  throw new ForbiddenException({
    code: ORIGIN_REJECTED,
    message: "Request origin is not allowed",
  });
}

function ownOrigin(request: OriginRequest): string | null {
  const host = request.headers["host"];
  if (typeof host !== "string" || host.trim().length === 0) return null;
  const scheme = sessionCookieSecure() ? "https" : (request.protocol ?? "http");
  return serializeOrigin(`${scheme}://${host.trim()}`);
}

/** `ALLOWED_ORIGINS` (comma-separated), the same list `main.ts` gives CORS. */
function allowedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const entry of (process.env["ALLOWED_ORIGINS"] ?? "").split(",")) {
    const origin = serializeOrigin(entry.trim());
    if (origin !== null) origins.add(origin);
  }
  return origins;
}

/**
 * Normalizes an origin to `scheme://host[:port]` (lowercase, default port
 * dropped). Returns null for anything that is not an http(s) origin, which
 * includes the opaque `null` origin.
 */
function serializeOrigin(value: string): string | null {
  if (value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}
