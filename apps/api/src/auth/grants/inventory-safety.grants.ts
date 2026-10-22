/**
 * RT-449 (0072): every safety command steps the tenant's revision (upsert)
 * and appends one change; recalls and expiry corrections are append-only; a
 * hold is released by UPDATE (a trigger lets only the release be set, once).
 * The expiry correction UPDATEs tracking_identities (0072's guard lets only
 * expiry_date change, and only with its correction row; its SELECT is the
 * baseline's). No DELETE policy on any of them; never DELETE or TRUNCATE.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["inventory-safety-domain-grants.sql"],
  domainRequired: [
    ["tenant_inventory_safety_revisions", "SELECT"],
    ["tenant_inventory_safety_revisions", "INSERT"],
    ["tenant_inventory_safety_revisions", "UPDATE"],
    ["inventory_safety_changes", "SELECT"],
    ["inventory_safety_changes", "INSERT"],
    ["inventory_recalls", "SELECT"],
    ["inventory_recalls", "INSERT"],
    ["tracking_holds", "SELECT"],
    ["tracking_holds", "INSERT"],
    ["tracking_holds", "UPDATE"],
    ["tracking_identity_expiry_corrections", "SELECT"],
    ["tracking_identity_expiry_corrections", "INSERT"],
    ["tracking_identities", "UPDATE"],
  ],
  lookupForbidden: [
    "tenant_inventory_safety_revisions",
    "inventory_safety_changes",
    "inventory_recalls",
    "tracking_holds",
    "tracking_identity_expiry_corrections",
  ].map((table) => [table, ALL_TABLE_PRIVILEGES] as const),
  lookupAllowed: [],
};
