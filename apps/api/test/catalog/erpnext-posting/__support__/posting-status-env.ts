/**
 * A Testcontainers Postgres with every migration and the posting-status
 * fixture (`seedPostingStatusFixture`), started in `beforeAll` and stopped in
 * `afterAll` of the calling spec. Docker policy as posting-ack.spec: a HARD
 * failure unless MIGRATION_TEST_ALLOW_SKIP=1, which skips with a warning.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { seedPostingStatusFixture } from "./seed-posting-status";

export interface PostingStatusEnv {
  /** The started env; throws when Docker was unavailable. */
  readonly env: () => PgTestEnv;
  /** True when Docker was unavailable and the spec is skipping. */
  readonly skipped: () => boolean;
}

/** Register the env's lifecycle hooks; `label` names the spec in the skip warning. */
export function usePostingStatusEnv(label: string): PostingStatusEnv {
  let started: PgTestEnv | null = null;
  let skip = false;

  beforeAll(async () => {
    try {
      started = await startPgEnv();
      await applyAllUpAndCreateAppRole(started);
      await seedPostingStatusFixture(started);
    } catch (err) {
      if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw err;
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[${label}] Docker unavailable: ${String(err)}`);
    }
  }, 180_000);

  afterAll(async () => {
    if (started) await stopPgEnv(started);
  }, 60_000);

  return {
    env: () => {
      if (!started) throw new Error("Docker unavailable");
      return started;
    },
    skipped: () => skip,
  };
}
