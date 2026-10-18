/**
 * The shared console rate-limit exemption list (RT-619, RT-574 D1 / M3-M5).
 *
 * ONE list, read by:
 *   - the runtime guard, which matches `handler` (`<Controller>.<method>`);
 *   - the runtime ratchet spec, which checks `operationId` ↔ `handler`;
 *   - the RT-620 contract sweep, which must NOT require a 429 on these
 *     `operationId`s.
 *
 * Why each is exempt:
 *   - `signOut`: a user must always be able to leave.
 *   - `requestEmailVerification`: keeps its own silent per-user bucket
 *     (always 202).
 *   - `refreshSession`: Admin-Console treats a non-ok refresh as session
 *     loss, so a 429 here could sign the user out.
 *
 * Matching on the handler name keeps this list out of `auth.controller.ts`.
 * Adding an entry is a security-review decision.
 */
export interface ConsoleRateLimitExemption {
  /** The OpenAPI operationId (contract side). */
  readonly operationId: string;
  /** `<ControllerClass>.<handlerMethod>` (runtime side). */
  readonly handler: string;
}

export const CONSOLE_RATE_LIMIT_EXEMPTIONS: readonly ConsoleRateLimitExemption[] = [
  { operationId: "signOut", handler: "AuthController.signOut" },
  { operationId: "requestEmailVerification", handler: "AuthController.requestEmailVerification" },
  { operationId: "refreshSession", handler: "AuthController.refresh" },
];

export const CONSOLE_RATE_LIMIT_EXEMPT_OPERATION_IDS: readonly string[] = CONSOLE_RATE_LIMIT_EXEMPTIONS.map(
  (e) => e.operationId,
);

const EXEMPT_HANDLERS: ReadonlySet<string> = new Set(CONSOLE_RATE_LIMIT_EXEMPTIONS.map((e) => e.handler));

export function isConsoleRateLimitExempt(handlerKey: string): boolean {
  return EXEMPT_HANDLERS.has(handlerKey);
}
