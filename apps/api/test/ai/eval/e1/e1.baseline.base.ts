/**
 * RT-648 — shared helpers and types of the `E1-BL v1` baseline: the typed view
 * over a frozen pack, the `Track` and `Abstain` shapes, and claim building.
 *
 * A value that fails its interpolation guard is dropped when a claim is built,
 * so a hostile string never enters an output (RT-647 §5.2, gate S6).
 */
import type { E1Claim, ParamName } from "./e1.out-schema";
import { isDisplayable } from "./e1.text";
import type { E1Class, E1Op, E1Pack, E1Read, Json } from "./e1.types";

export type Rec = { readonly [key: string]: Json };
export type Params = E1Claim["params"];

export function rec(value: Json | null | undefined): Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : {};
}

export const str = (value: Json | undefined): string | null => (typeof value === "string" ? value : null);

/** A string field as text, or "" when it is not a string. */
export const text = (value: Json | undefined): string => str(value) ?? "";

export const arr = (value: Json | undefined): readonly Json[] => (Array.isArray(value) ? (value as readonly Json[]) : []);

export interface View {
  readonly r1: E1Read | undefined;
  readonly r2: E1Read | undefined;
  readonly r3: E1Read | undefined;
  readonly r4: readonly E1Read[];
}

export function viewOf(pack: E1Pack): View {
  const only = (op: E1Op): E1Read | undefined => pack.reads.find((read) => read.op === op);
  return {
    r1: only("consoleGetSale"),
    r2: only("consoleGetSaleSyncStatus"),
    r3: only("consoleGetSaleAuditTimeline"),
    r4: pack.reads.filter((read) => read.op === "consoleListPostingBacklog"),
  };
}

export const ref = (op: E1Op, id: string, pointer: string): string => `ev:${op}/${id}#${pointer}`;

export interface Abstain {
  readonly cls: E1Class;
  readonly rule: string;
  readonly template: "G2" | "G4" | "G5" | "X1" | "X2";
  readonly refs: readonly string[];
}

export interface Track {
  readonly state: string;
  readonly rule: string;
  readonly claims: readonly E1Claim[];
  readonly runbooks: readonly string[];
  readonly failed: boolean;
  readonly unknowns: readonly string[];
  readonly backlogClass: string;
}

export function sanitized(params: Params): Params {
  const entries = Object.entries(params).map(([name, value]): [string, string | number | null] => {
    const keep = value === null || value === undefined || isDisplayable(name as ParamName, value);
    return [name, keep ? (value ?? null) : null];
  });
  return Object.fromEntries(entries) as Params;
}

export function claim(template_id: E1Claim["template_id"], params: Params, ...refs: string[]): E1Claim {
  return { template_id, params: sanitized(params), evidence_refs: refs };
}

/** A track with nothing to report: no claims, runbooks, unknowns or failure. */
export function quietTrack(state: string, rule: string): Track {
  return { state, rule, claims: [], runbooks: [], failed: false, unknowns: [], backlogClass: "n/a" };
}
