/**
 * Canonical decimal-string compare (§III — no float). Two quantity strings are
 * equal iff they denote the same exact value (e.g. "10" == "10.000000" ==
 * "10.0"). Normalizes sign, leading zeros, and trailing fractional zeros without
 * ever constructing a JS number (which would lose precision past 2^53 / introduce
 * binary-float drift). Both inputs are already validated exact-decimal strings.
 */
export function canonicalDecimal(value: string): string {
  const neg = value.startsWith("-");
  const body = neg ? value.slice(1) : value;
  const [intPartRaw = "0", fracPartRaw = ""] = body.split(".");
  const intPart = intPartRaw.replace(/^0+(?=\d)/, "");
  const fracPart = stripTrailingZeros(fracPartRaw);
  const canon = fracPart ? `${intPart}.${fracPart}` : intPart;
  // "-0" / "-0.0" → "0"
  if (canon === "0") return "0";
  return neg ? `-${canon}` : canon;
}

/** Drop trailing `0`s with a linear scan (a `/0+$/` regex backtracks quadratically, S8786). */
function stripTrailingZeros(digits: string): string {
  let end = digits.length;
  while (end > 0 && digits[end - 1] === "0") end--;
  return digits.slice(0, end);
}
