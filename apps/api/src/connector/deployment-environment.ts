/**
 * RT-152 (RT-134 CS2) — deployment-environment identity of this Backend-Core.
 *
 * A connector registration carries an `environment`
 * (`connector_registration.environment`, CHECK in the same four values). The
 * connector feed (posting pull/ack, bin/stock pull/snapshot) is refused for a
 * registration whose environment differs from the environment this deployment
 * declares in `DEPLOYMENT_ENVIRONMENT`, so a dev/staging connector can never
 * drain or ack a production feed.
 *
 * `NODE_ENV` says "production build"; it is NOT the deployment identity, which
 * is why this is a separate, explicit setting.
 */
export const DEPLOYMENT_ENVIRONMENTS = ["dev", "staging", "pilot", "prod"] as const;

export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

/** The valid deployment environment in `env`, or null when unset/invalid. */
export function resolveDeploymentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentEnvironment | null {
  const raw = (env["DEPLOYMENT_ENVIRONMENT"] ?? "").trim();
  return (DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(raw)
    ? (raw as DeploymentEnvironment)
    : null;
}

/**
 * Boot guard: with `NODE_ENV=production`, refuse to start unless
 * `DEPLOYMENT_ENVIRONMENT` is one of the four valid values. Outside production
 * a missing value does not stop boot; the feed gate then fails closed (403)
 * until the variable is set.
 */
export function assertDeploymentEnvironmentConfigured(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env["NODE_ENV"] !== "production") return;
  if (resolveDeploymentEnvironment(env) === null) {
    throw new Error(
      "DEPLOYMENT_ENVIRONMENT must be one of " +
        `${DEPLOYMENT_ENVIRONMENTS.join(", ")} when NODE_ENV=production`,
    );
  }
}
