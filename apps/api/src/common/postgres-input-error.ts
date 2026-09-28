/**
 * A node-postgres DatabaseError carries both SQLSTATE `code` and `severity`.
 * Drizzle may wrap it in `cause`, so inspect a short, bounded cause chain.
 * Only the input/constraint codes named here are safe to classify as 400.
 *
 * Shared by GlobalExceptionFilter (response status) and LoggingInterceptor
 * (logged status and metrics) so the two cannot disagree (RT-60).
 */
export function isPostgresInputError(exception: unknown): boolean {
  let current = exception;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current === null || typeof current !== "object") return false;
    const error = current as { code?: unknown; severity?: unknown; cause?: unknown };
    if (
      typeof error.severity === "string" &&
      (error.code === "22003" || error.code === "23514" || error.code === "22P02")
    ) {
      return true;
    }
    current = error.cause;
  }
  return false;
}
