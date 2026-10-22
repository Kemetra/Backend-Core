/**
 * RT-742 (0070): forceCloseShift records a manager's not-counted force close,
 * and closeShift / the cash-up open re-delivery read whether a shift was
 * force-closed. Append-only (no UPDATE / DELETE policy); never UPDATE, DELETE
 * or TRUNCATE.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["shift-forced-closes-domain-grants.sql"],
  domainRequired: [
    ["shift_forced_closes", "SELECT"],
    ["shift_forced_closes", "INSERT"],
  ],
  lookupForbidden: [["shift_forced_closes", ALL_TABLE_PRIVILEGES]],
  lookupAllowed: [],
};
