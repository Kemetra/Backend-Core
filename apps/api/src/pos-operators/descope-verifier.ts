/**
 * Descope session-JWT verifier — RT-791 (RT-790 approach A).
 *
 * Same seam as the Clerk verifier (`OperatorTokenVerifier.verify(jwt) -> { providerKey, sub }`), so
 * every caller (sign-in, shifts, audit events, the identity adapter) is
 * unchanged. Verification uses `jose` against the Descope project JWKS:
 *
 *   - signature: keys from `https://api.descope.com/<projectId>/.well-known/jwks.json`,
 *     algorithm allow-list `RS256` (no `none`, no HMAC, no EC);
 *   - `iss` pinned to `https://api.descope.com/v1/apps/<projectId>` (what real
 *     session JWTs carry — rt9 lab, 2026-10-21), also accepting the legacy forms
 *     `https://api.descope.com/<projectId>` and the bare `<projectId>`; or
 *     exactly `DESCOPE_JWT_ISSUER` when set;
 *   - `exp` required, small clock tolerance;
 *   - `aud` must be the project id (Descope stamps it), or exactly
 *     `DESCOPE_JWT_AUDIENCE` when set;
 *   - a token marked as a refresh token (`drn: "DSR"`) is refused — only the
 *     session JWT is an operator credential.
 *
 * Fail closed: any failure (signature, claims, JWKS fetch, malformed input)
 * throws ONE generic error with no cause and no claims attached — jose's claim
 * errors carry the decoded payload (incl. `sub`), which must never reach a log.
 * The raw token is never logged, persisted or returned (FR-POS-AUTH-10).
 */
import { Injectable } from "@nestjs/common";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from "jose";

import type { OperatorTokenClaims, OperatorTokenVerifier } from "../auth/operator-token-verifier";

/** The provider discriminator Descope-verified subjects carry. */
export const DESCOPE_PROVIDER_KEY = "descope";

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

/**
 * The CANONICAL issuer: what Descope stamps on session JWTs for a project. It
 * is also the issuer recorded on `descope` identity links (the adapter and the
 * cutover CLI — packages/db/src/cli/descope-cutover.ts — keep this in lockstep).
 */
export function descopeIssuer(projectId: string): string {
  return `${DESCOPE_API_BASE}/v1/apps/${assertProjectId(projectId)}`;
}

/** The project JWKS endpoint. */
export function descopeJwksUrl(projectId: string): string {
  return `${DESCOPE_API_BASE}/${assertProjectId(projectId)}/.well-known/jwks.json`;
}

const ISSUER_URL_RE = /^https:\/\/\S{1,500}$/;

/**
 * `DESCOPE_JWT_ISSUER`, validated (an https URL or a bare project id — the forms
 * Descope uses), or null when unset. A malformed value fails at boot rather than
 * silently changing which tokens are accepted. The cutover CLI applies the same rule.
 */
function issuerOverride(): string | null {
  const override = (process.env["DESCOPE_JWT_ISSUER"] ?? "").trim();
  if (override.length === 0) return null;
  if (!ISSUER_URL_RE.test(override) && !PROJECT_ID_RE.test(override)) {
    throw new Error("DESCOPE_JWT_ISSUER must be an https URL or a project id");
  }
  return override;
}

/** The configured issuer: `DESCOPE_JWT_ISSUER` when set, else derived from the project id. */
export function configuredDescopeIssuer(projectId: string): string {
  return issuerOverride() ?? descopeIssuer(projectId);
}

/**
 * The `iss` values the verifier accepts. Without an override: the canonical
 * form plus the legacy `https://api.descope.com/<projectId>` and bare
 * `<projectId>` forms (accepted on verification, never written to links). Either way the signature is checked against THIS
 * project's JWKS, so a listed form cannot admit another project's token.
 */
export function acceptedDescopeIssuers(projectId: string): string[] {
  const override = issuerOverride();
  if (override) return [override];
  return [descopeIssuer(projectId), `${DESCOPE_API_BASE}/${projectId}`, projectId];
}

/**
 * Issuer + audience the production verifier enforces (the JWKS is added by the
 * factory). `aud` is `DESCOPE_JWT_AUDIENCE` when set, else the project id.
 */
export function descopeVerifierConfig(projectId: string): Pick<DescopeVerifierOptions, "issuer" | "audience"> {
  const audienceOverride = (process.env["DESCOPE_JWT_AUDIENCE"] ?? "").trim();
  return {
    issuer: acceptedDescopeIssuers(projectId),
    audience: audienceOverride.length > 0 ? audienceOverride : projectId,
  };
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

function toVerifyOptions(options: DescopeVerifierOptions): JWTVerifyOptions {
  return {
    issuer: typeof options.issuer === "string" ? options.issuer : [...options.issuer],
    algorithms: ALLOWED_ALGORITHMS,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    requiredClaims: ["exp", "sub"],
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
  };
}

/** The operator subject of a verified session JWT; refresh tokens and empty subjects refuse. */
function sessionSubject(payload: JWTPayload): string {
  if (payload["drn"] === REFRESH_TOKEN_DRN) throw rejected();
  const sub: unknown = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) throw rejected();
  return sub;
}

@Injectable()
export class DescopeJwksVerifier implements OperatorTokenVerifier {
  private readonly verifyOptions: JWTVerifyOptions;

  constructor(private readonly options: DescopeVerifierOptions) {
    this.verifyOptions = toVerifyOptions(options);
  }

  async verify(rawJwt: string): Promise<OperatorTokenClaims> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(rawJwt, this.options.jwks, this.verifyOptions));
    } catch (err) {
      // Deliberately drop the cause and message: they can carry the decoded
      // claims. Only jose's fixed error code survives (outage vs forgery triage).
      throw rejected(err);
    }
    return { providerKey: DESCOPE_PROVIDER_KEY, sub: sessionSubject(payload) };
  }
}

/**
 * Factory used when `IDENTITY_PROVIDER=descope`. Production requires
 * `DESCOPE_PROJECT_ID`; non-production boots without it but every verification
 * fails closed. Building the remote JWKS makes no request (fetched on first use).
 */
export function descopeVerifierFactory(): OperatorTokenVerifier {
  const projectId = (process.env["DESCOPE_PROJECT_ID"] ?? "").trim();
  if (projectId === "") {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error("PosOperatorsModule: DESCOPE_PROJECT_ID is required in production");
    }
    return {
      verify(): Promise<OperatorTokenClaims> {
        return Promise.reject(
          new Error("descope verifier: DESCOPE_PROJECT_ID not configured (fail closed)"),
        );
      },
    };
  }
  return new DescopeJwksVerifier({
    ...descopeVerifierConfig(projectId),
    jwks: createRemoteJWKSet(new URL(descopeJwksUrl(projectId)), {
      timeoutDuration: JWKS_TIMEOUT_MS,
    }),
  });
}
