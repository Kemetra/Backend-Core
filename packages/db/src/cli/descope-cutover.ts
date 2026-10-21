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
 * A user created after the 0025 backfill (bootstrap-pilot, later user creation)
 * has `users.clerk_user_id` but NO link row at all. For that state only, apply
 * first records the Clerk id as a DISABLED `clerk` link (issuer
 * `CLERK_JWT_ISSUER` or the 0025 default) so rollback has its source, and
 * reports it as `clerkLinksCreated`. Rollback then leaves that Clerk link
 * ACTIVE, the state the 0025 backfill would have produced.
 *
 * Idempotent: re-running a command already in its target state writes nothing
 * and reports zero counts. Any other unexpected state (no active Clerk link, a
 * Descope subject linked to — under any issuer — or held by another user) is
 * REFUSED with a code and nothing is written. `--dry-run` runs the same
 * transaction and rolls it back. Arguments are parsed strictly: an unknown,
 * duplicate or valueless flag (e.g. a mistyped `--dryrun`) is rejected, never
 * treated as a live run.
 *
 * Before running: drain the operator's POS offline audit queue. Audit ingestion
 * resolves `acting_operator_id` through `users.clerk_user_id`, so events queued
 * under the previous provider id are rejected after the flip (RT-791 known gap).
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

/**
 * The Clerk issuer for a link this CLI creates. SAME derivation as the API's
 * `clerkIssuer()` (clerk-identity-provider.adapter.ts) and the 0025 backfill
 * literal — keep the three in lockstep (a test pins both). Run the CLI with the
 * SAME CLERK_JWT_ISSUER the API runs with.
 */
export const DEFAULT_CLERK_ISSUER = "https://clerk.dp2.local";

const ISSUER_URL_RE = /^https:\/\/\S{1,500}$/;

/** Resolved once at parse time (like the Descope issuer); a malformed value is refused. */
export function clerkIssuerFromEnv(env: NodeJS.ProcessEnv): string {
  const fromEnv = env["CLERK_JWT_ISSUER"];
  if (!fromEnv || fromEnv.length === 0) return DEFAULT_CLERK_ISSUER;
  if (!ISSUER_URL_RE.test(fromEnv)) throw new Error("CLERK_JWT_ISSUER must be an https URL");
  return fromEnv;
}
const USAGE =
  "usage: descope-cutover apply --user <uuid> --descope-subject <id> [--dry-run] | rollback --user <uuid> [--dry-run]";

export type DescopeCutoverCommand =
  | {
      readonly kind: "apply";
      readonly userId: string;
      readonly descopeSubject: string;
      readonly issuer: string;
      /** Issuer for a clerk link apply has to create (users with no link row). */
      readonly clerkIssuer: string;
      readonly dryRun: boolean;
    }
  | { readonly kind: "rollback"; readonly userId: string; readonly dryRun: boolean };

type ApplyCommand = Extract<DescopeCutoverCommand, { kind: "apply" }>;

export interface CutoverResult {
  readonly command: "apply" | "rollback";
  readonly dryRun: boolean;
  readonly alreadyInTargetState: boolean;
  readonly usersUpdated: number;
  readonly linksDisabled: number;
  readonly linksActivated: number;
  /** 1 when apply created the user's missing clerk link from clerk_user_id. */
  readonly clerkLinksCreated: number;
}

type CutoverCounts = Omit<CutoverResult, "command" | "dryRun">;

/** A refused cutover: nothing was written. `code` is safe to print. */
export class CutoverRefusedError extends Error {
  constructor(readonly code: string) {
    super(`refused: ${code}`);
  }
}

// --- argument parsing (strict: unknown / duplicate / valueless flags refused) --

interface FlagSpec {
  readonly valued: readonly string[];
  readonly switches: readonly string[];
}

const FLAG_SPECS: Readonly<Record<DescopeCutoverCommand["kind"], FlagSpec>> = {
  apply: { valued: ["user", "descope-subject"], switches: ["dry-run"] },
  rollback: { valued: ["user"], switches: ["dry-run"] },
};

interface ParsedFlags {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

function flagName(arg: string): string {
  // Never echo the argument itself: it may be an id typed in the wrong slot.
  if (!arg.startsWith("--")) throw new Error(`unexpected positional argument; ${USAGE}`);
  return arg.slice(2);
}

function addOnce<T>(seen: Set<T>, name: T): void {
  if (seen.has(name)) throw new Error(`--${String(name)} given more than once`);
  seen.add(name);
}

/** Read `--flag value` / `--switch` pairs against the command's spec. */
function readFlags(args: readonly string[], spec: FlagSpec): ParsedFlags {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const name = flagName(args[i]!);
    addOnce(seen, name);
    if (spec.switches.includes(name)) {
      switches.add(name);
    } else if (spec.valued.includes(name)) {
      values.set(name, requireValue(name, args[i + 1]));
      i += 1;
    } else {
      throw new Error(`unknown flag; ${USAGE}`);
    }
  }
  return { values, switches };
}

function requireValue(name: string, value: string | undefined): string {
  const v = (value ?? "").trim();
  if (v === "" || v.startsWith("--")) throw new Error(`--${name} requires a value`);
  return v;
}

function requireUuid(flags: ParsedFlags): string {
  const userId = flags.values.get("user");
  if (userId === undefined || !UUID_RE.test(userId)) throw new Error("--user <uuid> is required");
  return userId.toLowerCase();
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

function isCommandKind(value: string | undefined): value is DescopeCutoverCommand["kind"] {
  return value === "apply" || value === "rollback";
}

/** Parse the command line; throws an Error naming the problem (never echoing values). */
export function parseDescopeCutoverArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): DescopeCutoverCommand {
  const [command, ...rest] = argv;
  if (!isCommandKind(command)) throw new Error(USAGE);
  const flags = readFlags(rest, FLAG_SPECS[command]);
  const userId = requireUuid(flags);
  const dryRun = flags.switches.has("dry-run");
  if (command === "rollback") return { kind: "rollback", userId, dryRun };
  const descopeSubject = flags.values.get("descope-subject");
  if (descopeSubject === undefined) throw new Error("--descope-subject <id> is required");
  return {
    kind: "apply",
    userId,
    descopeSubject,
    issuer: descopeIssuerFromEnv(env),
    clerkIssuer: clerkIssuerFromEnv(env),
    dryRun,
  };
}

// --- state ----------------------------------------------------------------

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
  /** Ordered most recently disabled first (active links last). */
  readonly links: readonly LinkRow[];
}

/** A subject the cutover is about to give to a user. */
interface SubjectClaim {
  readonly userId: string;
  readonly subject: string;
}

interface LinkFilter {
  readonly provider: string;
  readonly status: "active" | "disabled";
}

const ACTIVE_CLERK: LinkFilter = { provider: CLERK, status: "active" };
const DISABLED_CLERK: LinkFilter = { provider: CLERK, status: "disabled" };
const ACTIVE_DESCOPE: LinkFilter = { provider: DESCOPE, status: "active" };

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

function linksOf(state: UserState, filter: LinkFilter): LinkRow[] {
  return state.links.filter((l) => l.provider_key === filter.provider && l.status === filter.status);
}

/** The single active clerk link that matches the user's current wire id, else null. */
function currentClerkLink(state: UserState): LinkRow | null {
  const active = linksOf(state, ACTIVE_CLERK);
  const link = active.length === 1 ? active[0]! : null;
  return link?.subject === state.user.clerk_user_id ? link : null;
}

// --- writes -----------------------------------------------------------------

async function assertSubjectFree(client: ClientBase, claim: SubjectClaim): Promise<void> {
  const r = await client.query("SELECT 1 FROM users WHERE clerk_user_id = $1 AND id <> $2", [
    claim.subject,
    claim.userId,
  ]);
  if (r.rows.length > 0) throw new CutoverRefusedError("subject_held_by_other_user");
}

/**
 * A provider subject and the refusal code used when another user already holds it.
 */
interface SubjectGuard {
  readonly provider: string;
  readonly refusal: string;
}

const DESCOPE_GUARD: SubjectGuard = { provider: DESCOPE, refusal: "descope_subject_linked_to_other_user" };
const CLERK_GUARD: SubjectGuard = { provider: CLERK, refusal: "clerk_subject_linked_to_other_user" };

/**
 * The resolver joins on (provider_key, subject) WITHOUT issuer, so a subject
 * linked to another user under ANY issuer would make sign-in ambiguous.
 */
async function assertSubjectUnlinked(
  client: ClientBase,
  guard: SubjectGuard,
  claim: SubjectClaim,
): Promise<void> {
  const r = await client.query(
    `SELECT 1 FROM external_identity_links
      WHERE provider_key = $1 AND subject = $2 AND user_id <> $3`,
    [guard.provider, claim.subject, claim.userId],
  );
  if (r.rows.length > 0) throw new CutoverRefusedError(guard.refusal);
}

/** A clerk link apply creates for a user that never had one. */
interface NewClerkLink {
  readonly claim: SubjectClaim;
  readonly issuer: string;
  readonly email: string | null;
}

/**
 * Users created after the 0025 backfill (bootstrap-pilot, later user creation)
 * carry clerk_user_id but no link row. Record it as a DISABLED clerk link so it
 * is rollback's source, exactly like a link apply disabled.
 */
async function insertDisabledClerkLink(client: ClientBase, link: NewClerkLink): Promise<void> {
  const r = await client.query(
    `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, email, status, disabled_at)
     VALUES ($1, $2, $3, $4, $5, 'disabled', now())
     ON CONFLICT (provider_key, issuer, subject) DO NOTHING
     RETURNING id`,
    [CLERK, link.issuer, link.claim.subject, link.claim.userId, link.email],
  );
  if (r.rows.length !== 1) throw new CutoverRefusedError(CLERK_GUARD.refusal);
}

async function disableLink(client: ClientBase, link: LinkRow): Promise<void> {
  await client.query(
    "UPDATE external_identity_links SET status = 'disabled', disabled_at = now() WHERE id = $1",
    [link.id],
  );
}

async function activateLink(client: ClientBase, link: LinkRow): Promise<void> {
  await client.query(
    "UPDATE external_identity_links SET status = 'active', disabled_at = NULL WHERE id = $1",
    [link.id],
  );
}

async function setClerkUserId(client: ClientBase, claim: SubjectClaim): Promise<void> {
  await client.query("UPDATE users SET clerk_user_id = $1 WHERE id = $2", [claim.subject, claim.userId]);
}

const NO_CHANGE: CutoverCounts = {
  alreadyInTargetState: true,
  usersUpdated: 0,
  linksDisabled: 0,
  linksActivated: 0,
  clerkLinksCreated: 0,
};
const FLIPPED: CutoverCounts = {
  alreadyInTargetState: false,
  usersUpdated: 1,
  linksDisabled: 1,
  linksActivated: 1,
  clerkLinksCreated: 0,
};
/** apply for a user with no clerk link: nothing to disable, one link created. */
const FLIPPED_WITH_CREATED_CLERK_LINK: CutoverCounts = { ...FLIPPED, linksDisabled: 0, clerkLinksCreated: 1 };

async function upsertActiveDescopeLink(
  client: ClientBase,
  cmd: ApplyCommand,
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

// --- commands -----------------------------------------------------------------

/** true = already applied; throws on a descope state apply must not touch. */
function alreadyApplied(state: UserState, cmd: ApplyCommand): boolean {
  const active = linksOf(state, ACTIVE_DESCOPE);
  if (active.length === 0) return false;
  const same = active.some((l) => l.subject === cmd.descopeSubject && l.issuer === cmd.issuer);
  if (same && state.user.clerk_user_id === cmd.descopeSubject) return true;
  throw new CutoverRefusedError("inconsistent_descope_state");
}

/** What apply retires: the active clerk link, or the bare clerk_user_id of a user with no clerk link. */
type ClerkSource =
  | { readonly kind: "link"; readonly link: LinkRow }
  | { readonly kind: "bridge-column"; readonly claim: SubjectClaim };

function clerkSource(state: UserState): ClerkSource {
  const link = currentClerkLink(state);
  if (link) return { kind: "link", link };
  const subject = state.user.clerk_user_id;
  const hasClerkLink = state.links.some((l) => l.provider_key === CLERK);
  // Only the "never linked" state is repaired; any other mismatch is refused.
  if (!subject || hasClerkLink) throw new CutoverRefusedError("no_matching_active_clerk_link");
  // One active link per user: another provider's active link would fail the
  // descope upsert mid-transaction — refuse it with a code instead.
  if (state.links.some((l) => l.status === "active")) throw new CutoverRefusedError("unexpected_active_link");
  return { kind: "bridge-column", claim: { userId: state.user.id, subject } };
}

/** Disable the clerk link, or create it disabled; returns the counts for that path. */
async function retireClerkSource(
  client: ClientBase,
  source: ClerkSource,
  newLink: Omit<NewClerkLink, "claim">,
): Promise<CutoverCounts> {
  if (source.kind === "link") {
    await disableLink(client, source.link);
    return FLIPPED;
  }
  await assertSubjectUnlinked(client, CLERK_GUARD, source.claim);
  await insertDisabledClerkLink(client, { ...newLink, claim: source.claim });
  return FLIPPED_WITH_CREATED_CLERK_LINK;
}

async function applyCutover(client: ClientBase, cmd: ApplyCommand): Promise<CutoverCounts> {
  const state = await lockUserState(client, cmd.userId);
  if (alreadyApplied(state, cmd)) return NO_CHANGE;
  const source = clerkSource(state);
  const claim: SubjectClaim = { userId: cmd.userId, subject: cmd.descopeSubject };
  await assertSubjectFree(client, claim);
  await assertSubjectUnlinked(client, DESCOPE_GUARD, claim);
  const counts = await retireClerkSource(client, source, {
    issuer: cmd.clerkIssuer,
    email: state.user.email,
  });
  await upsertActiveDescopeLink(client, cmd, state.user.email);
  await setClerkUserId(client, claim);
  return counts;
}

/** The active descope link rollback reverses; null when already rolled back. */
function descopeLinkToReverse(state: UserState): LinkRow | null {
  const active = linksOf(state, ACTIVE_DESCOPE)[0];
  if (!active) {
    if (currentClerkLink(state)) return null;
    throw new CutoverRefusedError("no_active_descope_link");
  }
  if (active.subject !== state.user.clerk_user_id) {
    throw new CutoverRefusedError("inconsistent_descope_state");
  }
  return active;
}

async function rollbackCutover(client: ClientBase, userId: string): Promise<CutoverCounts> {
  const state = await lockUserState(client, userId);
  const descopeLink = descopeLinkToReverse(state);
  if (!descopeLink) return NO_CHANGE;
  // The most recently disabled clerk link is the one apply replaced; older
  // disabled ones are earlier history.
  const clerkLink = linksOf(state, DISABLED_CLERK)[0];
  if (!clerkLink) throw new CutoverRefusedError("no_disabled_clerk_link");
  const claim: SubjectClaim = { userId, subject: clerkLink.subject };
  await assertSubjectFree(client, claim);
  // Re-check at rollback time: another user may have been linked to this clerk
  // subject since apply, and two active (clerk, subject) rows are ambiguous.
  await assertSubjectUnlinked(client, CLERK_GUARD, claim);
  await disableLink(client, descopeLink);
  await activateLink(client, clerkLink);
  await setClerkUserId(client, claim);
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
