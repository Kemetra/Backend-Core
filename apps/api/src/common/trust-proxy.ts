import { resolveDeploymentEnvironment } from "../connector/deployment-environment";

/**
 * RT-624 (RT-574 issue 5b) — `TRUST_PROXY` boot check.
 *
 * Unset `TRUST_PROXY` resolves to `false`. Behind Caddy that puts every client
 * in one IP bucket, so the per-IP public-auth budgets become global (a sign-in
 * denial of service). In a deployed environment an unset value is therefore
 * logged as a warning at boot. An explicit value, including `false` for a
 * direct deployment, is silent.
 *
 * Failing fast changes production boot behaviour, so it is an owner option:
 * it only happens when `TRUST_PROXY_REQUIRED` is exactly `true`. Default off.
 */
export const TRUST_PROXY_UNSET_WARNING =
  "TRUST_PROXY is unset in a deployed environment: forwarded headers are not trusted, so behind a " +
  "reverse proxy all clients share one IP rate-limit bucket. Set TRUST_PROXY to the proxy hop " +
  "count (for example 1 behind a single Caddy), or to false explicitly for a direct deployment.";

export const TRUST_PROXY_UNRECOGNIZED_WARNING =
  "TRUST_PROXY has an unrecognized value in a deployed environment and resolves to false: only a " +
  "hop count (digits), true, or false (exactly, no whitespace) is understood. Behind a reverse " +
  "proxy all clients then share one IP rate-limit bucket.";

export type TrustProxyCheck = { warn: false } | { warn: true; message: string };

/** The value for Express `trust proxy`; identical to the pre-RT-624 inline logic. */
export function resolveTrustProxySetting(
  env: NodeJS.ProcessEnv = process.env,
): number | boolean {
  const raw = env["TRUST_PROXY"] ?? "false";
  return /^\d+$/.test(raw) ? Number(raw) : raw === "true";
}

function isDeployed(env: NodeJS.ProcessEnv): boolean {
  return env["NODE_ENV"] === "production" || ["staging", "pilot", "prod"].includes(
    resolveDeploymentEnvironment(env) ?? "",
  );
}

/**
 * Decide whether boot should warn about an unset `TRUST_PROXY`. Throws only
 * when `TRUST_PROXY_REQUIRED=true` is set explicitly. Pure: the caller logs.
 */
export function checkTrustProxyConfig(
  env: NodeJS.ProcessEnv = process.env,
): TrustProxyCheck {
  if (!isDeployed(env)) return { warn: false };
  const raw = env["TRUST_PROXY"] ?? "";
  if (/^\d+$/.test(raw) || raw === "true" || raw === "false") return { warn: false };
  if (env["TRUST_PROXY_REQUIRED"] === "true") {
    throw new Error(
      "TRUST_PROXY must be set to a hop count, true, or false in a deployed environment " +
        "when TRUST_PROXY_REQUIRED=true",
    );
  }
  return {
    warn: true,
    message: raw.trim() === "" ? TRUST_PROXY_UNSET_WARNING : TRUST_PROXY_UNRECOGNIZED_WARNING,
  };
}
