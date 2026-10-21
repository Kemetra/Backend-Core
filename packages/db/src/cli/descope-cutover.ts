#!/usr/bin/env node
/**
 * Clerk -> Descope operator cutover — RT-791 (RT-790 approach A).
 *
 * Moves ONE user's operator identity from Clerk to Descope, or back, in ONE
 * transaction. Approach A keeps the POS wire id (`operator.id` =
 * `users.clerk_user_id`) equal to the provider user id, so the cutover is a row
 * flip, not a config toggle:
 *
 *   apply    --user <uuid> --descope-subject <descope user id> [--dry-run]
 *     1. disable the user's ACTIVE `clerk` link (status 'disabled', disabled_at);
 *     2. upsert the ACTIVE `descope` link (provider_key 'descope', the Descope
 *        issuer, subject = the Descope user id);
 *     3. set `users.clerk_user_id` to the Descope user id.
 *     The old Clerk id stays in the disabled `clerk` link row (the rollback source).
 *
 *   rollback --user <uuid> [--dry-run]
 *     Reverses exactly: disables the active `descope` link, re-activates the
 *     user's most recently disabled `clerk` link (the one apply disabled) and
 *     restores `users.clerk_user_id` from it.
 *
 * Order matters: `external_identity_links_one_active_per_user_uidx` allows one
 * ACTIVE link per user, so the old link is disabled before the new one is
 * activated. Both commands lock the `users` row first (FOR UPDATE).
 *
 * Idempotent: re-running a command already in its target state writes nothing
 * and reports zero counts. Any other unexpected state (no active Clerk link, a
 * Descope subject linked to (under any issuer) or held by another user) is REFUSED with a code and nothing is written. `--dry-run` runs the same
 * transaction and rolls it back.
 *
 * Issuer: `DESCOPE_JWT_ISSUER` when set, else `https://api.descope.com/<DESCOPE_PROJECT_ID>`
 * — the same derivation as the API's Descope adapter (apps/api cannot be imported
 * here; keep the two in lockstep). Only `apply` needs it.
 *
 * Output is counts and codes only — never ids, subjects or emails. `users` and
 * `external_identity_links` are tenant-agnostic (no RLS), so no tenant GUC is set.
 *
 * Build first: `pnpm --filter @data-pulse-2/db build`, then
 *   DATABASE_URL=postgres://... DESCOPE_PROJECT_ID=P2... \
 *   node dist/cli/descope-cutover.js apply --user <uuid> --descope-subject <id> --dry-run
 *
 * Exit codes: 0 success · 1 SQL/runtime error · 2 DATABASE_URL missing ·
 *             3 invalid arguments · 4 refused (nothing written).
 */
import { Client, type ClientBase } from "pg";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_ID_RE = /^[A-Za-z0-9]{1,64}$/;
const DESCOPE_API_BASE = "https://api.descope.com";
const CLERK = "clerk";
const DESCOPE = "descope";

export type DescopeCutoverCommand =
  | {
      readonly kind: "apply";
      readonly userId: string;
      readonly descopeSubject: string;
      readonly issuer: string;
      readonly dryRun: boolean;
    }
  | { readonly kind: "rollback"; readonly userId: string; readonly dryRun: boolean };

export interface CutoverResult {
  readonly command: "apply" | "rollback";
  readonly dryRun: boolean;
  readonly alreadyInTargetState: boolean;
  readonly usersUpdated: number;
  readonly linksDisabled: number;
  readonly linksActivated: number;
}

/** A refused cutover: nothing was written. `code` is safe to print. */
export class CutoverRefusedError extends Error {
  constructor(readonly code: string) {
    super(`refused: ${code}`);
  }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** The Descope issuer from env, matching the API adapter's derivation. */
export function descopeIssuerFromEnv(env: NodeJS.ProcessEnv): string {
  const override = (env["DESCOPE_JWT_ISSUER"] ?? "").trim();
  if (override.length > 0) return override;
  const projectId = (env["DESCOPE_PROJECT_ID"] ?? "").trim();
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error("DESCOPE_PROJECT_ID (alphanumeric) or DESCOPE_JWT_ISSUER is required for apply");
  }
  return `${DESCOPE_API_BASE}/${projectId}`;
}

/** Parse the command line; throws an Error naming the problem (never echoing values). */
export function parseDescopeCutoverArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): DescopeCutoverCommand {
  const [command] = argv;
  if (command !== "apply" && command !== "rollback") {
    throw new Error(
      "usage: descope-cutover apply --user <uuid> --descope-subject <id> [--dry-run] | rollback --user <uuid> [--dry-run]",
    );
  }
  const userId = flag(argv, "user");
  if (userId === undefined || !UUID_RE.test(userId)) throw new Error("--user <uuid> is required");
  const dryRun = argv.includes("--dry-run");
  if (command === "rollback") return { kind: "rollback", userId: userId.toLowerCase(), dryRun };
  const descopeSubject = (flag(argv, "descope-subject") ?? "").trim();
  if (descopeSubject === "" || descopeSubject.startsWith("--")) {
    throw new Error("--descope-subject <id> is required");
  }
  return {
    kind: "apply",
    userId: userId.toLowerCase(),
    descopeSubject,
    issuer: descopeIssuerFromEnv(env),
    dryRun,
  };
}

interface UserRow {
  readonly id: string;
  readonly email: string | null;
  readonly clerk_user_id: string | null;
}

interface LinkRow {
  readonly id: string;
  readonly provider_key: string;
  readonly issuer: string;
  readonly subject: string;
  readonly status: string;
  readonly disabled_at: Date | null;
}

interface UserState {
  readonly user: UserRow;
  readonly links: readonly LinkRow[];
}

async function lockUserState(client: ClientBase, userId: string): Promise<UserState> {
  const u = await client.query<UserRow>(
    "SELECT id, email, clerk_user_id FROM users WHERE id = $1 FOR UPDATE",
    [userId],
  );
  const user = u.rows[0];
  if (!user) throw new CutoverRefusedError("user_not_found");
  const l = await client.query<LinkRow>(
    `SELECT id, provider_key, issuer, subject, status, disabled_at
       FROM external_identity_links WHERE user_id = $1
      ORDER BY disabled_at DESC NULLS LAST, id
      FOR UPDATE`,
    [userId],
  );
  return { user, links: l.rows };
}

function linksOf(state: UserState, provider: string, status: string): LinkRow[] {
  return state.links.filter((l) => l.provider_key === provider && l.status === status);
}

async function assertSubjectFree(
  client: ClientBase,
  userId: string,
  subject: string,
): Promise<void> {
  const r = await client.query("SELECT 1 FROM users WHERE clerk_user_id = $1 AND id <> $2", [
    subject,
    userId,
  ]);
  if (r.rows.length > 0) throw new CutoverRefusedError("subject_held_by_other_user");
}

/**
 * The resolver joins on (provider_key, subject) WITHOUT issuer, so a Descope
 * subject linked to another user under ANY issuer would make sign-in ambiguous.
 */
async function assertDescopeSubjectUnlinked(
  client: ClientBase,
  userId: string,
  subject: string,
): Promise<void> {
  const r = await client.query(
    `SELECT 1 FROM external_identity_links
      WHERE provider_key = $1 AND subject = $2 AND user_id <> $3`,
    [DESCOPE, subject, userId],
  );
  if (r.rows.length > 0) throw new CutoverRefusedError("descope_subject_linked_to_other_user");
}

async function setLinkStatus(client: ClientBase, linkId: string, active: boolean): Promise<void> {
  await client.query(
    active
      ? "UPDATE external_identity_links SET status = 'active', disabled_at = NULL WHERE id = $1"
      : "UPDATE external_identity_links SET status = 'disabled', disabled_at = now() WHERE id = $1",
    [linkId],
  );
}

async function setClerkUserId(client: ClientBase, userId: string, subject: string): Promise<void> {
  await client.query("UPDATE users SET clerk_user_id = $1 WHERE id = $2", [subject, userId]);
}

const NO_CHANGE = { alreadyInTargetState: true, usersUpdated: 0, linksDisabled: 0, linksActivated: 0 };
const FLIPPED = { alreadyInTargetState: false, usersUpdated: 1, linksDisabled: 1, linksActivated: 1 };

async function upsertActiveDescopeLink(
  client: ClientBase,
  cmd: Extract<DescopeCutoverCommand, { kind: "apply" }>,
  email: string | null,
): Promise<void> {
  const r = await client.query(
    `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, email, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     ON CONFLICT (provider_key, issuer, subject) DO UPDATE
       SET status = 'active', disabled_at = NULL
       WHERE external_identity_links.user_id = EXCLUDED.user_id
     RETURNING id`,
    [DESCOPE, cmd.issuer, cmd.descopeSubject, cmd.userId, email],
  );
  if (r.rows.length !== 1) throw new CutoverRefusedError("descope_subject_linked_to_other_user");
}

async function applyCutover(
  client: ClientBase,
  cmd: Extract<DescopeCutoverCommand, { kind: "apply" }>,
): Promise<Omit<CutoverResult, "command" | "dryRun">> {
  const state = await lockUserState(client, cmd.userId);
  const activeDescope = linksOf(state, DESCOPE, "active");
  if (activeDescope.length > 0) {
    const done = activeDescope.some(
      (l) => l.subject === cmd.descopeSubject && l.issuer === cmd.issuer,
    );
    if (done && state.user.clerk_user_id === cmd.descopeSubject) return NO_CHANGE;
    throw new CutoverRefusedError("inconsistent_descope_state");
  }
  const activeClerk = linksOf(state, CLERK, "active");
  if (activeClerk.length !== 1 || activeClerk[0]!.subject !== state.user.clerk_user_id) {
    throw new CutoverRefusedError("no_matching_active_clerk_link");
  }
  await assertSubjectFree(client, cmd.userId, cmd.descopeSubject);
  await assertDescopeSubjectUnlinked(client, cmd.userId, cmd.descopeSubject);
  await setLinkStatus(client, activeClerk[0]!.id, false);
  await upsertActiveDescopeLink(client, cmd, state.user.email);
  await setClerkUserId(client, cmd.userId, cmd.descopeSubject);
  return FLIPPED;
}

async function rollbackCutover(
  client: ClientBase,
  userId: string,
): Promise<Omit<CutoverResult, "command" | "dryRun">> {
  const state = await lockUserState(client, userId);
  const activeDescope = linksOf(state, DESCOPE, "active");
  if (activeDescope.length === 0) {
    const activeClerk = linksOf(state, CLERK, "active");
    if (activeClerk.length === 1 && activeClerk[0]!.subject === state.user.clerk_user_id) {
      return NO_CHANGE;
    }
    throw new CutoverRefusedError("no_active_descope_link");
  }
  if (activeDescope[0]!.subject !== state.user.clerk_user_id) {
    throw new CutoverRefusedError("inconsistent_descope_state");
  }
  // The most recently disabled clerk link is the one apply replaced (links are
  // read ORDER BY disabled_at DESC); older disabled ones are earlier history.
  const clerkLink = linksOf(state, CLERK, "disabled")[0];
  if (!clerkLink) throw new CutoverRefusedError("no_disabled_clerk_link");
  await assertSubjectFree(client, userId, clerkLink.subject);
  await setLinkStatus(client, activeDescope[0]!.id, false);
  await setLinkStatus(client, clerkLink.id, true);
  await setClerkUserId(client, userId, clerkLink.subject);
  return FLIPPED;
}

/**
 * Run one command in ONE transaction (rolled back on --dry-run or any error).
 * Throws `CutoverRefusedError` for a refused state.
 */
export async function runDescopeCutover(
  client: ClientBase,
  cmd: DescopeCutoverCommand,
): Promise<CutoverResult> {
  await client.query("BEGIN");
  try {
    const counts =
      cmd.kind === "apply" ? await applyCutover(client, cmd) : await rollbackCutover(client, cmd.userId);
    await client.query(cmd.dryRun ? "ROLLBACK" : "COMMIT");
    return { command: cmd.kind, dryRun: cmd.dryRun, ...counts };
  } catch (err) {
    // A failing ROLLBACK (e.g. dropped connection) must not mask the original error.
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

async function main(): Promise<void> {
  let cmd: DescopeCutoverCommand;
  try {
    cmd = parseDescopeCutoverArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`descope-cutover: ${(err as Error).message}`);
    process.exit(3);
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    console.log(JSON.stringify(await runDescopeCutover(client, cmd), null, 2));
  } catch (err) {
    if (!(err instanceof CutoverRefusedError)) throw err;
    console.error(JSON.stringify({ command: cmd.kind, refused: err.code }));
    process.exitCode = 4;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    // Message only: pg's `detail` (which can quote key values) is never printed,
    // and DATABASE_URL is never included.
    console.error(`descope-cutover: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
