/**
 * RT-327 (0068): every POS heartbeat upserts its device's health row (last
 * write wins) and the console reads it; the heartbeat and the console read the
 * version policy and the platform change creates and replaces it. No DELETE
 * policy on either; never DELETE or TRUNCATE. The auth lookup role has
 * BYPASSRLS, so any grant would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["pos-device-health-domain-grants.sql"],
  domainRequired: [
    ["device_health", "SELECT"],
    ["device_health", "INSERT"],
    ["device_health", "UPDATE"],
    ["pos_version_policy", "SELECT"],
    ["pos_version_policy", "INSERT"],
    ["pos_version_policy", "UPDATE"],
  ],
  lookupForbidden: [
    ["device_health", ALL_TABLE_PRIVILEGES],
    ["pos_version_policy", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
