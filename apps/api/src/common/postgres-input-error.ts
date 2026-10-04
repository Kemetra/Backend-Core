/**
 * A node-postgres DatabaseError carries both SQLSTATE `code` and `severity`.
 * Drizzle may wrap it in `cause`, so inspect a short, bounded cause chain.
 * Only the input/constraint codes named here are safe to classify as 400.
 *
 * Shared by GlobalExceptionFilter (response status) and LoggingInterceptor
 * (logged status and metrics) so the two cannot disagree (RT-60).
 */
const POSTGRES_INPUT_ERROR_CODES: ReadonlySet<unknown> = new Set([
  "22003", // numeric_value_out_of_range
  "22007", // invalid_datetime_format (RT-180)
  "22008", // datetime_field_overflow (RT-180)
  "22P02", // invalid_text_representation
  "23514", // check_violation
]);

export function isPostgresInputError(exception: unknown): boolean {
  let current = exception;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current === null || typeof current !== "object") return false;
    const error = current as { code?: unknown; severity?: unknown; cause?: unknown };
    const isPgError = typeof error.severity === "string";
    if (isPgError && POSTGRES_INPUT_ERROR_CODES.has(error.code)) return true;
    current = error.cause;
  }
  return false;
}
