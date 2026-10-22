/**
 * Semantic-version parsing and precedence for the POS version policy (RT-327,
 * AD-DEVICE-001 D-2).
 *
 * `APP_VERSION_PATTERN` is the contract's `AppVersion` schema (`pos-device-
 * health.openapi.yaml`, the same as the RT-719 `X-POS-App-Version` header):
 * a semantic version without build metadata, 5 to 32 characters. Precedence is
 * semver 2.0 section 11: the core compares numerically, a pre-release is lower
 * than its release, pre-release identifiers compare left to right, numeric
 * identifiers rank below alphanumeric ones and a shorter list ranks below a
 * longer one that starts the same way. Numbers compare as digit strings, so a
 * component wider than a safe integer is still exact.
 */

export const APP_VERSION_MIN_LENGTH = 5;
export const APP_VERSION_MAX_LENGTH = 32;
// Built from its parts (the contract's `AppVersion` pattern, character for character).
const CORE_NUMBER = String.raw`(?:0|[1-9]\d*)`;
const PRERELEASE_IDENTIFIER = "[0-9A-Za-z-]+";
export const APP_VERSION_PATTERN = new RegExp(
  `^(${CORE_NUMBER})\\.(${CORE_NUMBER})\\.(${CORE_NUMBER})(-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?$`,
);

export interface ParsedVersion {
  /** `[major, minor, patch]` as digit strings with no leading zero. */
  readonly core: readonly [string, string, string];
  /** Pre-release identifiers; empty for a release. */
  readonly prerelease: readonly string[];
}

function hasLeadingZeroNumber(identifier: string): boolean {
  return identifier.length > 1 && identifier.startsWith("0") && /^\d+$/.test(identifier);
}

/** The parsed version, or null when `value` is not a valid semantic version within the `AppVersion` bounds. */
export function parseAppVersion(value: string): ParsedVersion | null {
  if (value.length < APP_VERSION_MIN_LENGTH || value.length > APP_VERSION_MAX_LENGTH) return null;
  const match = APP_VERSION_PATTERN.exec(value);
  if (match === null) return null;
  const [, major, minor, patch, pre] = match;
  const prerelease = pre === undefined ? [] : pre.slice(1).split(".");
  // SemVer forbids a leading zero in a numeric pre-release identifier. The wire
  // pattern (the contract's) is looser, so such a value is accepted on the wire
  // and is simply not a valid version here: compliance `unknown`, never ordered.
  if (prerelease.some(hasLeadingZeroNumber)) return null;
  return {
    core: [major as string, minor as string, patch as string],
    prerelease,
  };
}

const NUMERIC = /^\d+$/;

function compareDigits(a: string, b: string): number {
  const left = a.replace(/^0+(?=.)/, "");
  const right = b.replace(/^0+(?=.)/, "");
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return compareDigits(a, b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The first non-equal identifier pair, left to right over the shared length; 0 when none differs. */
function firstIdentifierDifference(a: readonly string[], b: readonly string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const order = compareIdentifiers(a[i] as string, b[i] as string);
    if (order !== 0) return order;
  }
  return 0;
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // A release (no identifiers) ranks above any pre-release of it.
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length);
  const byIdentifier = firstIdentifierDifference(a, b);
  // A shorter list ranks below a longer one that starts the same way.
  return byIdentifier === 0 ? Math.sign(a.length - b.length) : byIdentifier;
}

/** -1, 0 or 1: the semver precedence of `a` against `b`. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  for (let i = 0; i < 3; i += 1) {
    const order = compareDigits(a.core[i] as string, b.core[i] as string);
    if (order !== 0) return order < 0 ? -1 : 1;
  }
  const order = comparePrerelease(a.prerelease, b.prerelease);
  if (order === 0) return 0;
  return order < 0 ? -1 : 1;
}

/** `min <= recommended <= latest` in semantic-version precedence. */
export function isPolicyOrderValid(versions: {
  readonly min: ParsedVersion;
  readonly recommended: ParsedVersion;
  readonly latest: ParsedVersion;
}): boolean {
  return compareVersions(versions.min, versions.recommended) <= 0 && compareVersions(versions.recommended, versions.latest) <= 0;
}
