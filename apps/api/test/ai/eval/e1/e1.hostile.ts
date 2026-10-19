/**
 * RT-648 — the raw strings of a pack that gate S6 must never see displayed:
 * the question, every fenced `untrusted_text` entry, and any document ref,
 * reason code or rejection class that fails its interpolation guard.
 */
import { isDisplayable } from "./e1.text";
import type { ParamName } from "./e1.out-schema";
import type { E1Op, E1Pack, Json } from "./e1.types";

const MIN_LENGTH = 3;

function bodyOf(pack: E1Pack, op: E1Op): Json | null | undefined {
  return pack.reads.find((read) => read.op === op)?.body;
}

function dig(value: Json | null | undefined, path: readonly string[]): Json | undefined {
  return path.reduce<Json | null | undefined>((cursor, key) => {
    const isRecord = typeof cursor === "object" && cursor !== null && !Array.isArray(cursor);
    return isRecord ? (cursor as { [k: string]: Json })[key] : undefined;
  }, value) ?? undefined;
}

type Candidate = readonly [Json | undefined, ParamName];

function backlogCandidates(pack: E1Pack): Candidate[] {
  const pages = pack.reads.filter((read) => read.op === "consoleListPostingBacklog");
  const rows = pages.flatMap((read) => {
    const items = dig(read.body, ["items"]);
    return Array.isArray(items) ? items : [];
  });
  return rows.map((row): Candidate => [dig(row, ["rejectionClass"]), "rejectionClass"]);
}

function candidatesOf(pack: E1Pack): Candidate[] {
  const sale = bodyOf(pack, "consoleGetSale");
  const status = bodyOf(pack, "consoleGetSaleSyncStatus");
  return [
    [dig(sale, ["erpPosting", "saleDocumentRef"]), "saleDocumentRef"],
    [dig(sale, ["erpPosting", "reversalDocumentRef"]), "reversalDocumentRef"],
    [dig(status, ["deadLetter", "reasonCode"]), "reasonCode"],
    ...backlogCandidates(pack),
  ];
}

const failsGuard = ([value, name]: Candidate): boolean => typeof value === "string" && !isDisplayable(name, value);

export function guardedStringsOf(pack: E1Pack): readonly string[] {
  const free = [pack.question.text, ...pack.untrusted_text.map((entry) => entry.text)];
  const rejected = candidatesOf(pack).filter(failsGuard).map(([value]) => (typeof value === "string" ? value : ""));
  return [...free, ...rejected].filter((entry) => entry.length >= MIN_LENGTH);
}

/** Unicode bidi controls, built from code points so no control character sits in the source. */
const BIDI_CODE_POINTS: readonly number[] = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
];

/** Right-to-left override: the character a hostile Arabic fixture embeds. */
export const RLO = String.fromCodePoint(0x202e);

export function hasBidiControl(value: string): boolean {
  return BIDI_CODE_POINTS.some((codePoint) => value.includes(String.fromCodePoint(codePoint)));
}
