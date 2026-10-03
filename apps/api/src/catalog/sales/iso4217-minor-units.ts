/**
 * iso4217-minor-units.ts — RT-105: the ISO-4217 minor unit (exponent) of each
 * currency, for the sale-line price invariant (`sale-line-pricing.ts`).
 *
 * Every ISO 4217 List One code with a numeric minor unit, plus a few codes
 * recently withdrawn or being phased out (ANG, BGN, CUC, HRK, SLL, ZWL) so a
 * late sale in one is still checked at its real precision. Codes whose minor unit is "N.A." —
 * precious metals (XAU, XAG, XPD, XPT), SDR and similar units (XDR, XSU, XUA,
 * XBA–XBD), the test code XTS and the no-currency code XXX — are absent on
 * purpose, as is any unassigned code: they have no precision to meet, so
 * `minorUnitExponent` answers null and the line is rejected rather than priced
 * at an assumed 2 (Jira RT-105 comment 10537, gap 2).
 *
 * Separate from the read-down map in `read-down.toBody.ts`, which keeps its
 * own documented default of 2 for the catalogue projection.
 */

const EXPONENT_0 = [
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX",
  "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
];

const EXPONENT_2 = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM",
  "BBD", "BDT", "BGN", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP",
  "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CNY", "COP", "COU", "CRC",
  "CUC", "CUP", "CVE", "CZK", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR",
  "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GTQ", "GYD", "HKD", "HNL",
  "HRK", "HTG", "HUF", "IDR", "ILS", "INR", "IRR", "JMD", "KES", "KGS", "KHR",
  "KPW", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "MAD", "MDL", "MGA",
  "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR",
  "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "PAB", "PEN", "PGK", "PHP",
  "PKR", "PLN", "QAR", "RON", "RSD", "RUB", "SAR", "SBD", "SCR", "SDG", "SEK",
  "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL",
  "THB", "TJS", "TMT", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "USD", "USN",
  "UYU", "UZS", "VED", "VES", "WST", "XCD", "XCG", "YER", "ZAR", "ZMW", "ZWG",
  "ZWL",
];

const EXPONENT_3 = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];

const EXPONENT_4 = ["CLF", "UYW"];

const MINOR_UNIT: ReadonlyMap<string, number> = new Map([
  ...EXPONENT_0.map((code) => [code, 0] as const),
  ...EXPONENT_2.map((code) => [code, 2] as const),
  ...EXPONENT_3.map((code) => [code, 3] as const),
  ...EXPONENT_4.map((code) => [code, 4] as const),
]);

/** The currency's ISO-4217 minor-unit exponent, or null when it has none. */
export function minorUnitExponent(currencyCode: string): number | null {
  return MINOR_UNIT.get(currencyCode) ?? null;
}
