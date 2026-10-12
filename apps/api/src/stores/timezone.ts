/**
 * Store time zone validation — spec 038 / RT-401 (decisions 212–215).
 *
 * PostgreSQL is the authority for a store's zone: every business date
 * (sales, returns, shifts) is computed with `AT TIME ZONE` in SQL. So a
 * zone is accepted in two stages:
 *
 *   1. Shape, here, with no database: `UTC` or a case-sensitive
 *      `Area/Location[/Sub]` name under one of the canonical IANA areas.
 *      This rejects abbreviations (`EET`) and POSIX strings (`UTC+2`,
 *      `+02:00`), which PostgreSQL would accept but reads with an inverted
 *      sign; `Etc/GMT±N` (`Etc/GMT-2` means UTC+2, an easy mistake); and the
 *      legacy alias trees (`US/Eastern`, `Canada/*`, `posix/*`, …), which
 *      distributions may ship separately (Debian's `tzdata-legacy`) and so
 *      could vanish from a server holding a store's zone.
 *   2. Existence, in the service's transaction, against
 *      `pg_timezone_names` (StoresRepository.describeZone). A miss is
 *      `400 invalid_timezone`.
 */
import { z } from "zod";

/** The canonical IANA areas; every other top-level tree is legacy or `Etc`. */
const CANONICAL_AREA_LOCATION =
  /^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)(\/[A-Za-z0-9_+-]+){1,2}$/;

/** The `IanaTimezone` contract shape (stage 1). */
export function isIanaTimezoneShape(value: string): boolean {
  return value === "UTC" || CANONICAL_AREA_LOCATION.test(value);
}

export const IanaTimezoneSchema = z
  .string()
  .min(3)
  .max(64)
  .refine(isIanaTimezoneShape, {
    message: "Must be `UTC` or a canonical IANA Area/Location time zone name.",
  });

/** Contract `error.code` for a well-formed name PostgreSQL does not know. */
export const INVALID_TIMEZONE = "invalid_timezone";
/** Contract `error.code` for a stale `expected_current_timezone`. */
export const TIMEZONE_CHANGED_CONCURRENTLY = "timezone_changed_concurrently";
/** Contract `error.code` (and preview blocker) for an open shift at the store. */
export const STORE_HAS_OPEN_SHIFT = "store_has_open_shift";

/** Audit action for a committed zone change. */
export const STORE_TIMEZONE_CHANGED_ACTION = "store.timezone.changed";

/** Always-returned preview caveats: what the server cannot see (plan §3). */
export const TIMEZONE_PREVIEW_CAVEATS = [
  "offline_shifts_not_visible",
  "uncaptured_sales_use_new_zone",
] as const;
