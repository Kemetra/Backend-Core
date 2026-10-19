/**
 * RT-648 — fixed templates, interpolation guards and the question matchers of
 * `E1-BL v1` (RT-647 §5).
 *
 * What the operator would read is assembled ONLY from these templates. A value
 * that fails its guard is shown as "not displayable" and never echoed (S6);
 * `lineName` and the question text are never interpolated at all. Instants are
 * rendered in the store timezone, and `businessDate` is quoted verbatim.
 */
import type { E1Claim, E1Out, ParamName } from "./e1.out-schema";
import type { E1Pack, Json } from "./e1.types";

export const NOT_DISPLAYABLE = "not displayable";

/** The rejection vocabulary: the union of both contracts (RT-647 F-6). */
export const REJECTION_VOCABULARY: ReadonlySet<string> = new Set([
  "validation", "closed_period", "unmapped_item", "unmapped_account", "unmapped_store",
  "retry_budget_exhausted", "reconciliation_required", "other",
]);

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DOC_REF = /^[A-Za-z0-9._/-]{1,140}$/;
const SALE_NUMBER = /^[A-Za-z0-9._/-]{1,64}$/;

const GUARDS: Readonly<Record<ParamName, (value: string | number) => boolean>> = {
  saleNumber: (v) => typeof v === "string" && SALE_NUMBER.test(v),
  businessDate: (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v),
  occurredAt: isInstant,
  receivedAt: isInstant,
  processedAt: isInstant,
  resolvedAt: isInstant,
  quarantinedAt: isInstant,
  deadLetteredAt: isInstant,
  currencyCode: (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v),
  posTotal: (v) => typeof v === "string" && /^-?\d{1,15}(\.\d{1,4})?$/.test(v),
  reasonCode: (v) => typeof v === "string" && /^[a-z0-9_]{1,64}$/.test(v),
  retryCount: isCount,
  n: isCount,
  saleDocumentRef: (v) => typeof v === "string" && DOC_REF.test(v),
  reversalDocumentRef: (v) => typeof v === "string" && DOC_REF.test(v),
  rejectionClass: (v) => typeof v === "string" && REJECTION_VOCABULARY.has(v),
};

/** True when a param value passes its interpolation guard (RT-647 §5.2). */
export function isDisplayable(name: ParamName, value: string | number): boolean {
  return GUARDS[name](value);
}

function isInstant(value: string | number): boolean {
  return typeof value === "string" && INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

function isCount(value: string | number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const INSTANT_PARAMS: ReadonlySet<string> = new Set([
  "occurredAt", "receivedAt", "processedAt", "resolvedAt", "quarantinedAt", "deadLetteredAt",
]);

const NO_ACTION_NOTE =
  "I can't perform actions. Here is the sale's current state; an authorised operator can follow the referenced procedure.";
const UNKNOWN_NOT_UNPOSTED =
  "This does not mean it was not posted: for example, ERP may not be configured for this tenant, or the posting intent was never created.";
const PENDING_UNDISTINGUISHABLE =
  "it is pending or being retried after a transient failure. These two can't be told apart here, and how long it has waited is not available.";

export const TEMPLATES = {
  H0: "Sale {saleNumber}: business date {businessDate}; recorded at {occurredAt}; total {currencyCode} {posTotal}.",
  G1: NO_ACTION_NOTE,
  G2: "This sale can't be shown in your current scope.",
  G4: "Some evidence for this sale could not be read just now; no conclusion is given.",
  G5: "That can't be answered yet: posting backlog age, last successful posting and connector health are not available.",
  X1: "The evidence for this sale is inconsistent; please refresh.",
  X2: "The sale changed while it was being read; please refresh.",
  A1: "Backend-Core processed this sale at {processedAt}. This is Backend-Core processing, not ERP posting.",
  A1R: "It was repaired earlier (resolved {resolvedAt}).",
  A2: "Received by Backend-Core at {receivedAt}; not yet processed.",
  A3: "Processing failed with {reasonCode}; it is classified retryable (attempts: {retryCount}, since {quarantinedAt}).",
  A4: "Processing failed with {reasonCode} and needs operator repair (since {quarantinedAt}).",
  B1: "Posted to ERPNext as {saleDocumentRef}. The posting time is not available.",
  B2: `ERP posting is not yet confirmed: ${PENDING_UNDISTINGUISHABLE}`,
  B3: "ERPNext permanently rejected this sale's posting (category {rejectionClass}, dead-lettered {deadLetteredAt}).",
  B4: "ERPNext permanently rejected this sale's posting; the category is not recorded or not recognised.",
  B5: "ERPNext permanently rejected this sale's posting; the category could not be determined within the read limit.",
  B7: `No ERP posting record is visible for this sale. ${UNKNOWN_NOT_UNPOSTED}`,
  C1: "The void was posted to ERPNext as {reversalDocumentRef}.",
  C2: `The void's ERP reversal is not yet confirmed: ${PENDING_UNDISTINGUISHABLE}`,
  C3: "ERPNext permanently rejected the void reversal; its category is not available from these reads.",
  C4: `No ERP posting record is visible for this void reversal. ${UNKNOWN_NOT_UNPOSTED}`,
  C5: "This sale has {n} return(s); their ERP reversal state is not available from these reads.",
} as const;

export const KNOWN_GAPS_LINE = "Not available: backlog age, last successful posting, connector health.";

/** `YYYY-MM-DD HH:mm:ss (zone)` for an instant, in the store's timezone. */
export function formatInstant(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} (${timeZone})`;
}

function storeTimezoneOf(pack: E1Pack): string {
  const body = pack.reads.find((read) => read.op === "consoleGetSale")?.body;
  const zone = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { [k: string]: Json })["storeTimezone"] : null;
  return typeof zone === "string" ? zone : "UTC";
}

function renderParam(name: ParamName, value: string | number | null | undefined, timeZone: string): string {
  if (value === null || value === undefined) return name === "saleNumber" ? "n/a" : NOT_DISPLAYABLE;
  if (!GUARDS[name](value)) return NOT_DISPLAYABLE;
  const shown = `${value}`;
  return INSTANT_PARAMS.has(name) ? formatInstant(shown, timeZone) : shown;
}

function renderClaim(claim: E1Claim, timeZone: string): string {
  return TEMPLATES[claim.template_id].replace(/\{(\w+)\}/g, (_match, key: string) => {
    const name = key as ParamName;
    return renderParam(name, claim.params[name], timeZone);
  });
}

/** What the operator reads: claims through the fixed templates, then the known-gaps line. */
export function renderText(out: E1Out, pack: E1Pack): string {
  const timeZone = storeTimezoneOf(pack);
  const lines = out.claims.map((claim) => renderClaim(claim, timeZone));
  if (out.known_gaps.length > 0) lines.push(KNOWN_GAPS_LINE);
  return lines.join("\n");
}
