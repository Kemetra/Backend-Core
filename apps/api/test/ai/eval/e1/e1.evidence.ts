/**
 * RT-648 — turn a frozen E1 pack into the `EvidencePack` the gateway may send.
 *
 * Every node of every readable body, and every pack-level field, becomes one
 * citable item `<prefix>#<json-pointer>`, so a claim can cite a leaf or a
 * container. A pack whose deterministic rules already end in an abstention
 * yields NO evidence: the baseline answers and no request is built ("no
 * request is ever sent without evidence").
 */
import type { EvidenceFieldValue, EvidencePack } from "../../../../src/ai/ports/model-provider.port";
import { explain } from "./e1.baseline";
import type { E1Pack, E1Read, Json } from "./e1.types";

interface Item {
  readonly ref: string;
  readonly fields: Readonly<Record<string, EvidenceFieldValue>>;
}

type Record_ = { readonly [key: string]: Json };

const asRecord = (value: Json | null | undefined): Record_ =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record_) : {};

const escapePointer = (key: string): string => key.replaceAll("~", "~0").replaceAll("/", "~1");

function childrenOf(value: Json): [string, Json][] {
  if (Array.isArray(value)) return (value as readonly Json[]).map((item, i): [string, Json] => [String(i), item]);
  return Object.entries(value as Record_);
}

function flatten(prefix: string, value: Json, pointer: string): Item[] {
  const ref = `${prefix}#${pointer}`;
  if (typeof value !== "object" || value === null) return [{ ref, fields: { value } }];
  const own: Item = { ref, fields: { kind: Array.isArray(value) ? "array" : "object" } };
  const children = childrenOf(value).flatMap(([key, child]) => flatten(prefix, child, `${pointer}/${escapePointer(key)}`));
  return [own, ...children];
}

function saleReadId(read: E1Read): Json | undefined {
  const body = asRecord(read.body);
  return read.op === "consoleGetSale" ? asRecord(body["summary"])["saleRef"] : body["saleRef"];
}

function backlogItems(body: Json): Item[] {
  const rows = asRecord(body)["items"];
  const list = Array.isArray(rows) ? (rows as readonly Json[]) : [];
  return list.flatMap((row) => {
    const id = asRecord(row)["postingStatusId"];
    return typeof id === "string" ? flatten(`ev:consoleListPostingBacklog/${id}`, row, "") : [];
  });
}

function readItems(read: E1Read): Item[] {
  if (read.http_status !== 200 || read.body === null) return [];
  if (read.op === "consoleListPostingBacklog") return backlogItems(read.body);
  const id = saleReadId(read);
  return typeof id === "string" ? flatten(`ev:${read.op}/${id}`, read.body, "") : [];
}

const isRoot = (item: Item): boolean => item.ref.endsWith("#");

export function toEvidencePack(pack: E1Pack): EvidencePack {
  if (explain(pack).class.startsWith("abstain")) return { items: [] };
  const packLevel = Object.fromEntries(Object.entries(pack).filter(([key]) => key !== "reads")) as Json;
  const items = [...pack.reads.flatMap(readItems), ...flatten("ev:pack", packLevel, "")];
  return { items: items.filter((item) => !isRoot(item)) };
}
