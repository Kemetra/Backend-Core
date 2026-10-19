/**
 * RT-648 — evidence-ref resolution against a frozen pack (gate S5).
 *
 * Independent of the gateway's membership check: it parses the
 * `ev:<op>/<id>#<json-pointer>` grammar and resolves the pointer inside the
 * pack's own bodies, so a ref that the gateway would accept but that points at
 * nothing is still caught.
 */
import type { E1Op, E1Pack, E1Read, Json } from "./e1.types";

const REF = /^ev:([A-Za-z]+)(?:\/([^#]+))?#(\/.+)$/;

interface ParsedRef {
  readonly source: string;
  readonly id: string | undefined;
  readonly pointer: string;
}

type Record_ = { readonly [key: string]: Json };

const asRecord = (value: Json | null | undefined): Record_ =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record_) : {};

function parseRef(ref: string): ParsedRef | null {
  const match = REF.exec(ref);
  return match === null ? null : { source: match[1] ?? "", id: match[2], pointer: match[3] ?? "" };
}

const unescapePointer = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~");

const isContainer = (value: Json | undefined): value is Record_ | readonly Json[] =>
  typeof value === "object" && value !== null;

function pointerFound(root: Json | undefined, pointer: string): boolean {
  let cursor = root;
  for (const token of pointer.split("/").slice(1).map(unescapePointer)) {
    if (!isContainer(cursor) || !Object.hasOwn(cursor, token)) return false;
    cursor = (cursor as Record_)[token];
  }
  return true;
}

const readable = (pack: E1Pack, op: E1Op): E1Read[] =>
  pack.reads.filter((read) => read.op === op && read.http_status === 200 && read.body !== null);

function backlogResolves(pack: E1Pack, id: string | undefined, pointer: string): boolean {
  const rows = readable(pack, "consoleListPostingBacklog").flatMap((read) => {
    const items = asRecord(read.body)["items"];
    return Array.isArray(items) ? (items as readonly Json[]) : [];
  });
  const row = rows.find((candidate) => asRecord(candidate)["postingStatusId"] === id);
  return row !== undefined && pointerFound(row, pointer);
}

function readSaleRef(read: E1Read): Json | undefined {
  const body = asRecord(read.body);
  return read.op === "consoleGetSale" ? asRecord(body["summary"])["saleRef"] : body["saleRef"];
}

function saleReadResolves(pack: E1Pack, op: E1Op, id: string | undefined, pointer: string): boolean {
  return readable(pack, op).some((read) => readSaleRef(read) === id && pointerFound(read.body ?? undefined, pointer));
}

export function refResolves(pack: E1Pack, ref: string): boolean {
  const parsed = parseRef(ref);
  if (parsed === null) return false;
  if (parsed.source === "pack") return pointerFound(pack as unknown as Json, parsed.pointer);
  if (parsed.source === "consoleListPostingBacklog") return backlogResolves(pack, parsed.id, parsed.pointer);
  return saleReadResolves(pack, parsed.source as E1Op, parsed.id, parsed.pointer);
}
