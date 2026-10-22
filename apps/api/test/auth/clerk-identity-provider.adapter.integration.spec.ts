/**
 * clerk-identity-provider.adapter.integration.spec.ts — 029 D3 (HIGH-2 review fix).
 *
 * Real Postgres via Testcontainers (full schema incl. 0025). Constructs the REAL
 * `ClerkIdentityProviderAdapter` against the real pool to exercise the actual
 * `linkExternalIdentity` ON CONFLICT semantics — which the docker-free unit spec
 * cannot, because it mocks `query`.
 *
 * The bug this guards (HIGH-2): the ON CONFLICT (provider_key, issuer, subject)
 * DO UPDATE clause updates `email` + `last_verified_at` but historically did NOT
 * touch `status`/`disabled_at`. So re-linking a previously DISABLED subject
 * returned the row id as if success, while the link stayed disabled — a silent
 * semantic failure: the resolver's `WHERE status='active'` join still refuses the
 * user. The fix reactivates the link (`status='active', disabled_at=NULL`) so the
 * method's success return reflects a usable, active link.
 */
import "reflect-metadata";

import { Pool } from "pg";

import { ClerkIdentityProviderAdapter } from "../../src/auth/clerk-identity-provider.adapter";
import type { OperatorTokenVerifier } from "../../src/auth/operator-token-verifier";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const ISSUER = "https://clerk.dp2.local";
const USER_ID = "0e9a0000-0000-7000-8000-00000000ad01";
const SUB = "user_clerk_relink_001";

function fakeVerifier(): OperatorTokenVerifier {
  return { verify: async () => ({ providerKey: "clerk", sub: SUB }) };
}

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let adapter: ClerkIdentityProviderAdapter;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[clerk-identity-provider.adapter.integration.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  await env.admin.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id)
       VALUES ($1, 'relink@id.example', 'Relink', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
  adapter = new ClerkIdentityProviderAdapter(
    fakeVerifier(),
    env.admin as unknown as Pool,
    ISSUER,
  );
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = () => dockerSkipReason && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

describe("ClerkIdentityProviderAdapter.linkExternalIdentity — ON CONFLICT (real DB)", () => {
  beforeEach(async () => {
    if (skip()) return;
    await guard().admin.query(`DELETE FROM external_identity_links`);
  });

  it("inserts a fresh active link and returns its id", async () => {
    if (skip()) return;
    const r = await adapter.linkExternalIdentity({
      providerKey: "clerk",
      issuer: ISSUER,
      subject: SUB,
      userId: USER_ID,
      email: "relink@id.example",
    });
    expect(r.id).toBeTruthy();
    const row = await guard().admin.query<{ status: string; disabled_at: Date | null }>(
      `SELECT status, disabled_at FROM external_identity_links WHERE id = $1`,
      [r.id],
    );
    expect(row.rows[0]?.status).toBe("active");
    expect(row.rows[0]?.disabled_at).toBeNull();
  });

  it("RE-ACTIVATES a previously DISABLED link on re-link (not a dead link)", async () => {
    if (skip()) return;
    // Seed a DISABLED link for this (provider, issuer, subject) directly.
    await guard().admin.query(
      `INSERT INTO external_identity_links
         (provider_key, issuer, subject, user_id, email, status, disabled_at)
       VALUES ('clerk', $1, $2, $3, 'old@id.example', 'disabled', now())`,
      [ISSUER, SUB, USER_ID],
    );

    // Re-link the same subject — the adapter UPSERTs onto the disabled row.
    const r = await adapter.linkExternalIdentity({
      providerKey: "clerk",
      issuer: ISSUER,
      subject: SUB,
      userId: USER_ID,
      email: "new@id.example",
    });

    // The returned id must point at a USABLE (active) link — not a dead one.
    const row = await guard().admin.query<{
      status: string;
      disabled_at: Date | null;
      email: string;
    }>(
      `SELECT status, disabled_at, email FROM external_identity_links WHERE id = $1`,
      [r.id],
    );
    expect(row.rows[0]?.status).toBe("active");
    expect(row.rows[0]?.disabled_at).toBeNull();
    expect(row.rows[0]?.email).toBe("new@id.example");

    // And the resolver's active-link join would now find it (the success the
    // method's return value promised). Single active row, status active.
    const active = await guard().admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM external_identity_links
        WHERE provider_key = 'clerk' AND subject = $1 AND status = 'active'`,
      [SUB],
    );
    expect(active.rows[0]?.n).toBe("1");
  });
});
