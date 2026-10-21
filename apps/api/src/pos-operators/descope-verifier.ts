/**
 * Descope session-JWT verifier — RT-791 (RT-790 approach A).
 *
 * Same seam as the Clerk verifier (`ClerkVerifier.verify(jwt) -> { sub }`), so
 * every caller (sign-in, shifts, audit events, the identity adapter) is
 * unchanged. Verification uses `jose` against the Descope project JWKS:
 *
 *   - signature: keys from `https://api.descope.com/<projectId>/.well-known/jwks.json`,
 *     algorithm allow-list `RS256` (no `none`, no HMAC, no EC);
 *   - `iss` pinned to `https://api.descope.com/<projectId>` or the bare
 *     `<projectId>` (older Descope projects), or exactly `DESCOPE_JWT_ISSUER`
 *     when set; the lab-minted token decides which;
 *   - `exp` required, small clock tolerance;
 *   - `aud` checked only when `DESCOPE_JWT_AUDIENCE` is set;
 *   - a token marked as a refresh token (`drn: "DSR"`) is refused — only the
 *     session JWT is an operator credential.
 *
 * Fail closed: any failure (signature, claims, JWKS fetch, malformed input)
 * throws ONE generic error with no cause and no claims attached — jose's claim
 * errors carry the decoded payload (incl. `sub`), which must never reach a log.
 * The raw token is never logged, persisted or returned (FR-POS-AUTH-10).
 */
import { Injectable } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import type { ClerkVerifiedClaims, ClerkVerifier } from "./clerk-verifier";

export const DESCOPE_API_BASE = "https://api.descope.com";

/** Descope project ids are short alphanumeric strings; anything else is a config error. */
const PROJECT_ID_RE = /^[A-Za-z0-9]{1,64}$/;

const ALLOWED_ALGORITHMS = ["RS256"];
const CLOCK_TOLERANCE_SECONDS = 5;
const JWKS_TIMEOUT_MS = 5_000;
const REFRESH_TOKEN_DRN = "DSR";

const REJECTED = "descope verifier: token rejected";

function assertProjectId(projectId: string): string {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error("DESCOPE_PROJECT_ID is malformed (expected an alphanumeric project id)");
  }
  return projectId;
}

/** The issuer Descope stamps on session JWTs for a project. */
export function descopeIssuer(projectId: string): string {
  return `${DESCOPE_API_BASE}/${assertProjectId(projectId)}`;
}

/** The project JWKS endpoint. */
export function descopeJwksUrl(projectId: string): string {
  return `${DESCOPE_API_BASE}/${assertProjectId(projectId)}/.well-known/jwks.json`;
}

/** The configured issuer: `DESCOPE_JWT_ISSUER` when set, else derived from the project id. */
export function configuredDescopeIssuer(projectId: string): string {
  const override = (process.env["DESCOPE_JWT_ISSUER"] ?? "").trim();
  return override.length > 0 ? override : descopeIssuer(projectId);
}

/**
 * The `iss` values the verifier accepts. Without an override, both forms Descope
 * is known to stamp for this project: the URL and the bare project id (older
 * projects). Either way the signature is checked against THIS project's JWKS.
 */
export function acceptedDescopeIssuers(projectId: string): string[] {
  const override = (process.env["DESCOPE_JWT_ISSUER"] ?? "").trim();
  return override.length > 0 ? [override] : [descopeIssuer(projectId), projectId];
}

/** jose error codes are fixed `ERR_*` identifiers — safe to log; messages and payloads are not. */
const SAFE_ERROR_CODE_RE = /^ERR_[A-Z_]{1,64}$/;

function rejected(err?: unknown): Error {
  const code = (err as { code?: unknown } | undefined)?.code;
  return new Error(
    typeof code === "string" && SAFE_ERROR_CODE_RE.test(code) ? `${REJECTED} (${code})` : REJECTED,
  );
}

export interface DescopeVerifierOptions {
  readonly issuer: string | readonly string[];
  readonly jwks: JWTVerifyGetKey;
  readonly audience?: string;
}

@Injectable()
export class DescopeJwksVerifier implements ClerkVerifier {
  constructor(private readonly options: DescopeVerifierOptions) {}

  async verify(rawJwt: string): Promise<ClerkVerifiedClaims> {
    let sub: unknown;
    let drn: unknown;
    try {
      const { payload } = await jwtVerify(rawJwt, this.options.jwks, {
        issuer: typeof this.options.issuer === "string" ? this.options.issuer : [...this.options.issuer],
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["exp", "sub"],
        ...(this.options.audience !== undefined ? { audience: this.options.audience } : {}),
      });
      sub = payload.sub;
      drn = payload["drn"];
    } catch (err) {
      // Deliberately drop the cause and message: they can carry the decoded
      // claims. Only jose's fixed error code survives (outage vs forgery triage).
      throw rejected(err);
    }
    if (typeof sub !== "string" || sub.length === 0 || drn === REFRESH_TOKEN_DRN) {
      throw rejected();
    }
    return { sub };
  }
}

/**
 * Factory used when `IDENTITY_PROVIDER=descope`. Production requires
 * `DESCOPE_PROJECT_ID`; non-production boots without it but every verification
 * fails closed. Building the remote JWKS makes no request (fetched on first use).
 */
export function descopeVerifierFactory(): ClerkVerifier {
  const projectId = (process.env["DESCOPE_PROJECT_ID"] ?? "").trim();
  if (projectId === "") {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error("PosOperatorsModule: DESCOPE_PROJECT_ID is required in production");
    }
    return {
      async verify(): Promise<ClerkVerifiedClaims> {
        throw new Error("descope verifier: DESCOPE_PROJECT_ID not configured (fail closed)");
      },
    };
  }
  const audience = (process.env["DESCOPE_JWT_AUDIENCE"] ?? "").trim();
  return new DescopeJwksVerifier({
    issuer: acceptedDescopeIssuers(projectId),
    jwks: createRemoteJWKSet(new URL(descopeJwksUrl(projectId)), {
      timeoutDuration: JWKS_TIMEOUT_MS,
    }),
    ...(audience.length > 0 ? { audience } : {}),
  });
}
