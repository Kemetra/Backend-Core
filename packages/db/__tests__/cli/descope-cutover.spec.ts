/**
 * RT-791 — Clerk -> Descope cutover CLI against real Postgres (full schema,
 * Testcontainers), run as the non-superuser app role like the deployed tool.
 *
 * Proves: apply flips the links and `users.clerk_user_id` in one transaction;
 * rollback restores the original Clerk id and link states exactly; both are
 * idempotent (zero counts on re-run) and repeatable (apply → rollback → apply →
 * rollback); --dry-run writes nothing; unexpected states are refused with
 * nothing written; and the result carries counts only.
 */
import type { PoolClient } from "pg";

import {
  CutoverRefusedError,
  runDescopeCutover,
  type DescopeCutoverCommand,
} from "../../src/cli/descope-cutover";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const CLERK_ISSUER = "https://clerk.dp2.local";
const DESCOPE_ISSUER = "https://api.descope.com/P2cutoverTest01";

let env: PgTestEnv | null = null;
let seq = 0;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

interface Fixture {
  readonly userId: string;
  readonly clerkSub: string;
  readonly descopeSub: string;
}

/** A user with clerk_user_id + its active clerk link (as the 0025 backfill writes it). */
async function seedUser(): Promise<Fixture> {
  seq += 1;
  const n = (0x791000000000 + seq).toString(16);
  const userId = `0a000000-0000-7000-8000-${n}`;
  const clerkSub = `user_clerk_cutover_${seq}`;
  const descopeSub = `U2descopeCutover${seq}`;
  const a = pg().admin;
  await a.query(`INSERT INTO users (id, email, clerk_user_id) VALUES ($1, $2, $3)`, [
    userId,
    `cutover${seq}@rt791.example`,
    clerkSub,
  ]);
  await a.query(
    `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, email, status)
     VALUES ('clerk', $1, $2, $3, $4, 'active')`,
    [CLERK_ISSUER, clerkSub, userId, `cutover${seq}@rt791.example`],
  );
  return { userId, clerkSub, descopeSub };
}

interface Snapshot {
  readonly clerkUserId: string | null;
  readonly links: ReadonlyArray<{
    provider_key: string;
    issuer: string;
    subject: string;
    status: string;
    disabled: boolean;
  }>;
}

async function snapshot(userId: string): Promise<Snapshot> {
  const a = pg().admin;
  const u = await a.query<{ clerk_user_id: string | null }>(
    "SELECT clerk_user_id FROM users WHERE id = $1",
    [userId],
  );
  const l = await a.query(
    `SELECT provider_key, issuer, subject, status, disabled_at IS NOT NULL AS disabled
       FROM external_identity_links WHERE user_id = $1 ORDER BY provider_key, subject`,
    [userId],
  );
  return { clerkUserId: u.rows[0]?.clerk_user_id ?? null, links: l.rows };
}

async function run(cmd: DescopeCutoverCommand) {
  const client: PoolClient = await pg().app.connect();
  try {
    return await runDescopeCutover(client, cmd);
  } finally {
    client.release();
  }
}

const apply = (f: Fixture, dryRun = false): DescopeCutoverCommand => ({
  kind: "apply",
  userId: f.userId,
  descopeSubject: f.descopeSub,
  issuer: DESCOPE_ISSUER,
  dryRun,
});
const rollback = (f: Fixture, dryRun = false): DescopeCutoverCommand => ({
  kind: "rollback",
  userId: f.userId,
  dryRun,
});

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[descope-cutover.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("descope-cutover apply", () => {
  it("disables the clerk link, activates a descope link and rewrites clerk_user_id", async () => {
    if (skip()) return;
    const f = await seedUser();
    const result = await run(apply(f));
    expect(result).toEqual({
      command: "apply",
      dryRun: false,
      alreadyInTargetState: false,
      usersUpdated: 1,
      linksDisabled: 1,
      linksActivated: 1,
    });
    expect(await snapshot(f.userId)).toEqual({
      clerkUserId: f.descopeSub,
      links: [
        { provider_key: "clerk", issuer: CLERK_ISSUER, subject: f.clerkSub, status: "disabled", disabled: true },
        { provider_key: "descope", issuer: DESCOPE_ISSUER, subject: f.descopeSub, status: "active", disabled: false },
      ],
    });
    // Counts only: no id, subject or email in the result.
    const flat = JSON.stringify(result);
    for (const v of [f.userId, f.clerkSub, f.descopeSub, "@rt791.example"]) {
      expect(flat).not.toContain(v);
    }
  });

  it("is idempotent: a second apply writes nothing", async () => {
    if (skip()) return;
    const f = await seedUser();
    await run(apply(f));
    const before = await snapshot(f.userId);
    await expect(run(apply(f))).resolves.toMatchObject({
      alreadyInTargetState: true,
      usersUpdated: 0,
      linksDisabled: 0,
      linksActivated: 0,
    });
    expect(await snapshot(f.userId)).toEqual(before);
  });

  it("--dry-run reports the counts and writes nothing", async () => {
    if (skip()) return;
    const f = await seedUser();
    const before = await snapshot(f.userId);
    await expect(run(apply(f, true))).resolves.toMatchObject({ dryRun: true, usersUpdated: 1 });
    expect(await snapshot(f.userId)).toEqual(before);
  });
});

describe("descope-cutover rollback", () => {
  it("restores the original clerk_user_id and clerk link exactly; the descope link ends disabled", async () => {
    if (skip()) return;
    const f = await seedUser();
    const original = await snapshot(f.userId);
    await run(apply(f));
    await expect(run(rollback(f))).resolves.toMatchObject({
      command: "rollback",
      alreadyInTargetState: false,
      usersUpdated: 1,
      linksDisabled: 1,
      linksActivated: 1,
    });
    const after = await snapshot(f.userId);
    expect(after.clerkUserId).toBe(f.clerkSub);
    expect(after.links.find((l) => l.provider_key === "clerk")).toEqual(original.links[0]);
    expect(after.links.find((l) => l.provider_key === "descope")).toEqual({
      provider_key: "descope",
      issuer: DESCOPE_ISSUER,
      subject: f.descopeSub,
      status: "disabled",
      disabled: true,
    });
  });

  it("is idempotent and repeatable: apply → rollback → apply → rollback → rollback", async () => {
    if (skip()) return;
    const f = await seedUser();
    await run(apply(f));
    await run(rollback(f));
    const rolledBack = await snapshot(f.userId);
    await expect(run(apply(f))).resolves.toMatchObject({ alreadyInTargetState: false });
    expect((await snapshot(f.userId)).clerkUserId).toBe(f.descopeSub);
    await run(rollback(f));
    expect(await snapshot(f.userId)).toEqual(rolledBack);
    await expect(run(rollback(f))).resolves.toMatchObject({ alreadyInTargetState: true, usersUpdated: 0 });
    expect(await snapshot(f.userId)).toEqual(rolledBack);
  });

  it("--dry-run writes nothing", async () => {
    if (skip()) return;
    const f = await seedUser();
    await run(apply(f));
    const applied = await snapshot(f.userId);
    await run(rollback(f, true));
    expect(await snapshot(f.userId)).toEqual(applied);
  });
});

describe("descope-cutover refusals (nothing written)", () => {
  async function expectRefused(cmd: DescopeCutoverCommand, code: string, userId: string) {
    const before = await snapshot(userId);
    const err = await run(cmd).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CutoverRefusedError);
    expect((err as CutoverRefusedError).code).toBe(code);
    expect(await snapshot(userId)).toEqual(before);
  }

  it("an unknown user", async () => {
    if (skip()) return;
    const f = await seedUser();
    await expectRefused({ ...apply(f), userId: "0a000000-0000-7000-8000-ffffffffffff" } as DescopeCutoverCommand, "user_not_found", f.userId);
  });

  it("a user with no active clerk link", async () => {
    if (skip()) return;
    const f = await seedUser();
    await pg().admin.query(
      "UPDATE external_identity_links SET status = 'disabled', disabled_at = now() WHERE user_id = $1",
      [f.userId],
    );
    await expectRefused(apply(f), "no_matching_active_clerk_link", f.userId);
  });

  it("a descope subject already held by another user's clerk_user_id", async () => {
    if (skip()) return;
    const f = await seedUser();
    const other = await seedUser();
    await expectRefused({ ...apply(f), descopeSubject: other.clerkSub } as DescopeCutoverCommand, "subject_held_by_other_user", f.userId);
  });

  it("a descope subject already linked to another user", async () => {
    if (skip()) return;
    const f = await seedUser();
    const other = await seedUser();
    await pg().admin.query(
      `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status, disabled_at)
       VALUES ('descope', $1, $2, $3, 'disabled', now())`,
      [DESCOPE_ISSUER, f.descopeSub, other.userId],
    );
    await expectRefused(apply(f), "descope_subject_linked_to_other_user", f.userId);
  });

  it("apply with a different descope subject while one is active", async () => {
    if (skip()) return;
    const f = await seedUser();
    await run(apply(f));
    await expectRefused({ ...apply(f), descopeSubject: "U2someoneElse" } as DescopeCutoverCommand, "inconsistent_descope_state", f.userId);
  });

  it("rollback with no descope link ever applied but clerk link missing", async () => {
    if (skip()) return;
    const f = await seedUser();
    await pg().admin.query("UPDATE users SET clerk_user_id = NULL WHERE id = $1", [f.userId]);
    await expectRefused(rollback(f), "no_active_descope_link", f.userId);
  });

  it("a descope subject linked to another user under a DIFFERENT issuer", async () => {
    if (skip()) return;
    const f = await seedUser();
    const other = await seedUser();
    await pg().admin.query(
      `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status, disabled_at)
       VALUES ('descope', 'P2cutoverTest01', $1, $2, 'disabled', now())`,
      [f.descopeSub, other.userId],
    );
    await expectRefused(apply(f), "descope_subject_linked_to_other_user", f.userId);
  });

  it("rollback with no disabled clerk link to restore", async () => {
    if (skip()) return;
    const f = await seedUser();
    await run(apply(f));
    await pg().admin.query(
      "DELETE FROM external_identity_links WHERE user_id = $1 AND provider_key = 'clerk'",
      [f.userId],
    );
    await expectRefused(rollback(f), "no_disabled_clerk_link", f.userId);
  });
});

describe("descope-cutover rollback with older clerk history", () => {
  it("restores the clerk link apply disabled, not an older disabled one", async () => {
    if (skip()) return;
    const f = await seedUser();
    await pg().admin.query(
      `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status, disabled_at)
       VALUES ('clerk', $1, $2, $3, 'disabled', now() - interval '30 days')`,
      [CLERK_ISSUER, `${f.clerkSub}_older`, f.userId],
    );
    const original = await snapshot(f.userId);
    await run(apply(f));
    await run(rollback(f));
    expect(await snapshot(f.userId)).toEqual({
      clerkUserId: f.clerkSub,
      links: [
        ...original.links,
        { provider_key: "descope", issuer: DESCOPE_ISSUER, subject: f.descopeSub, status: "disabled", disabled: true },
      ],
    });
  });
});
