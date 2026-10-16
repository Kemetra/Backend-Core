/**
 * RT-366 — the contract's impact verdict → `consoleRevokeDevice` outcome table
 * ("Impact preview" in `devices.openapi.yaml`), written independently of the
 * runtime so the parity specs compare the revoke against the contract, not
 * against itself.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */

/** A revoke outcome: the HTTP status and the 200 `outcome` or the error `code`. */
export type RevokeOutcome = readonly [number, string];

/** The preview fields the mapping reads. */
export interface ImpactVerdictView {
  readonly verdict: string;
  readonly blockCode: string | null;
  readonly requires: readonly string[];
}

/** The revoke body fields the requirements are checked against. */
export interface RevokeBodyView {
  readonly reason?: string;
  readonly note?: string | undefined;
  readonly acknowledgeCustodyException?: boolean | undefined;
}

const FIXED_OUTCOMES: Readonly<Record<string, RevokeOutcome>> = {
  allowed: [200, "revoked"],
  no_change: [200, "already_revoked"],
  forbidden_recovery: [403, "recovery_revoke_forbidden"],
};

/** The body requirements in the revoke's check order, with the 422 code of each. */
const REQUIREMENT_REFUSALS: ReadonlyArray<readonly [string, (body: RevokeBodyView) => boolean, string]> = [
  ["note", (body) => body.note !== undefined, "recovery_note_required"],
  ["acknowledge_custody_exception", (body) => body.acknowledgeCustodyException === true, "custody_exception_not_acknowledged"],
];

/** The outcome the contract maps `preview` to, for a revoke with `body`. */
/** The verdicts whose `note` requirement is the recovery revoke's 422, not the body schema's 400. */
const RECOVERY_VERDICTS: ReadonlySet<string> = new Set(["allowed_with_custody_exception", "forbidden_recovery"]);

/** An `other` revoke's `note` is the body schema's rule: missing, it is 400 before any read, whatever the verdict. */
function bodySchemaRefuses(preview: ImpactVerdictView, body: RevokeBodyView): boolean {
  if (RECOVERY_VERDICTS.has(preview.verdict)) return false;
  return preview.requires.includes("note") && body.note === undefined;
}

export function contractRevokeOutcome(preview: ImpactVerdictView, body: RevokeBodyView): RevokeOutcome {
  if (bodySchemaRefuses(preview, body)) return [400, "validation_error"];
  if (preview.verdict === "blocked") return [409, String(preview.blockCode)];
  const fixed = FIXED_OUTCOMES[preview.verdict];
  if (fixed !== undefined) return fixed;
  // allowed_with_custody_exception: the first unmet requirement is the 422.
  const unmet = REQUIREMENT_REFUSALS.find(([req, met]) => preview.requires.includes(req) && !met(body));
  return unmet === undefined ? [200, "revoked"] : [422, unmet[2]];
}
