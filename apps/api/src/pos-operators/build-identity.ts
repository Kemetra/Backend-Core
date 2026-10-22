/**
 * The POS build identity a terminal reports (RT-719, RT-709 decision O-8;
 * `pos-terminal-pairing.openapi.yaml`, "Build identity report").
 *
 * Three OPTIONAL request headers on the device-token requests of the thirteen
 * reporting operations (`@ReportsBuildIdentity()`):
 *
 *   X-POS-Build-Commit   the POS git commit, 40 lower-case hex: the identity anchor
 *   X-POS-App-Version    the POS semantic version, at most 32 characters, no
 *                        build metadata (the same value as AD-DEVICE-001 `app_version`)
 *   X-POS-Contract-Pin   the Backend-Core commit in the build's PIN, 40 lower-case hex
 *
 * Rules, all pinned by `test/device-builds/build-identity.unit.spec.ts`:
 *   - a value that is longer, uses another character, does not match its form
 *     or is repeated is MISSING: never truncated, normalised or repaired, and
 *     never an error (a request is never refused or changed for a header);
 *   - without a valid commit the identity is unknown (`null`) and the version
 *     and the pin are ignored; with one, a missing or invalid version or pin is null;
 *   - nothing is defaulted or guessed, and a raw value is never logged or used
 *     as a metric label (callers see only the outcome).
 */
import type { IncomingHttpHeaders } from "node:http";

import { APP_VERSION_MAX_LENGTH, APP_VERSION_MIN_LENGTH, APP_VERSION_PATTERN } from "../device-health/semver";

/** A recorded identity: a valid commit, and the version and pin when valid. */
export interface BuildIdentity {
  readonly commit: string;
  readonly appVersion: string | null;
  readonly contractPin: string | null;
}

/** What one reporting request says: its identity, or `null` for unknown. */
export type BuildIdentityReport = BuildIdentity | null;

const GIT_COMMIT = /^[0-9a-f]{40}$/;

/** The header's single string value, or undefined when it is absent or repeated (an array). */
function single(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function validCommit(value: string | undefined): string | null {
  return value !== undefined && GIT_COMMIT.test(value) ? value : null;
}

const withinVersionBounds = (length: number): boolean => length >= APP_VERSION_MIN_LENGTH && length <= APP_VERSION_MAX_LENGTH;

/** The semantic-version form within its bounds (the contract's `AppVersion`). */
function isWireVersion(value: string): boolean {
  return APP_VERSION_PATTERN.test(value) && withinVersionBounds(value.length);
}

function validVersion(value: string | undefined): string | null {
  return value !== undefined && isWireVersion(value) ? value : null;
}

/** The identity the request headers carry, or `null` (unknown) without a valid commit. */
export function parseBuildIdentityHeaders(headers: IncomingHttpHeaders): BuildIdentityReport {
  const commit = validCommit(single(headers, "x-pos-build-commit"));
  if (commit === null) return null;
  return {
    commit,
    appVersion: validVersion(single(headers, "x-pos-app-version")),
    contractPin: validCommit(single(headers, "x-pos-contract-pin")),
  };
}
