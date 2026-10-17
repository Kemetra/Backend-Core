/**
 * Pure wire projections of the shift variance policy
 * (`cash-variance-policy.openapi.yaml` 1.0.0-draft): revisions, the Console
 * reads, the device read's ETag and the revision-list cursor. No DB, no clock.
 *
 * Explicit shapes, never DB rows (§IV): no tenant id. Every key of a revision
 * is present; a value that does not apply is `null`.
 *
 * Cursor: unsigned base64url JSON bound to the operation, the tenant and (for
 * a store list) the store it was issued under; any other token is a 400. It
 * carries only the keyset position (`created_at` at microsecond precision and
 * the id), so a hand-built token can only reposition the walk inside rows the
 * caller may already read.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../idempotency/canonical-json";
import { revisionState, type ResolvedPolicy, type RevisionState } from "./policy-resolution";
import type { PolicyValue } from "./policy-value";
import type { RevisionKeyset, StoredRevision } from "./policy.repository";

export interface RevisionBody {
  readonly revisionId: string;
  readonly scope: "tenant" | "store";
  readonly storeId: string | null;
  readonly kind: "set" | "clear";
  readonly policyValue: PolicyValue | null;
  readonly reason: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly permanent: boolean;
  readonly approvedByUserId: string | null;
  readonly supersedesRevisionId: string | null;
  readonly state: RevisionState;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

export interface TenantPolicyBody {
  readonly tenantDefault: ResolvedPolicy;
  readonly latestRevision: RevisionBody | null;
  readonly latestRevisionId: string | null;
}

export interface ActiveOverrideBody {
  readonly revisionId: string;
  readonly policyValue: PolicyValue;
  readonly reason: string;
  readonly effectiveUntil: string | null;
  readonly permanent: boolean;
  readonly approvedByUserId: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

export interface StorePolicyBody {
  readonly storeId: string;
  readonly effective: ResolvedPolicy;
  readonly tenantDefault: ResolvedPolicy;
  readonly activeOverride: ActiveOverrideBody | null;
  readonly latestRevisionId: string | null;
  readonly permanentOverrideHorizonDays: number;
}

export interface DevicePolicyBody extends ResolvedPolicy {
  readonly serverTime: string;
}

export interface RevisionPage {
  readonly items: RevisionBody[];
  readonly nextCursor: string | null;
}

/** A revision as the contract shows it; `state` derives from the scope's latest id and the clock. */
export function toRevisionBody(
  revision: StoredRevision,
  scope: { readonly latestId: string | null; readonly now: Date },
): RevisionBody {
  const createdAt = revision.createdAt.toISOString();
  return {
    revisionId: revision.id,
    scope: revision.scope,
    storeId: revision.storeId,
    kind: revision.kind,
    policyValue: revision.value,
    reason: revision.reason,
    effectiveFrom: createdAt,
    effectiveUntil: revision.effectiveUntil?.toISOString() ?? null,
    permanent: revision.permanent,
    approvedByUserId: revision.approvedByUserId,
    supersedesRevisionId: revision.supersedesRevisionId,
    state: revisionState(revision, scope),
    createdByUserId: revision.createdByUserId,
    createdAt,
  };
}

/** The store's active override (a `set` with a value, checked active by the caller). */
export function toActiveOverride(revision: StoredRevision & { readonly value: PolicyValue }): ActiveOverrideBody {
  return {
    revisionId: revision.id,
    policyValue: revision.value,
    reason: revision.reason,
    effectiveUntil: revision.effectiveUntil?.toISOString() ?? null,
    permanent: revision.permanent,
    approvedByUserId: revision.approvedByUserId,
    createdByUserId: revision.createdByUserId,
    createdAt: revision.createdAt.toISOString(),
  };
}

export { PERMANENT_HORIZON_DAYS as HORIZON_DAYS } from "./policy-value";

/**
 * The strong ETag of a resolved policy: the quoted lowercase hex SHA-256 of
 * the canonical JSON (keys sorted, no whitespace) of `policySource`,
 * `policyRevisionId` and `policyValue`. `serverTime` is not part of it.
 */
export function policyEtag(policy: ResolvedPolicy): string {
  const canonical = canonicalJson({
    policySource: policy.policySource,
    policyRevisionId: policy.policyRevisionId,
    policyValue: policy.policyValue,
  });
  return `"${createHash("sha256").update(canonical).digest("hex")}"`;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** Raised for a cursor this operation did not issue → 400 validation_error. */
export class InvalidPolicyCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this operation");
    this.name = "InvalidPolicyCursorError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `created_at` as the repository renders it: UTC, six fractional digits, never year 0000. */
const KEY_RE = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const CursorSchema = z
  .object({
    k: z.literal("cash_variance_policy_revisions"),
    t: z.string().regex(UUID_RE),
    s: z.string().regex(UUID_RE).nullable(),
    c: z.string().regex(KEY_RE),
    i: z.string().regex(UUID_RE),
  })
  .strict();

/** The list a cursor belongs to: one tenant's default, or one store's override. */
export interface CursorScope {
  readonly tenantId: string;
  readonly storeId: string | null;
}

export function encodePolicyCursor(scope: CursorScope, keyset: RevisionKeyset): string {
  const payload = {
    k: "cash_variance_policy_revisions",
    t: scope.tenantId.toLowerCase(),
    s: scope.storeId?.toLowerCase() ?? null,
    c: keyset.createdAtKey,
    i: keyset.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The keyset position, if `cursor` was issued for exactly this list. */
export function decodePolicyCursor(scope: CursorScope, cursor: string): RevisionKeyset {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidPolicyCursorError();
  }
  const parsed = CursorSchema.safeParse(raw);
  const sameList =
    parsed.success &&
    parsed.data.t === scope.tenantId.toLowerCase() &&
    parsed.data.s === (scope.storeId?.toLowerCase() ?? null) &&
    isRealInstant(parsed.data.c);
  if (!sameList) throw new InvalidPolicyCursorError();
  return { createdAtKey: parsed.data.c, id: parsed.data.i };
}

/** True when `key` names a real calendar instant (no Feb 30, no hour 24), so Postgres never refuses it. */
function isRealInstant(key: string): boolean {
  const millis = `${key.slice(0, 23)}Z`;
  const parsed = new Date(millis);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === millis;
}
