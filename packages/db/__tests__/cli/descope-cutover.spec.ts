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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import {
  CutoverRefusedError,
  DEFAULT_CLERK_ISSUER,
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
  clerkIssuer: CLERK_ISSUER,
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
      clerkLinksCreated: 0,
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

// ---------------------------------------------------------------------------
// RT-791 follow-up: users created after the 0025 backfill (bootstrap-pilot,
// later user creation) have users.clerk_user_id but NO external_identity_links
// row at all (seen on the rt9 lab). apply creates the Clerk link from the bridge
// column — disabled, as the rollback source — in the same transaction.
// ---------------------------------------------------------------------------

describe("descope-cutover apply for a user with no identity links", () => {
  async function seedUnlinkedUser(): Promise<Fixture> {
    const f = await seedUser();
    await pg().admin.query("DELETE FROM external_identity_links WHERE user_id = $1", [f.userId]);
    return f;
  }

  it("creates the disabled clerk link from clerk_user_id, then flips to descope", async () => {
    if (skip()) return;
    const f = await seedUnlinkedUser();
    await expect(run(apply(f))).resolves.toEqual({
      command: "apply",
      dryRun: false,
      alreadyInTargetState: false,
      usersUpdated: 1,
      linksDisabled: 0,
      linksActivated: 1,
      clerkLinksCreated: 1,
    });
    expect(await snapshot(f.userId)).toEqual({
      clerkUserId: f.descopeSub,
      links: [
        { provider_key: "clerk", issuer: CLERK_ISSUER, subject: f.clerkSub, status: "disabled", disabled: true },
        { provider_key: "descope", issuer: DESCOPE_ISSUER, subject: f.descopeSub, status: "active", disabled: false },
      ],
    });
  });

  it("creates the link under the command's clerk issuer (CLERK_JWT_ISSUER at parse time)", async () => {
    if (skip()) return;
    const f = await seedUnlinkedUser();
    await run({ ...apply(f), clerkIssuer: "https://clerk.override.example" } as DescopeCutoverCommand);
    const links = (await snapshot(f.userId)).links;
    expect(links.find((l) => l.provider_key === "clerk")?.issuer).toBe("https://clerk.override.example");
  });

  it("rollback restores clerk_user_id and leaves the created clerk link active", async () => {
    if (skip()) return;
    const f = await seedUnlinkedUser();
    await run(apply(f));
    await expect(run(rollback(f))).resolves.toMatchObject({ usersUpdated: 1, clerkLinksCreated: 0 });
    expect(await snapshot(f.userId)).toEqual({
      clerkUserId: f.clerkSub,
      links: [
        { provider_key: "clerk", issuer: CLERK_ISSUER, subject: f.clerkSub, status: "active", disabled: false },
        { provider_key: "descope", issuer: DESCOPE_ISSUER, subject: f.descopeSub, status: "disabled", disabled: true },
      ],
    });
  });

  it("is idempotent: a re-run after apply creates nothing", async () => {
    if (skip()) return;
    const f = await seedUnlinkedUser();
    await run(apply(f));
    const after = await snapshot(f.userId);
    await expect(run(apply(f))).resolves.toMatchObject({ alreadyInTargetState: true, clerkLinksCreated: 0 });
    expect(await snapshot(f.userId)).toEqual(after);
  });

  it("--dry-run reports the link it would create and writes nothing", async () => {
    if (skip()) return;
    const f = await seedUnlinkedUser();
    const before = await snapshot(f.userId);
    await expect(run(apply(f, true))).resolves.toMatchObject({ dryRun: true, clerkLinksCreated: 1, usersUpdated: 1 });
    expect(await snapshot(f.userId)).toEqual(before);
  });

  it("refuses when clerk_user_id is NULL and there is no link", async () => {
    if (skip()) return;
    const f = await seedUnlinkedUser();
    await pg().admin.query("UPDATE users SET clerk_user_id = NULL WHERE id = $1", [f.userId]);
    const before = await snapshot(f.userId);
    const err = await run(apply(f)).then(() => null, (e: unknown) => e);
    expect((err as CutoverRefusedError).code).toBe("no_matching_active_clerk_link");
    expect(await snapshot(f.userId)).toEqual(before);
  });

  it("refuses when the clerk subject is already linked to another user", async () => {
    if (skip()) return;
    const f = await seedUnlinkedUser();
    const other = await seedUser();
    await pg().admin.query(
      `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status, disabled_at)
       VALUES ('clerk', $1, $2, $3, 'disabled', now())`,
      [CLERK_ISSUER, f.clerkSub, other.userId],
    );
    const before = await snapshot(f.userId);
    const err = await run(apply(f)).then(() => null, (e: unknown) => e);
    expect((err as CutoverRefusedError).code).toBe("clerk_subject_linked_to_other_user");
    expect(await snapshot(f.userId)).toEqual(before);
  });
});

describe("descope-cutover rollback re-checks the clerk subject", () => {
  it("refuses when another user was linked to the clerk subject after apply", async () => {
    if (skip()) return;
    const f = await seedUser();
    const other = await seedUser();
    await run(apply(f));
    await pg().admin.query(
      `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status, disabled_at)
       VALUES ('clerk', 'https://clerk.other.example', $1, $2, 'disabled', now())`,
      [f.clerkSub, other.userId],
    );
    const before = await snapshot(f.userId);
    const err = await run(rollback(f)).then(() => null, (e: unknown) => e);
    expect((err as CutoverRefusedError).code).toBe("clerk_subject_linked_to_other_user");
    expect(await snapshot(f.userId)).toEqual(before);
  });
});

describe("descope-cutover apply still refuses unexpected clerk link states", () => {
  it("no clerk link but another provider's active link → refused with a code, nothing written", async () => {
    if (skip()) return;
    const f = await seedUser();
    await pg().admin.query("DELETE FROM external_identity_links WHERE user_id = $1", [f.userId]);
    await pg().admin.query(
      `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status)
       VALUES ('keycloak', 'https://kc.example', $1, $2, 'active')`,
      [`kc-${f.clerkSub}`, f.userId],
    );
    const before = await snapshot(f.userId);
    const err = await run(apply(f)).then(() => null, (e: unknown) => e);
    expect((err as CutoverRefusedError).code).toBe("unexpected_active_link");
    expect(await snapshot(f.userId)).toEqual(before);
  });

  it("several active clerk links cannot exist (one-active index); an active one under another subject is refused", async () => {
    if (skip()) return;
    const f = await seedUser();
    // The partial unique index forbids a second ACTIVE link per user, so the
    // only reachable "several" state is several clerk rows — covered as
    // disabled-only below; here: an active clerk link under another subject.
    await pg().admin.query("UPDATE external_identity_links SET subject = $1 WHERE user_id = $2", [
      `${f.clerkSub}_other`,
      f.userId,
    ]);
    const err = await run(apply(f)).then(() => null, (e: unknown) => e);
    expect((err as CutoverRefusedError).code).toBe("no_matching_active_clerk_link");
  });

  it("an active clerk link whose subject differs from clerk_user_id", async () => {
    if (skip()) return;
    const f = await seedUser();
    await pg().admin.query("UPDATE users SET clerk_user_id = $1 WHERE id = $2", [`${f.clerkSub}_drift`, f.userId]);
    const err = await run(apply(f)).then(() => null, (e: unknown) => e);
    expect((err as CutoverRefusedError).code).toBe("no_matching_active_clerk_link");
  });

  it("only disabled clerk links (no active one) is not treated as 'no link'", async () => {
    if (skip()) return;
    const f = await seedUser();
    await pg().admin.query(
      "UPDATE external_identity_links SET status = 'disabled', disabled_at = now() WHERE user_id = $1",
      [f.userId],
    );
    const err = await run(apply(f)).then(() => null, (e: unknown) => e);
    expect((err as CutoverRefusedError).code).toBe("no_matching_active_clerk_link");
  });
});

describe("clerk issuer lockstep", () => {
  it("the CLI default equals the 0025 backfill literal", () => {
    const sql = readFileSync(
      resolve(__dirname, "..", "..", "drizzle", "0025_external_identity_links.sql"),
      "utf8",
    );
    expect(sql).toContain(`'${DEFAULT_CLERK_ISSUER}' AS issuer`);
  });

  it("the CLI default equals the API Clerk adapter's DEFAULT_CLERK_ISSUER", () => {
    // packages/db cannot import apps/api, so pin the adapter source text.
    const adapter = readFileSync(
      resolve(__dirname, "..", "..", "..", "..", "apps", "api", "src", "auth", "clerk-identity-provider.adapter.ts"),
      "utf8",
    );
    expect(adapter).toContain(`export const DEFAULT_CLERK_ISSUER = "${DEFAULT_CLERK_ISSUER}";`);
  });
});
