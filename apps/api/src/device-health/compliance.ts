/**
 * The compliance verdict of a terminal against the version policy (RT-327,
 * AD-DEVICE-001 D-2). Computed by the server at reply time (heartbeat) and at
 * read time (console), never stored.
 *
 *   - `unknown` when the version, the channel or the policy minimum is
 *     missing, or either version is not a valid semantic version: never `ok`
 *     on missing data;
 *   - `below_minimum` when the version is lower than the minimum in
 *     semantic-version precedence (a pre-release is lower than its release);
 *   - `ok` otherwise.
 *
 * The verdict only informs. Being behind `latest` or `recommended` never
 * matters, and nothing here blocks anything on the server (D-6 is the POS's).
 */
import { compareVersions, parseAppVersion } from "./semver";

export const COMPLIANCE_VALUES = ["ok", "below_minimum", "unknown"] as const;
export type Compliance = (typeof COMPLIANCE_VALUES)[number];

export interface ComplianceInput {
  readonly appVersion: string | null;
  readonly updateChannel: string | null;
  readonly minSupportedVersion: string | null;
}

export function deriveCompliance(input: ComplianceInput): Compliance {
  const { appVersion, updateChannel, minSupportedVersion } = input;
  if ([appVersion, updateChannel, minSupportedVersion].includes(null)) return "unknown";
  const version = parseAppVersion(appVersion as string);
  const minimum = parseAppVersion(minSupportedVersion as string);
  if (version === null || minimum === null) return "unknown";
  return compareVersions(version, minimum) < 0 ? "below_minimum" : "ok";
}
