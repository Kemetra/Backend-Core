#!/usr/bin/env node
/**
 * Data-Pulse-2 PILOT/HOME terminal PAIRING-CODE seed.
 *
 * Owner-run, one-shot seed that inserts ONE `pending` row into `pairing_codes`
 * so a POS terminal can redeem it through the REAL consume endpoint:
 *
 *     POST /api/pos/v1/terminals/pair
 *
 * This is the "authorized seed lane" that migration `0024_pairing_codes.sql`
 * names: issuance (minting a code) is intentionally NOT an HTTP/admin endpoint
 * and authors no contract; a row is seeded directly. The POS still pairs ONLY
 * through the real consume flow (`PairingService.pair` → `findByCode` →
 * `burnAndProvision`) — this script forges NO local device state, mints NO
 * device_token, and adds NO API surface.
 *
 * WHAT THIS SEEDS (one DB row):
 *   - pairing_codes — a single `pending` code bound to (tenant_id, store_id),
 *     storing the SHA-256 HASH of the plaintext code (never the plaintext), plus
 *     the inline snapshot fields the consume pins at pair-time (terminal_label,
 *     branch_name/address, tax-reg id, printer vendor/product/com-port).
 *
 * WHAT THIS DOES **NOT** DO (out of scope, by design):
 *   - Mint a device / device_token. That is the runtime OUTPUT of the consume
 *     exchange (`POST /terminals/pair`) — never a seed row.
 *   - Create the tenant / store / operator. That is `bootstrap-pilot.ts`; this
 *     script REQUIRES the tenant_id + store_id it minted (reuse them verbatim).
 *   - Touch POS-Pulse, the orchestrator, OpenAPI, or any migration.
 *
 * HASHING — MUST stay byte-identical to `@data-pulse-2/auth` `hashToken`:
 *   the consume does `code_hash = hashToken(rawCode)` =
 *   `createHash('sha256').update(rawCode,'utf8').digest()` (a 32-byte Buffer),
 *   then `WHERE code_hash = $1`. `packages/db` does NOT depend on the `auth`
 *   package, so the identical computation is inlined below as `sha256Utf8`.
 *   If `hashToken` ever changes algorithm/encoding, this MUST change in lockstep
 *   or seeded codes silently become un-redeemable.
 *
 * SECURITY: the plaintext pairing code is a SECRET (the pairing-http contract
 * treats it as such). By DEFAULT this script NEVER prints it — the owner supplies
 * the code (PAIRING_CODE / --code; e.g. `openssl rand -base64 18`) and the script
 * only HASHES what it is given, originating and emitting no secret. The script
 * prints a secret ONLY when the owner OPTS IN with `--generate` (it then mints a
 * random code and prints it EXACTLY ONCE so it can be typed into the terminal).
 * Absent --generate and a supplied code, the script refuses (exit 3) rather than
 * silently inventing a printable secret. The code HASH, the DATABASE_URL, and any
 * device_token are NEVER printed under any mode.
 *
 * RLS: the INSERT runs inside ONE transaction with the tenant-context GUC set
 * (`app.current_tenant` = tenant_id), mirroring `bootstrap-pilot.ts` /
 * `runWithTenantContext` — the `pairing_codes_tenant_insert` policy requires it.
 *
 * Reads `DATABASE_URL` (same as migrate.ts / bootstrap-pilot.ts). Inputs via env
 * vars or `--flag value` CLI args (args win). Prints minted non-secret IDs as JSON.
 *
 * NOT idempotent (UNLIKE `bootstrap-pilot.ts`, which it mirrors only for the pg
 * Client / GUC / JSON-output conventions): each run inserts a fresh code row.
 * Re-running with the same supplied code hits the `code_hash` UNIQUE constraint
 * and exits 1 with a Postgres 23505 — by design (a pairing code is one-shot).
 *
 * Build first (a clean checkout has no dist): `pnpm --filter @data-pulse-2/db build`.
 *
 * Usage (DEFAULT — owner supplies the code; it is NEVER echoed):
 *   # mint your own secret out-of-band, e.g.  openssl rand -base64 18
 *   DATABASE_URL=postgres://... \
 *   PAIRING_TENANT_ID=<uuid> PAIRING_STORE_ID=<uuid> \
 *   PAIRING_CODE=<your-secret-code> \
 *   PAIRING_TERMINAL_LABEL="Home Counter 1" \
 *   PAIRING_BRANCH_NAME="Main Store" PAIRING_BRANCH_ADDRESS="1 Pilot St" \
 *   PAIRING_TAX_REGISTRATION_ID="123-456-789" \
 *   PAIRING_PRINTER_VENDOR_ID=0x04b8 PAIRING_PRINTER_PRODUCT_ID=0x0e15 \
 *   node dist/cli/bootstrap-pairing-code.js
 *
 * Usage (OPT-IN — generate a random code; printed EXACTLY ONCE to stdout):
 *   ... node dist/cli/bootstrap-pairing-code.js --generate
 *
 * Dry run (validate + show what WOULD insert; no DB write; no plaintext/hash):
 *   ... node dist/cli/bootstrap-pairing-code.js --dry-run            # with PAIRING_CODE set, or
 *   ... node dist/cli/bootstrap-pairing-code.js --dry-run --generate
 *
 * Exit codes: 0 success · 1 SQL/runtime error · 2 DATABASE_URL missing ·
 *             3 required input missing/invalid (incl. neither PAIRING_CODE nor --generate).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pairingCodeWeakness } from "./pairing-code-strength";
import { Client } from "pg";

const NIL_TENANT_ID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_EXPIRES_IN_MINUTES = 60;
const PRINTER_HEX = /^0x[0-9A-Fa-f]{4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SHA-256 of a UTF-8 string → 32-byte Buffer. MUST equal `@data-pulse-2/auth`
 * `hashToken(string)` byte-for-byte (the consume's `code_hash` lookup value).
 */
function sha256Utf8(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Generate a readable, URL-safe random pairing code (no ambiguous chars needed — base64url). */
function generatePairingCode(): string {
  // 18 bytes → 24 base64url chars; ample entropy, easy to type once.
  return randomBytes(18).toString("base64url");
}

interface PairingConfig {
  tenantId: string;
  storeId: string;
  /** Provided plaintext (never echoed) OR undefined → we generate + print once. */
  suppliedCode: string | undefined;
  terminalLabel: string;
  branchName: string;
  branchAddress: string;
  taxRegistrationId: string;
  printerVendorId: string;
  printerProductId: string;
  printerComPort: string | null;
  expiresInMinutes: number;
  dryRun: boolean;
  /** Opt-in: mint a random code and print it once. Mutually informs suppliedCode. */
  generate: boolean;
}

/**
 * Read a value from `--kebab-flag value` args first, then the env var. Both
 * sources are trimmed symmetrically: a `--code " x "` (or padded env value) must
 * hash the same string the operator types at the terminal, else the seeded code
 * is silently un-redeemable.
 */
function readArg(argv: string[], flag: string, envKey: string): string | undefined {
  const i = argv.indexOf(`--${flag}`);
  if (i !== -1 && i + 1 < argv.length) {
    const argVal = argv[i + 1]?.trim();
    return argVal !== undefined && argVal !== "" ? argVal : undefined;
  }
  const env = process.env[envKey];
  return env !== undefined && env.trim() !== "" ? env.trim() : undefined;
}

function fail(message: string): never {
  // Never includes the plaintext code, the hash, or DATABASE_URL.
  console.error(`bootstrap-pairing-code: ${message}`);
  process.exit(3);
}

function readConfig(argv: string[]): PairingConfig {
  const tenantId = readArg(argv, "tenant-id", "PAIRING_TENANT_ID");
  const storeId = readArg(argv, "store-id", "PAIRING_STORE_ID");
  const terminalLabel = readArg(argv, "terminal-label", "PAIRING_TERMINAL_LABEL");
  const branchName = readArg(argv, "branch-name", "PAIRING_BRANCH_NAME");
  const branchAddress = readArg(argv, "branch-address", "PAIRING_BRANCH_ADDRESS");
  const taxRegistrationId = readArg(argv, "tax-registration-id", "PAIRING_TAX_REGISTRATION_ID");
  const printerVendorId = readArg(argv, "printer-vendor-id", "PAIRING_PRINTER_VENDOR_ID");
  const printerProductId = readArg(argv, "printer-product-id", "PAIRING_PRINTER_PRODUCT_ID");
  const printerComPortRaw = readArg(argv, "printer-com-port", "PAIRING_PRINTER_COM_PORT");
  const suppliedCode = readArg(argv, "code", "PAIRING_CODE");
  const expiresRaw = readArg(argv, "expires-in-minutes", "PAIRING_EXPIRES_IN_MINUTES");

  // Required, validated against the migration's CHECK constraints so a bad value
  // fails HERE with a clear message rather than as an opaque 23514 at INSERT.
  if (!tenantId || !UUID_RE.test(tenantId)) fail("PAIRING_TENANT_ID must be a UUID");
  if (!storeId || !UUID_RE.test(storeId)) fail("PAIRING_STORE_ID must be a UUID");
  // Count code points (`[...s].length`), matching Postgres `length()` in the
  // schema CHECK — JS `.length` counts UTF-16 units and would under-count
  // astral characters (emoji/CJK), letting a >64-codepoint label pass here and
  // fail opaquely as a 23514 at INSERT.
  if (!terminalLabel || terminalLabel.trim() === "" || [...terminalLabel].length > 64) {
    fail("PAIRING_TERMINAL_LABEL is required, non-empty, and ≤ 64 characters");
  }
  if (!branchName || branchName.trim() === "") fail("PAIRING_BRANCH_NAME is required, non-empty");
  if (!branchAddress || branchAddress.trim() === "") {
    fail("PAIRING_BRANCH_ADDRESS is required, non-empty");
  }
  if (!taxRegistrationId || taxRegistrationId.trim() === "") {
    fail("PAIRING_TAX_REGISTRATION_ID is required, non-empty");
  }
  if (!printerVendorId || !PRINTER_HEX.test(printerVendorId)) {
    fail("PAIRING_PRINTER_VENDOR_ID must match 0xHHHH (4 hex digits), e.g. 0x04b8");
  }
  if (!printerProductId || !PRINTER_HEX.test(printerProductId)) {
    fail("PAIRING_PRINTER_PRODUCT_ID must match 0xHHHH (4 hex digits), e.g. 0x0e15");
  }
  const printerComPort =
    printerComPortRaw !== undefined && printerComPortRaw.trim() !== ""
      ? printerComPortRaw.trim()
      : null;

  let expiresInMinutes = DEFAULT_EXPIRES_IN_MINUTES;
  if (expiresRaw !== undefined) {
    const n = Number.parseInt(expiresRaw, 10);
    if (!Number.isInteger(n) || n <= 0) fail("PAIRING_EXPIRES_IN_MINUTES must be a positive integer");
    expiresInMinutes = n;
  }

  const generate = argv.includes("--generate");
  // The secret must EITHER be supplied (default; never echoed) OR explicitly
  // generated (--generate; printed once). Refuse to silently invent a printable
  // secret. Forbid both at once — the source must be unambiguous.
  if (!suppliedCode && !generate) {
    fail(
      "provide PAIRING_CODE (or --code) — the owner-supplied secret, never echoed — " +
        "OR pass --generate to mint and print a random code exactly once.",
    );
  }
  if (suppliedCode && generate) {
    fail("pass EITHER PAIRING_CODE/--code OR --generate, not both.");
  }
  // RT-141: refuse a guessable owner-supplied code (the reason never echoes it).
  const weakness = suppliedCode ? pairingCodeWeakness(suppliedCode) : null;
  if (weakness) fail(`PAIRING_CODE ${weakness}; or pass --generate`);

  return {
    tenantId,
    storeId,
    suppliedCode,
    terminalLabel,
    branchName,
    branchAddress,
    taxRegistrationId,
    printerVendorId,
    printerProductId,
    printerComPort,
    expiresInMinutes,
    dryRun: argv.includes("--dry-run"),
    generate,
  };
}

/** Set the tenant-context GUC for this transaction (mirrors bootstrap-pilot.setContext). */
async function setTenantContext(client: Client, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.current_tenant', $1, true)", [
    tenantId || NIL_TENANT_ID,
  ]);
}

interface SeededRow {
  pairing_code_id: string;
  terminal_id: string;
  tenant_id: string;
  store_id: string;
  status: "pending";
  expires_at: string;
}

async function insertPairingCode(
  client: Client,
  cfg: PairingConfig,
  codeHash: Buffer,
): Promise<SeededRow> {
  await setTenantContext(client, cfg.tenantId);
  const id = randomUUID();
  const terminalId = randomUUID();
  const res = await client.query<{ expires_at: string }>(
    `INSERT INTO pairing_codes (
       id, tenant_id, store_id, code_hash, terminal_id, terminal_label,
       branch_name, branch_address, tenant_tax_registration_id,
       printer_vendor_id, printer_product_id, printer_com_port,
       status, expires_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9,
       $10, $11, $12,
       'pending', now() + ($13 || ' minutes')::interval
     )
     RETURNING expires_at`,
    [
      id,
      cfg.tenantId,
      cfg.storeId,
      codeHash,
      terminalId,
      cfg.terminalLabel,
      cfg.branchName,
      cfg.branchAddress,
      cfg.taxRegistrationId,
      cfg.printerVendorId,
      cfg.printerProductId,
      cfg.printerComPort,
      String(cfg.expiresInMinutes),
    ],
  );
  return {
    pairing_code_id: id,
    terminal_id: terminalId,
    tenant_id: cfg.tenantId,
    store_id: cfg.storeId,
    status: "pending",
    expires_at: res.rows[0]?.expires_at ?? "(unknown)",
  };
}

/** Non-secret description of the pending insert — NO plaintext code, NO hash. */
function describeInsert(cfg: PairingConfig): Record<string, unknown> {
  return {
    tenant_id: cfg.tenantId,
    store_id: cfg.storeId,
    terminal_label: cfg.terminalLabel,
    branch_name: cfg.branchName,
    branch_address: cfg.branchAddress,
    tenant_tax_registration_id: cfg.taxRegistrationId,
    printer_vendor_id: cfg.printerVendorId,
    printer_product_id: cfg.printerProductId,
    printer_com_port: cfg.printerComPort,
    status: "pending",
    expires_in_minutes: cfg.expiresInMinutes,
    code_source: cfg.generate ? "generated (printed once on real run)" : "supplied (not echoed)",
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cfg = readConfig(argv);

  // The plaintext code: owner-supplied (default; never echoed) or freshly
  // generated (only with --generate; printed once on a real insert). readConfig
  // has already guaranteed exactly one of the two.
  const generated = cfg.generate;
  const plaintextCode = cfg.suppliedCode ?? generatePairingCode();

  if (cfg.dryRun) {
    // Dry run NEVER connects, NEVER prints the plaintext or the hash.
    console.log("bootstrap-pairing-code: DRY RUN — no DB connection, nothing inserted.");
    console.log(JSON.stringify(describeInsert(cfg), null, 2));
    console.log(
      "\nReal run will INSERT one pending pairing_codes row and (if the code was " +
        "generated) print the plaintext code exactly once.",
    );
    return;
  }

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }

  const codeHash = sha256Utf8(plaintextCode);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      const row = await insertPairingCode(client, cfg, codeHash);
      await client.query("COMMIT");
      console.log("bootstrap-pairing-code: seeded one pending pairing code. Non-secret row:");
      console.log(JSON.stringify(row, null, 2));
      if (generated) {
        // The ONE place the plaintext is emitted — a generated code the operator
        // must type into the terminal. A supplied code is never echoed.
        console.log("\nPAIRING CODE (type this into the POS terminal; shown once, not stored):");
        console.log(plaintextCode);
      }
      console.log(
        "\nNEXT: on the POS terminal, enter the pairing code on the pairing screen. " +
          "The terminal redeems it via POST /api/pos/v1/terminals/pair (the real consume " +
          "flow), which mints the device token. This script issues NO token and forges NO " +
          "local state.",
      );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  // Never includes the plaintext code, the hash, or DATABASE_URL.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`bootstrap-pairing-code: ${message}`);
  process.exit(1);
});
