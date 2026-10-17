/**
 * Release version for telemetry (RT-631, OBS-1 §1).
 *
 * `version` on spans and the Sentry `release` must be the same value: the
 * release SHA12 (12 lowercase hex chars of the release commit). Both read it
 * here, from `SENTRY_RELEASE`, which the deploy already maps into the api and
 * worker containers. A full 40-char commit SHA is shortened to 12; anything
 * else is ignored rather than sent, so a mistyped value cannot break the
 * cross-service join on `version`.
 */
const SHA_PATTERN = /^[0-9a-f]{12}(?:[0-9a-f]{28})?$/;
const SHA12_LENGTH = 12;

/** The release SHA12, or `undefined` when unset or not a commit SHA. */
export function resolveReleaseVersion(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env["SENTRY_RELEASE"]?.trim();
  if (!raw || !SHA_PATTERN.test(raw)) return undefined;
  return raw.slice(0, SHA12_LENGTH);
}
