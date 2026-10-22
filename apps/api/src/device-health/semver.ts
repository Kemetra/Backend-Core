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
  String.raw`^(${CORE_NUMBER})\.(${CORE_NUMBER})\.(${CORE_NUMBER})(-${PRERELEASE_IDENTIFIER}(?:\.${PRERELEASE_IDENTIFIER})*)?$`,
);

export interface ParsedVersion {
  /** `[major, minor, patch]` as digit strings with no leading zero. */
  readonly core: readonly [string, string, string];
  /** Pre-release identifiers; empty for a release. */
  readonly prerelease: readonly string[];
}

const NUMERIC = /^\d+$/;

function hasLeadingZeroNumber(identifier: string): boolean {
  return identifier.length > 1 && identifier.startsWith("0") && NUMERIC.test(identifier);
}

/** The parsed version, or null when `value` is not a valid semantic version within the `AppVersion` bounds. */
export function parseAppVersion(value: string): ParsedVersion | null {
  const match = value.length < APP_VERSION_MIN_LENGTH || value.length > APP_VERSION_MAX_LENGTH ? null : APP_VERSION_PATTERN.exec(value);
  if (match === null) return null;
  const [, major, minor, patch, pre] = match;
  const prerelease = pre === undefined ? [] : pre.slice(1).split(".");
  // SemVer forbids a leading zero in a numeric pre-release identifier. The wire
  // pattern (the contract's) is looser, so such a value is accepted on the wire
  // and is simply not a valid version here: compliance `unknown`, never ordered.
  return prerelease.some(hasLeadingZeroNumber) ? null : { core: [major as string, minor as string, patch as string], prerelease };
}

/** -1, 0 or 1 for `a < b`, `a == b`, `a > b` (plain code-unit order, no locale). */
function compareText(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

/** Digit strings compare as numbers of any width: by length once leading zeros are gone, then by text. */
function compareDigits(a: string, b: string): number {
  const left = a.replace(/^0+(?=.)/, "");
  const right = b.replace(/^0+(?=.)/, "");
  return Math.sign(left.length - right.length) || compareText(left, right);
}

/** Numeric identifiers rank below alphanumeric ones; two of a kind compare by value or text. */
function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return aNumeric ? compareDigits(a, b) : compareText(a, b);
}

/** The first non-equal pair of the shared length, left to right; 0 when none differs. */
function firstDifference(a: readonly string[], b: readonly string[], compare: (x: string, y: string) => number): number {
  return a.slice(0, b.length).map((part, i) => compare(part, b[i] as string)).find((order) => order !== 0) ?? 0;
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // A release (no identifiers) ranks above any pre-release of it.
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length);
  // Otherwise identifiers left to right, then a shorter list ranks below a longer one that starts the same way.
  return firstDifference(a, b, compareIdentifiers) || Math.sign(a.length - b.length);
}

/** -1, 0 or 1: the semver precedence of `a` against `b`. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  const order = firstDifference(a.core, b.core, compareDigits) || comparePrerelease(a.prerelease, b.prerelease);
  return Math.sign(order) as -1 | 0 | 1;
}

/** `min <= recommended <= latest` in semantic-version precedence. */
export function isPolicyOrderValid(versions: {
  readonly min: ParsedVersion;
  readonly recommended: ParsedVersion;
  readonly latest: ParsedVersion;
}): boolean {
  return compareVersions(versions.min, versions.recommended) <= 0 && compareVersions(versions.recommended, versions.latest) <= 0;
}
