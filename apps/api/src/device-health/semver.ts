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

/** One dot-separated part of a version: its text, and whether it is all digits. */
interface Part {
  readonly text: string;
  readonly digits: boolean;
}

export interface ParsedVersion {
  /** `[major, minor, patch]`, each digits with no leading zero. */
  readonly core: readonly Part[];
  /** Pre-release identifiers; empty for a release. */
  readonly prerelease: readonly Part[];
}

const NUMERIC = /^\d+$/;

const toPart = (text: string): Part => ({ text, digits: NUMERIC.test(text) });

/** SemVer forbids a leading zero in a numeric pre-release identifier. */
const hasLeadingZero = (part: Part): boolean => part.digits && part.text.length > 1 && part.text.startsWith("0");

/**
 * The parsed version, or null when `value` is not a valid semantic version
 * within the `AppVersion` bounds. The wire pattern (the contract's) is looser
 * than SemVer about a leading zero in a numeric pre-release identifier, so such
 * a value is accepted on the wire and is simply not a valid version here:
 * compliance `unknown`, never ordered.
 */
export function parseAppVersion(value: string): ParsedVersion | null {
  const match = value.length < APP_VERSION_MIN_LENGTH || value.length > APP_VERSION_MAX_LENGTH ? null : APP_VERSION_PATTERN.exec(value);
  if (match === null) return null;
  const [, major, minor, patch, pre] = match;
  const prerelease = (pre === undefined ? [] : pre.slice(1).split(".")).map(toPart);
  return prerelease.some(hasLeadingZero) ? null : { core: [major, minor, patch].map((text) => toPart(text as string)), prerelease };
}

/** Digit strings compare as numbers of any width: by length once leading zeros are gone, then by text. */
function compareDigits(a: string, b: string): number {
  const left = a.replace(/^0+(?=.)/, "");
  const right = b.replace(/^0+(?=.)/, "");
  return Math.sign(left.length - right.length) || Number(left > right) - Number(left < right);
}

/** Numeric parts rank below alphanumeric ones; two of a kind compare by value or by plain code-unit order. */
function comparePart(a: Part, b: Part): number {
  if (a.digits !== b.digits) return a.digits ? -1 : 1;
  return a.digits ? compareDigits(a.text, b.text) : Number(a.text > b.text) - Number(a.text < b.text);
}

/** The first non-equal pair of the shared length, left to right; 0 when none differs. */
function firstDifference(a: readonly Part[], b: readonly Part[]): number {
  return a.slice(0, b.length).map((part, i) => comparePart(part, b[i] as Part)).find((order) => order !== 0) ?? 0;
}

function comparePrerelease(a: readonly Part[], b: readonly Part[]): number {
  // A release (no identifiers) ranks above any pre-release of it.
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length);
  // Otherwise identifiers left to right, then a shorter list ranks below a longer one that starts the same way.
  return firstDifference(a, b) || Math.sign(a.length - b.length);
}

/** -1, 0 or 1: the semver precedence of `a` against `b`. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  const order = firstDifference(a.core, b.core) || comparePrerelease(a.prerelease, b.prerelease);
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
