/**
 * 027 POS Terminal-Pairing CONSUME — request DTO + wire-shape projection.
 *
 * Mirrors the binding contract
 *   packages/contracts/openapi/pos-terminal-pairing.openapi.yaml
 * (consume-only; the YAML is never edited).
 *
 * The request is STRICT (§XII mass-assignment ban): `pairing_code` is the ONLY
 * accepted field. The response projection (`toTerminalPairBody`) maps a
 * `pairing_codes` row + the freshly-minted raw device_token into the exact
 * 11-field snake_case envelope. The raw `device_token` is the only place the
 * token ever leaves the server — it is NEVER stored (only its hash is, in
 * `devices.token_hash`) and NEVER logged (§VII / FR-006).
 */
import { z } from "zod";

/** TerminalPairRequest — `pairing_code` is the only field (6–32 chars). */
export const TerminalPairRequestSchema = z
  .object({
    pairing_code: z.string().min(6).max(32),
  })
  .strict();

export type TerminalPairRequestDto = z.infer<typeof TerminalPairRequestSchema>;

/** The success envelope (contract `TerminalPairResponse`). */
export interface TerminalPairResponseBody {
  readonly device_token: string;
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly terminal_id: string;
  readonly terminal_label: string;
  readonly branch_name: string;
  readonly branch_address: string;
  readonly tenant_tax_registration_id: string;
  readonly printer_vendor_id: string;
  readonly printer_product_id: string;
  readonly printer_com_port: string | null;
  /** The device credential's expiry (`devices.expires_at`, RT-138 L2); POS-Pulse v1 ignores it. */
  readonly expires_at?: string | null;
}

/**
 * The subset of a `pairing_codes` row the response projects. `branch_id` in the
 * contract == the code's `store_id`; `tenant_id` and `terminal_id` are the row's.
 */
export interface PairingCodeBindingRow {
  readonly tenant_id: string;
  readonly store_id: string;
  readonly terminal_id: string;
  readonly terminal_label: string;
  readonly branch_name: string;
  readonly branch_address: string;
  readonly tenant_tax_registration_id: string;
  readonly printer_vendor_id: string;
  readonly printer_product_id: string;
  readonly printer_com_port: string | null;
}

/**
 * Project a pairing_codes binding + the raw minted token into the wire envelope.
 * The raw token is supplied separately (never read from the DB — it is not
 * stored). `expires_at` is the minted device's `devices.expires_at` (RT-367 /
 * RT-287 F9: populated); omitted only when the caller has none.
 */
export function toTerminalPairBody(
  binding: PairingCodeBindingRow,
  rawDeviceToken: string,
  deviceExpiresAt?: Date,
): TerminalPairResponseBody {
  return {
    ...(deviceExpiresAt !== undefined ? { expires_at: deviceExpiresAt.toISOString() } : {}),
    device_token: rawDeviceToken,
    tenant_id: binding.tenant_id,
    branch_id: binding.store_id,
    terminal_id: binding.terminal_id,
    terminal_label: binding.terminal_label,
    branch_name: binding.branch_name,
    branch_address: binding.branch_address,
    tenant_tax_registration_id: binding.tenant_tax_registration_id,
    printer_vendor_id: binding.printer_vendor_id,
    printer_product_id: binding.printer_product_id,
    printer_com_port: binding.printer_com_port,
  };
}
