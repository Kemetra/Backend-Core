/**
 * identity-provider-kind.ts — RT-791 `IDENTITY_PROVIDER` selection.
 *
 * The one place that reads which provider verifies operator tokens. The two
 * existing factories (`clerkVerifierFactory`, `clerkIdentityProviderFactory`)
 * call it, so every module that builds a verifier or an identity adapter
 * switches together.
 *
 *   - unset / empty → `clerk` (the unchanged default);
 *   - `clerk` | `descope` (surrounding whitespace ignored, otherwise exact);
 *   - anything else throws at boot, in every environment (fail closed — a typo
 *     must never silently fall back to a provider the operator did not pick).
 */
export type IdentityProviderKind = "clerk" | "descope";

const KINDS: readonly IdentityProviderKind[] = ["clerk", "descope"];

export function identityProviderKind(): IdentityProviderKind {
  const raw = (process.env["IDENTITY_PROVIDER"] ?? "").trim();
  if (raw === "") return "clerk";
  const kind = KINDS.find((k) => k === raw);
  if (!kind) {
    throw new Error("IDENTITY_PROVIDER must be 'clerk' or 'descope' (fail closed)");
  }
  return kind;
}
