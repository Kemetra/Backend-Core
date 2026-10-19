/**
 * A tenant entitlement revision's validated content and its `content_hash`
 * (AD-AI-ENT-001 D-2, AD-POL-001 P-E) — RT-664.
 *
 * The hash is SHA-256 over the canonical JSON of the revision's content: keys
 * sorted at every level, absent optionals omitted, instants as
 * `Date#toISOString()` (millisecond UTC; the stored value is that same
 * string). It covers the plan, state, effective dates, overrides, source and
 * reason, not the tenant or the version, so two revisions with the same
 * content have the same hash.
 */
import { createHash } from "node:crypto";

import type { OverrideJson } from "./entitlement.repository";

export interface OverrideInput {
  readonly featureId: string;
  readonly action: "enable" | "disable";
  readonly meter?: string;
  readonly meterLimitDelta?: number;
  readonly expiresAt?: string;
  readonly reason: string;
}

export interface RevisionContent {
  readonly state: string;
  readonly planCode: string | null;
  readonly catalogVersion: number | null;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly overrides: readonly OverrideJson[];
  readonly reason: string;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** An instant normalised to its canonical (and stored) form. */
export function canonicalInstant(value: string | Date): string {
  return new Date(value).toISOString();
}

export function toOverrideJson(o: OverrideInput): OverrideJson {
  return {
    feature_id: o.featureId,
    action: o.action,
    reason: o.reason,
    ...(o.meter === undefined ? {} : { meter: o.meter }),
    ...(o.meterLimitDelta === undefined ? {} : { meter_limit_delta: o.meterLimitDelta }),
    ...(o.expiresAt === undefined ? {} : { expires_at: canonicalInstant(o.expiresAt) }),
  };
}

export function revisionContentHash(content: RevisionContent): Buffer {
  const json: Json = {
    catalog_version: content.catalogVersion,
    effective_from: content.effectiveFrom,
    effective_until: content.effectiveUntil,
    overrides: content.overrides.map((o) => ({ ...o }) as { [key: string]: Json }),
    plan_code: content.planCode,
    reason: content.reason,
    source: "manual_platform",
    state: content.state,
  };
  return createHash("sha256").update(canonicalJson(json)).digest();
}
