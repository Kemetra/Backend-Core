/**
 * RT-367 (RT-287 F4) — pure helpers of the Console pairing codes
 * (`devices.openapi.yaml`, "Pairing codes"): the generated code, the default
 * terminal label, the list cursor and the wire projections. No DB, no clock.
 *
 * The code is a SECRET. It is generated here, returned once in the issue's
 * 201 and never stored (only `hashToken(code)` is), logged or audited.
 */
import { randomInt } from "node:crypto";

import { z } from "zod";

/** 30 symbols with no look-alikes (no 0 / O, 1 / I / L, U). */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const PAIRING_CODE_LENGTH = 16;
/** RT-141's strength floor (`pairing-code-strength.ts`): at least 8 distinct characters. */
const MIN_DISTINCT = 8;

/** A one-time pairing code: 16 random symbols (~78 bits) that clear the RT-141 floor. */
export function generatePairingCode(): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
    if (new Set(code).size >= MIN_DISTINCT) return code;
  }
}

/**
 * The label of a code issued without one: `T-` + the first 8 hex digits of
 * the (random, v4) terminal id. Never the replaced device's label, whose sale
 * numbers (`<label>-<date>-<seq>`) stay its own.
 */
export function defaultTerminalLabel(terminalId: string): string {
  return `T-${terminalId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Cursor (repo convention, as `devices.projections.ts`)
// ---------------------------------------------------------------------------

/** Raised for a cursor this operation did not issue → 400 validation_error. */
export class InvalidPairingCodeCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this operation");
    this.name = "InvalidPairingCodeCursorError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Renders `created_at` as the cursor key: UTC with microseconds, exact on the cast back. */
export const CREATED_AT_KEY_SQL = `to_char(pc.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CursorSchema = z
  .object({
    k: z.literal("pairing_codes"),
    t: z.string().regex(UUID_RE),
    c: z.string().regex(INSTANT_KEY_RE),
    i: z.string().regex(UUID_RE),
  })
  .strict();

/** The keyset position (newest first) after which the next page starts. */
export interface PairingCodeKeyset {
  readonly createdAtKey: string;
  readonly pairingCodeId: string;
}

export function encodePairingCodeCursor(input: { readonly tenantId: string } & PairingCodeKeyset): string {
  const payload = { k: "pairing_codes", t: input.tenantId.toLowerCase(), c: input.createdAtKey, i: input.pairingCodeId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodePairingCodeCursor(input: { readonly tenantId: string; readonly cursor: string }): PairingCodeKeyset {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidPairingCodeCursorError();
  }
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success || parsed.data.t !== input.tenantId.toLowerCase()) throw new InvalidPairingCodeCursorError();
  const ms = Date.parse(parsed.data.c);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== parsed.data.c.slice(0, 19)) {
    throw new InvalidPairingCodeCursorError();
  }
  return { createdAtKey: parsed.data.c, pairingCodeId: parsed.data.i };
}

// ---------------------------------------------------------------------------
// Rows and projections
// ---------------------------------------------------------------------------

export type PairingCodeKind = "pair" | "replace" | "move";

/** A `pairing_codes` row as the service reads it (never `code_hash`). */
export interface PairingCodeReadRow {
  readonly id: string;
  readonly store_id: string;
  readonly terminal_id: string;
  readonly terminal_label: string;
  readonly status: "pending" | "used" | "cancelled";
  /** The replaced device, or null when none or outside the caller's scope. */
  readonly replaces_device_id: string | null;
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly created_at_key: string;
}

export interface PairingCodeSummary {
  readonly pairingCodeId: string;
  readonly storeId: string;
  readonly terminalId: string;
  readonly terminalLabel: string;
  readonly status: "pending" | "cancelled";
  readonly replacesDeviceId: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface PairingCodeIssued {
  readonly pairingCodeId: string;
  /** SECRET: in the issue's 201 only. */
  readonly code: string;
  readonly kind: PairingCodeKind;
  readonly storeId: string;
  readonly terminalId: string;
  readonly terminalLabel: string;
  readonly replacesDeviceId: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface PairingCodePage {
  readonly items: PairingCodeSummary[];
  readonly nextCursor: string | null;
}

export interface PairingCodeCancelResult {
  readonly outcome: "cancelled" | "already_cancelled";
  readonly pairingCode: PairingCodeSummary;
}

export function toPairingCodeSummary(row: PairingCodeReadRow): PairingCodeSummary {
  if (row.status === "used") throw new Error("a used code has no summary");
  return {
    pairingCodeId: row.id,
    storeId: row.store_id,
    terminalId: row.terminal_id,
    terminalLabel: row.terminal_label,
    status: row.status,
    replacesDeviceId: row.replaces_device_id,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}
